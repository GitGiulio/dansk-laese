import test from 'node:test';
import assert from 'node:assert/strict';
import { contextFor, preparationChunks, PreparationClient } from '../static/reader.js';
import {estimatePreparation} from '../static/groq.js';
import {REQUEST_TOKEN_LIMIT} from '../static/budget.js';

const paragraph = text => ({text,words:[...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m,id)=>({id,text:m[0],start:Array.from(text.slice(0,m.index)).length,end:Array.from(text.slice(0,m.index+m[0].length)).length}))});
const p=paragraph('Det er lige meget.');

test('parallel preparation is bounded and reset discards every in-flight result',async()=>{
  const pending=[],seen=[];
  const client=new PreparationClient({configured:true,concurrency:2},async(_url,options)=>{
    const gate=deferred(),body=JSON.parse(options.body);pending.push(gate);seen.push(options);
    await gate.promise;return ok(prepared(body));
  });
  const source=paragraph(Array.from({length:130},(_,i)=>`ord${i}`).join(' '));
  client.prioritize([source],'en');await wait(()=>pending.length===2);
  assert.equal(pending.length,2);client.reset();
  assert.ok(seen.every(options=>options.signal.aborted));
  pending.forEach(gate=>gate.resolve());await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(client.status().ready,0);assert.equal(client.status().running,false);
});

test('manual selection yields every budget-waiting job and parallel preparation resumes completely',async()=>{
  let waiting=true,calls=0;
  const client=new PreparationClient({configured:true,concurrency:2},async(_url,options)=>{
    calls++;const body=JSON.parse(options.body);
    if(waiting){options.onBudgetWait(true);await new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}
    return ok(prepared(body));
  });
  const source=paragraph(Array.from({length:130},(_,i)=>`ord${i}`).join(' '));
  client.prioritize([source],'en');await wait(()=>calls===2);
  client.suspended=true;client.yieldWaiting();await wait(()=>!client.status().running);
  assert.equal(client.queue.length,3);assert.equal(client.status().error,'');
  waiting=false;client.suspended=false;client.pump();await wait(()=>client.status().ready===130);
  for(const word of source.words)assert.deepEqual(client.get(source,word.start,word.end,'en').highlights,[{start:word.start,end:word.end}]);
  client.reset();
});

test('concurrent rate-limit responses preserve the longest cooldown',async()=>{
  const gates=[deferred(),deferred()];let calls=0;
  const client=new PreparationClient({configured:true,concurrency:2},async()=>{
    const index=calls++;await gates[index].promise;
    return Response.json({detail:'Wait for quota.'},{status:429,headers:{'Retry-After':index?'1':'120'}});
  });
  client.prioritize([paragraph(Array.from({length:80},(_,i)=>`ord${i}`).join(' '))],'en');
  await wait(()=>calls===2);gates[0].resolve();await wait(()=>client.status().error);
  const deadline=client.pausedUntil;gates[1].resolve();await wait(()=>!client.status().running);
  assert.ok(client.pausedUntil>=deadline);client.reset();
});
const ok=value=>({ok:true,json:async()=>value,headers:new Headers()});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const wait=async predicate=>{for(let i=0;i<1000;i++){if(predicate())return;await new Promise(r=>setTimeout(r,1));}throw new Error('Timed out waiting for preparation');};
function prepared(payload,label='meaning') {
  const words=paragraph(payload.context).words.filter(w=>w.start>=payload.start && w.end<=payload.end);
  return {entries:words.map(w=>({translation:label,uncertain:false,highlights:[{start:w.start,end:w.end}]})),next_request_ms:0};
}

test('context preserves Unicode occurrence and clips at whole words',()=>{
  const text=paragraph('😀 '+'ord '.repeat(700)+'Åse så en ø.');
  const word=text.words.at(-4),result=contextFor(text,word.start,word.end);
  assert.ok(Array.from(result.context).length<=2000);
  assert.equal(Array.from(result.context).slice(result.start,result.end).join(''),'Åse');
  assert.equal(result.offset+result.start,word.start);
});

test('chunks cover each target once with bounded context and word count',()=>{
  const text=paragraph('ord '.repeat(230));
  const chunks=preparationChunks(text),covered=[];
  for(const chunk of chunks){
    assert.ok(Array.from(chunk.context).length<=2000);
    const selected=text.words.filter(w=>w.start>=chunk.start+chunk.offset && w.end<=chunk.end+chunk.offset);
    assert.ok(selected.length<=48);
    assert.ok(estimatePreparation({...chunk,language:'en'}).totalTokens<=REQUEST_TOKEN_LIMIT);
    covered.push(...selected.map(w=>w.id));
  }
  assert.deepEqual(covered,text.words.map(w=>w.id));
});

test('cache reads never issue requests, even while a hovered word is not ready',async()=>{
  const gate=deferred();let calls=0;
  const client=new PreparationClient({configured:true},async(url,options)=>{calls++;assert.equal(url,'prepare');await gate.promise;return ok(prepared(JSON.parse(options.body)));});
  assert.equal(client.get(p,7,11,'en'),null);assert.equal(calls,0);
  client.prioritize([p],'en');
  for(let i=0;i<10;i++)assert.equal(client.get(p,7,11,'en'),null);
  assert.equal(calls,1);gate.resolve();await wait(()=>client.status().ready===4);
  assert.equal(client.get(p,7,11,'en').translation,'meaning');assert.equal(calls,1);
  client.prioritize([p],'en');assert.equal(calls,1);client.reset();
});

test('prepared idioms support word hover and exact selection, without composing other selections',async()=>{
  let calls=0;
  const client=new PreparationClient({configured:true},async()=>{calls++;return ok({next_request_ms:0,entries:[
    {translation:'that',uncertain:false,highlights:[{start:0,end:3}]},
    {translation:'is',uncertain:false,highlights:[{start:4,end:6}]},
    {translation:"doesn't matter",uncertain:false,highlights:[{start:7,end:11},{start:12,end:17}]},
  ]});});
  client.prioritize([p],'en');await wait(()=>client.status().ready===4);
  assert.equal(client.get(p,7,11,'en').translation,"doesn't matter");
  assert.equal(client.get(p,7,17,'en').translation,"doesn't matter");
  assert.equal(client.get(p,0,17,'en'),null);
  assert.equal(client.availability(p,0,17,'en'),'unsupported');assert.equal(calls,1);client.reset();
});

test('visible page takes priority after the active chunk',async()=>{
  const gate=deferred(),seen=[];
  const client=new PreparationClient({configured:true},async(url,options)=>{const body=JSON.parse(options.body);seen.push(body.context);if(seen.length===1)await gate.promise;return ok(prepared(body));});
  const paragraphs=['første','anden','tredje'].map(paragraph);
  client.prioritize([paragraphs[0]],'en');
  client.enqueue([paragraphs[1]],'en');client.enqueue([paragraphs[2]],'en');
  client.prioritize([paragraphs[2]],'en');gate.resolve();
  await wait(()=>client.status().ready===3);
  assert.deepEqual(seen,['første','tredje','anden']);client.reset();
});

test('short OCR paragraphs share bounded requests while keeping their own occurrence offsets',async()=>{
  const source=Array.from({length:365},(_,i)=>`ord${i}`),paragraphs=[];
  for(let i=0;i<source.length;i+=6)paragraphs.push(paragraph(source.slice(i,i+6).join(' ')));
  const seen=[];
  const client=new PreparationClient({configured:true},async(_url,options)=>{
    const body=JSON.parse(options.body);seen.push(body);return ok(prepared(body));
  });
  client.prioritize(paragraphs,'en');await wait(()=>client.status().ready===365);
  assert.equal(seen.length,8);
  for(const p of paragraphs)for(const word of p.words){
    const entry=client.get(p,word.start,word.end,'en');
    assert.deepEqual(entry.highlights,[{start:word.start,end:word.end}]);
  }
  assert.ok(seen.every(body=>estimatePreparation(body).totalTokens<=REQUEST_TOKEN_LIMIT));
  client.reset();
});

test('batched Unicode paragraphs retain idiom highlights and independent cache entries',async()=>{
  const first=paragraph('Åse så en ø.'),second=paragraph('Det er lige meget.');
  let calls=0;
  const client=new PreparationClient({configured:true},async(_url,options)=>{
    calls++;
    const body=JSON.parse(options.body),tokens=paragraph(body.context).words;
    const result=prepared(body);
    const idiom=tokens.filter(word=>['lige','meget'].includes(word.text));
    result.entries=result.entries.filter(entry=>!idiom.some(word=>word.start===entry.highlights[0].start));
    result.entries.push({translation:"doesn't matter",uncertain:false,highlights:idiom.map(({start,end})=>({start,end}))});
    return ok(result);
  });
  client.prioritize([first,second],'en');await wait(()=>client.status().ready===8);
  assert.equal(client.get(second,7,17,'en').translation,"doesn't matter");
  assert.deepEqual(client.get(second,7,17,'en').highlights,[{start:7,end:11},{start:12,end:17}]);
  assert.equal(client.get(first,0,3,'en').translation,'meaning');client.reset();
  assert.equal(calls,1);
});

test('a failed batch restores every paragraph and retries without partial cache writes',async()=>{
  const sections=[paragraph('Åse læser.'),paragraph('Hun skriver.')];let calls=0;
  const client=new PreparationClient({configured:true},async(_url,options)=>{
    const body=JSON.parse(options.body),result=prepared(body);
    if(++calls===1)result.entries=[{translation:'bad grouping',uncertain:false,highlights:result.entries.flatMap(entry=>entry.highlights)}];
    return ok(result);
  });
  client.prioritize(sections,'en');await wait(()=>client.status().error);
  assert.equal(client.status().ready,0);assert.equal(client.queue.length,2);
  client.retry();await wait(()=>client.status().ready===4);
  assert.equal(calls,2);client.reset();
});

test('scrolling a long paragraph prioritizes the chunk at the visible word',async()=>{
  const gate=deferred(),seen=[];
  const text=paragraph(Array.from({length:230},(_,i)=>`ord${i}`).join(' '));
  const client=new PreparationClient({configured:true},async(_url,options)=>{
    const body=JSON.parse(options.body);
    seen.push(Array.from(body.context).slice(body.start,body.end).join(''));
    if(seen.length===1)await gate.promise;
    return ok(prepared(body));
  });
  client.prioritize([text],'en');
  client.prioritize([text],'en',{paragraph:text,start:text.words[170].start});
  gate.resolve();await wait(()=>seen.length>=2);
  assert.match(seen[1],/ord170/);
  client.reset();
});

test('a token-waiting chunk yields to a newly visible page without pausing reading',async()=>{
  const seen=[];
  const client=new PreparationClient({configured:true},async(_url,options)=>{
    const body=JSON.parse(options.body);seen.push(body.context);
    if(seen.length===1){
      options.onBudgetWait(true);
      await new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
    }
    return ok(prepared(body));
  });
  const pages=['første','anden'].map(paragraph);
  client.prioritize([pages[0]],'en');
  client.prioritize([pages[1]],'en');
  await wait(()=>client.status().ready===2);
  assert.deepEqual(seen,['første','anden','første']);
  assert.equal(client.status().error,'');client.reset();
});

test('language preparation is separate and cached when switching back',async()=>{
  const seen=[];
  const client=new PreparationClient({configured:true},async(url,options)=>{const body=JSON.parse(options.body);seen.push(body.language);return ok(prepared(body,body.language));});
  client.prioritize([p],'en');await wait(()=>client.status().ready===4);
  client.prioritize([p],'it');await wait(()=>client.get(p,7,11,'it'));
  client.prioritize([p],'en');assert.equal(client.get(p,7,11,'en').translation,'en');
  assert.deepEqual(seen,['en','it']);client.reset();
});

test('provider errors pause preparation; hovering cannot retry it',async()=>{
  let calls=0;
  const client=new PreparationClient({configured:true},async(url,options)=>{calls++;return calls===1?{ok:false,status:429,json:async()=>({detail:'Quota exhausted'}),headers:new Headers({'Retry-After':'0.1'})}:ok(prepared(JSON.parse(options.body)));});
  client.prioritize([p],'en');await wait(()=>client.status().error);
  assert.equal(client.get(p,7,11,'en'),null);client.retry();assert.equal(calls,1);
  await new Promise(r=>setTimeout(r,110));client.retry();await wait(()=>client.status().ready===4);
  assert.equal(calls,2);client.reset();
});

test('pacing spaces background requests',async()=>{
  let calls=0;
  const client=new PreparationClient({configured:true},async(url,options)=>{calls++;return ok({...prepared(JSON.parse(options.body)),next_request_ms:35});});
  client.prioritize([paragraph('første')],'en');client.enqueue([paragraph('anden')],'en');await wait(()=>client.status().ready===1);
  assert.equal(calls,1);await wait(()=>client.status().ready===2);client.reset();
});

test('document reset discards late results',async()=>{
  const gate=deferred();
  const client=new PreparationClient({configured:true},async(url,options)=>{await gate.promise;return ok(prepared(JSON.parse(options.body)));});
  client.prioritize([p],'en');client.reset();gate.resolve();
  await new Promise(r=>setTimeout(r,5));assert.equal(client.get(p,7,11,'en'),null);assert.equal(client.status().total,0);
});

test('changing document preserves provider cooldown',async()=>{
  let calls=0;
  const client=new PreparationClient({configured:true},async()=>{calls++;return {ok:false,status:429,json:async()=>({detail:'Quota exhausted'}),headers:new Headers({'Retry-After':'2'})};});
  client.prioritize([p],'en');await wait(()=>client.status().error);
  client.reset();client.prioritize([paragraph('Andet dokument')],'en');
  assert.equal(calls,1);client.reset();
});

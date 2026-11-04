import test from 'node:test';
import assert from 'node:assert/strict';
import { contextFor, preparationChunks, PreparationClient } from '../static/reader.js';

const paragraph = text => ({text,words:[...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m,id)=>({id,text:m[0],start:Array.from(text.slice(0,m.index)).length,end:Array.from(text.slice(0,m.index+m[0].length)).length}))});
const p=paragraph('Det er lige meget.');
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
    assert.ok(selected.length<=60);covered.push(...selected.map(w=>w.id));
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
  client.prioritize(paragraphs,'en');client.prioritize([paragraphs[2]],'en');gate.resolve();
  await wait(()=>client.status().ready===3);
  assert.deepEqual(seen,['første','tredje','anden']);client.reset();
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
  client.prioritize(['første','anden'].map(paragraph),'en');await wait(()=>client.status().ready===1);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import * as groq from '../static/groq.js';
import {createTokenBudget,TOKENS_PER_MINUTE,REQUEST_TOKEN_LIMIT} from '../static/budget.js';

const unpaced={reserve:async tokens=>({tokens}),settle:()=>{}};
const create=(key,fetcher,settings={})=>groq.createGroqPreparer(key,fetcher,{budget:unpaced,...settings});

const payload = {context:'Han tager bogen op.',start:4,end:9,language:'en'};
const options = body => ({body:JSON.stringify(body),signal:new AbortController().signal});
const response = (entries, tokens=100) => Response.json({choices:[{message:{content:JSON.stringify({entries})}}],usage:{total_tokens:tokens}});
const entry = (word_ids=[1,3]) => ({word_ids,translation:'picks up',uncertain:false});

test('request estimates include the full UTF-8 JSON and reserve bounded completion tokens',async()=>{
  let sent;
  const estimate=groq.estimatePreparation(payload);
  const result=await create(()=> 'key',async(_url,init)=>{sent=JSON.parse(init.body);return response([entry()]);})('',options(payload));
  assert.equal(result.status,200);
  assert.ok(estimate.inputTokens>=Math.ceil(new TextEncoder().encode(JSON.stringify(sent)).length/3));
  assert.equal(estimate.maxCompletionTokens,768);
  assert.equal(sent.max_completion_tokens,estimate.maxCompletionTokens);
  assert.equal(estimate.totalTokens,estimate.inputTokens+768);
  assert.ok(estimate.totalTokens<=REQUEST_TOKEN_LIMIT);
  assert.ok(sent.messages[0].content.length<=1100);
  const large={context:'a '.repeat(1000).trim(),start:0,end:119,language:'en'};
  assert.ok(groq.estimatePreparation(large).totalTokens>REQUEST_TOKEN_LIMIT);
  assert.equal((await create(()=> 'key',()=>assert.fail('Oversized request must stay local'))('',options(large))).status,422);
  const chunk={context:'ord '.repeat(48).trim(),start:0,end:191,language:'en'};
  assert.equal(groq.estimatePreparation(chunk).maxCompletionTokens,2432);
  assert.ok(groq.estimatePreparation(chunk).totalTokens<=REQUEST_TOKEN_LIMIT);
});

test('corrective attempts and selections share a rolling gate with conservative failed usage',async()=>{
  let time=0;const times=[],waits=[];
  const budget=createTokenBudget({now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;}});
  await budget.reserve(TOKENS_PER_MINUTE-groq.estimatePreparation(payload).totalTokens);
  let count=0;
  const fetcher=async(_url,init)=>{
    times.push(time);
    const body=JSON.parse(init.body);
    const reserve=Math.ceil(new TextEncoder().encode(init.body).length/3)+48+body.max_completion_tokens;
    assert.ok(reserve<=REQUEST_TOKEN_LIMIT);
    if(count++===0)return Response.json({error:{code:'json_validate_failed'}},{status:400});
    return response([entry([1])],100);
  };
  assert.equal((await create(()=> 'key',fetcher,{budget})('',options(payload))).status,200);
  assert.ok(times[1]>=60000);
  assert.ok(waits.length>0);
  const select=create(()=> 'key',fetcher,{budget,selection:true});
  assert.equal((await select('',options(payload))).status,200);
  assert.equal(times.length,3);
});

test('oversized full selections fail locally with a shorten-selection message',async()=>{
  const prepare=create(()=> 'key',()=>assert.fail('No oversized provider request'),{selection:true});
  const context='a '.repeat(1000).trim();
  const result=await prepare('',options({context,start:0,end:context.length,language:'en'}));
  assert.equal(result.status,422);
  assert.match((await result.json()).detail,/shorten|shorter/i);
});

test('HTTP timeout starts after budget admission and is actionable',async()=>{
  let admitted=false;
  const budget={reserve:async()=>{await new Promise(resolve=>setTimeout(resolve,20));admitted=true;return {};},settle:()=>{}};
  const prepare=create(()=> 'key',async(_url,init)=>{
    assert.equal(admitted,true);
    return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
  },{budget,timeoutMs:5});
  const result=await prepare('',options(payload));
  assert.equal(result.status,504);
  assert.match((await result.json()).detail,/timed out/i);
});

test('Polish is sent as the target for background and full-selection translations',async()=>{
  for(const selection of [false,true]){
    const prepare=create(()=> 'key',async(_url,init)=>{
      assert.equal(JSON.parse(JSON.parse(init.body).messages[1].content).language,'Polish');
      return response([{...entry([1]),translation:'podnosi'}]);
    },{selection});
    const result=await prepare('',options({...payload,language:'pl'}));
    assert.equal(result.status,200);
    assert.equal((await result.json()).entries[0].translation,'podnosi');
  }
});

test('preparer calls Groq directly with memory key and returns separated expression offsets', async () => {
  let call;
  const prepare = create(()=> ' test-key ',async (url,init) => {call={url,init};return response([entry()]);});
  const request = options(payload),result = await prepare('/api/prepare',request);
  assert.equal(result.status,200);
  const {metrics,...meaning}=await result.json();
  assert.deepEqual(meaning, {entries:[{translation:'picks up',uncertain:false,highlights:[{start:4,end:9},{start:16,end:18}]}],next_request_ms:0,model:groq.MODEL,prompt_version:groq.PROMPT_VERSION});
  assert.equal(metrics.requests,1);assert.equal(metrics.total_tokens,100);
  assert.equal(call.url,'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(call.init.headers.Authorization,'Bearer test-key');
  assert.equal(call.init.credentials,'omit');
  assert.equal(call.init.referrerPolicy,'no-referrer');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal(call.init.signal.aborted,false);
  const body=JSON.parse(call.init.body);
  assert.equal(body.model,'openai/gpt-oss-120b');
  assert.equal(body.response_format.json_schema.strict,true);
  assert.deepEqual(JSON.parse(body.messages[1].content).words,[{id:0,text:'Han'},{id:1,text:'tager'},{id:2,text:'bogen'},{id:3,text:'op'}]);
  assert.deepEqual(JSON.parse(body.messages[1].content).target_word_ids,[1]);
});

test('one corrective retry covers all targets and sums actual token use', async () => {
  let calls=0, lastBody;
  const prepare=create(()=> 'key',async (_url,init)=>{lastBody=JSON.parse(init.body);return ++calls===1?response([entry([1])],100):response([entry([1,2,3])],200);});
  const result=await prepare('',options({...payload,end:18}));
  assert.equal(result.status,200);
  assert.equal((await result.json()).next_request_ms,0);
  assert.equal(calls,2);
  assert.match(lastBody.messages.at(-1).content,/every target ID exactly once/);
});

test('provider schema rejection gets one corrective retry without exposing failed_generation',async()=>{
  let calls=0,lastBody;
  const prepare=create(()=> 'key',async(_url,init)=>{
    calls++;lastBody=JSON.parse(init.body);
    if(calls===1)return Response.json({error:{type:'invalid_request_error',code:'json_validate_failed',
      message:'Generated JSON does not match the expected schema.',failed_generation:'PRIVATE DOCUMENT FRAGMENT'}},{status:400});
    return response([entry()],100);
  });
  const result=await prepare('',options(payload));
  assert.equal(result.status,200);assert.equal(calls,2);
  assert.equal((await result.json()).next_request_ms,0);
  assert.match(lastBody.messages.at(-1).content,/nonempty/);
  assert.doesNotMatch(JSON.stringify(lastBody),/PRIVATE DOCUMENT FRAGMENT/);
  const providerSchema=lastBody.response_format.json_schema.schema;
  assert.equal(providerSchema.properties.entries.items.properties.translation.minLength,undefined);
  assert.match(lastBody.messages[0].content,/Never return an empty/);
});

test('persistent schema rejection and blank meanings stop after two attempts',async()=>{
  for(const failure of ['provider','blank']){
    let calls=0;
    const prepare=create(()=> 'key',async()=>{
      calls++;
      return failure==='provider'?Response.json({error:{code:'json_validate_failed',failed_generation:'PRIVATE FRAGMENT'}},{status:400}):response([{...entry(),translation:''}]);
    });
    const result=await prepare('',options(payload));
    assert.equal(result.status,502);assert.equal(calls,2);
    const detail=(await result.json()).detail;
    assert.match(detail,/corrective retry/);assert.doesNotMatch(detail,/PRIVATE FRAGMENT/);
  }
});

test('invalid provider assignments are retried once and then rejected', async () => {
  const invalid=[
    [entry([])], [entry([1,1])], [entry([3,1])], [entry([1,99])],
    [entry([0])], [entry(),entry()], [{...entry(),translation:' '}],
    [{...entry(),uncertain:'false'}], [{...entry(),extra:'ignored'}],
  ];
  for(const entries of invalid){
    let calls=0;
    const prepare=create(()=> 'key',async()=>{calls++;return response(entries);});
    const result=await prepare('',options(payload));
    assert.equal(result.status,502);
    assert.match((await result.json()).detail,/corrective retry/);
    assert.equal(calls,2);
  }
});

test('invalid request boundaries, types and size never leave the browser', async () => {
  const prepare=create(()=> 'key',async()=>assert.fail('No provider request expected'));
  for(const body of [null,{...payload,start:5},{...payload,end:10},{...payload,language:'da'},{...payload,start:'4'},{...payload,context:'x'.repeat(2001)},{context:'a '.repeat(61).trim(),start:0,end:121,language:'en'}]){
    assert.equal((await prepare('',options(body))).status,422);
  }
  const noKey=create(()=> '',async()=>assert.fail('No provider request expected'));
  assert.equal((await noKey('',options(payload))).status,401);
});

test('provider errors have safe messages and preserve rate-limit cooldown', async () => {
  for(const [status,expected] of [[401,401],[403,401],[429,429],[500,503],[400,502]]){
    const prepare=create(()=> 'key',async()=>new Response('secret source text',{status,headers:{'Retry-After':'12.5'}}));
    const result=await prepare('',options(payload));
    assert.equal(result.status,expected);
    assert.doesNotMatch((await result.json()).detail,/secret source text/);
    if(status===429) assert.equal(result.headers.get('Retry-After'),'13');
  }
  const missing=create(()=> 'key',async()=>new Response('',{status:429}));
  assert.equal((await missing('',options(payload))).headers.get('Retry-After'),'60');
});

test('network errors become actionable responses and aborts propagate', async () => {
  const unavailable=create(()=> 'key',async()=>{throw new TypeError('network detail');});
  assert.equal((await unavailable('',options(payload))).status,503);
  const aborted=create(()=> 'key',async()=>{throw new DOMException('aborted','AbortError');});
  await assert.rejects(aborted('',options(payload)),{name:'AbortError'});
});

test('explicit selection translates the complete piece in one entry',async()=>{
  let body;
  const prepare=create(()=> 'key',async(_url,init)=>{
    body=JSON.parse(init.body);return response([entry([1,2,3])]);
  },{selection:true});
  const result=await prepare('',options({...payload,end:18}));
  assert.equal(result.status,200);
  assert.match(body.messages[0].content,/exactly ONE entry/);
  assert.equal((await result.json()).entries.length,1);
  let calls=0;
  const invalid=create(()=> 'key',async()=>{calls++;return response([entry([1]),entry([2,3])]);},{selection:true});
  assert.equal((await invalid('',options({...payload,end:18}))).status,502);
  assert.equal(calls,2);
});

test('small selections reserve expected output rather than the whole request ceiling',async()=>{
  let sent,reserved;
  const prepare=create(()=> 'key',async(_url,init)=>{sent=JSON.parse(init.body);return response([entry([1])]);},{selection:true,budget:{reserve:async tokens=>{reserved=tokens;return {};},settle:()=>{}}});
  const result=await prepare('',options(payload));
  assert.equal(result.status,200);
  assert.equal(sent.max_completion_tokens,1024);
  assert.ok(reserved<REQUEST_TOKEN_LIMIT/2);
  assert.equal((await result.json()).next_request_ms,0);
});

test('metrics aggregate HTTP attempts, token waits and actual usage without source or key data',async()=>{
  let time=0,calls=0;const charged=[];
  const budget={reserve:async()=>{time+=500;return {};},settle:(_record,usage)=>charged.push(usage)};
  const prepare=create(()=> 'PRIVATE_KEY',async()=>{
    const first=++calls===1;time+=first?40:60;
    return Response.json({choices:[{message:{content:JSON.stringify({entries:[entry(first?[1]:[1,2,3])]})}}],usage:{prompt_tokens:first?400:200,completion_tokens:first?200:100,total_tokens:first?600:300,prompt_tokens_details:{cached_tokens:first?300:100}}});
  },{budget,now:()=>time});
  const result=await prepare('',options({...payload,end:18})),body=await result.json();
  assert.equal(result.status,200);assert.equal(body.next_request_ms,0);
  assert.deepEqual(body.metrics,{requests:2,request_ms:100,budget_wait_ms:1000,input_tokens:600,output_tokens:300,total_tokens:900,cached_tokens:400,estimated_tokens:0});
  assert.deepEqual(charged,[300,200]);
  assert.doesNotMatch(JSON.stringify(body.metrics),/PRIVATE_KEY|Han tager/);
});

test('invalid cache usage is never discounted from the shared quota',async()=>{
  for(const cached of [-1,1.5,'100',401,501]){
    let charged;
    const prepare=create(()=> 'key',async()=>Response.json({choices:[{message:{content:JSON.stringify({entries:[entry()]})}}],usage:{prompt_tokens:400,completion_tokens:100,total_tokens:500,prompt_tokens_details:{cached_tokens:cached}}}),{budget:{reserve:async()=>({}),settle:(_record,usage)=>{charged=usage;}}});
    const result=await prepare('',options(payload));
    assert.equal(charged,500);assert.equal((await result.json()).metrics.cached_tokens,0);
  }
});

test('provider failures expose safe timing and conservative estimated cost',async()=>{
  let time=0;
  const prepare=create(()=> 'key',async()=>{time+=25;return Response.json({error:{message:'PRIVATE SOURCE'}},{status:429,headers:{'Retry-After':'12'}});},{now:()=>time,budget:{reserve:async()=>{time+=400;return {};},settle:()=>{}}});
  const result=await prepare('',options(payload)),body=await result.json();
  assert.equal(result.status,429);assert.equal(result.headers.get('Retry-After'),'12');
  assert.equal(body.metrics.requests,1);assert.equal(body.metrics.request_ms,25);assert.equal(body.metrics.budget_wait_ms,400);
  assert.equal(body.metrics.total_tokens,0);assert.equal(body.metrics.estimated_tokens,groq.estimatePreparation(payload).totalTokens);
  assert.doesNotMatch(JSON.stringify(body),/PRIVATE SOURCE/);
});

test('background idioms cannot cross paragraph boundaries but explicit selections can',async()=>{
  const request={context:'lige\n\nmeget',start:0,end:11,language:'en'};
  let calls=0;
  const fetcher=async()=>{calls++;return response([{word_ids:[0,1],translation:"doesn't matter",uncertain:false}]);};
  assert.equal((await create(()=> 'key',fetcher)('',options(request))).status,502);
  assert.equal(calls,2);
  assert.equal((await create(()=> 'key',fetcher,{selection:true})('',options(request))).status,200);
});

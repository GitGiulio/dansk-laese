import test from 'node:test';
import assert from 'node:assert/strict';
import * as groq from '../static/groq.js';

const payload = {context:'Han tager bogen op.',start:4,end:9,language:'en'};
const options = body => ({body:JSON.stringify(body),signal:new AbortController().signal});
const response = (entries, tokens=100) => Response.json({choices:[{message:{content:JSON.stringify({entries})}}],usage:{total_tokens:tokens}});
const entry = (word_ids=[1,3]) => ({word_ids,translation:'picks up',uncertain:false});

test('Polish is sent as the target for background and full-selection translations',async()=>{
  for(const selection of [false,true]){
    const prepare=groq.createGroqPreparer(()=> 'key',async(_url,init)=>{
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
  const prepare = groq.createGroqPreparer(()=> ' test-key ',async (url,init) => {call={url,init};return response([entry()]);});
  const request = options(payload),result = await prepare('/api/prepare',request);
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(), {entries:[{translation:'picks up',uncertain:false,highlights:[{start:4,end:9},{start:16,end:18}]}],next_request_ms:825,model:groq.MODEL,prompt_version:groq.PROMPT_VERSION});
  assert.equal(call.url,'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(call.init.headers.Authorization,'Bearer test-key');
  assert.equal(call.init.credentials,'omit');
  assert.equal(call.init.referrerPolicy,'no-referrer');
  assert.equal(call.init.signal,request.signal);
  const body=JSON.parse(call.init.body);
  assert.equal(body.model,'openai/gpt-oss-120b');
  assert.equal(body.response_format.json_schema.strict,true);
  assert.deepEqual(JSON.parse(body.messages[1].content).words,[{id:0,text:'Han'},{id:1,text:'tager'},{id:2,text:'bogen'},{id:3,text:'op'}]);
  assert.deepEqual(JSON.parse(body.messages[1].content).target_word_ids,[1]);
});

test('one corrective retry covers all targets and sums actual token use', async () => {
  let calls=0, lastBody;
  const prepare=groq.createGroqPreparer(()=> 'key',async (_url,init)=>{lastBody=JSON.parse(init.body);return ++calls===1?response([entry([1])],100):response([entry([1,2,3])],200);});
  const result=await prepare('',options({...payload,end:18}));
  assert.equal(result.status,200);
  assert.equal((await result.json()).next_request_ms,2475);
  assert.equal(calls,2);
  assert.match(lastBody.messages.at(-1).content,/every target ID exactly once/);
});

test('provider schema rejection gets one corrective retry without exposing failed_generation',async()=>{
  let calls=0,lastBody;
  const prepare=groq.createGroqPreparer(()=> 'key',async(_url,init)=>{
    calls++;lastBody=JSON.parse(init.body);
    if(calls===1)return Response.json({error:{type:'invalid_request_error',code:'json_validate_failed',
      message:'Generated JSON does not match the expected schema.',failed_generation:'PRIVATE DOCUMENT FRAGMENT'}},{status:400});
    return response([entry()],100);
  });
  const result=await prepare('',options(payload));
  assert.equal(result.status,200);assert.equal(calls,2);
  assert.equal((await result.json()).next_request_ms,27225);
  assert.match(lastBody.messages.at(-1).content,/nonempty/);
  assert.doesNotMatch(JSON.stringify(lastBody),/PRIVATE DOCUMENT FRAGMENT/);
  const providerSchema=lastBody.response_format.json_schema.schema;
  assert.equal(providerSchema.properties.entries.items.properties.translation.minLength,undefined);
  assert.match(lastBody.messages[0].content,/Never return an empty/);
});

test('persistent schema rejection and blank meanings stop after two attempts',async()=>{
  for(const failure of ['provider','blank']){
    let calls=0;
    const prepare=groq.createGroqPreparer(()=> 'key',async()=>{
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
    const prepare=groq.createGroqPreparer(()=> 'key',async()=>{calls++;return response(entries);});
    const result=await prepare('',options(payload));
    assert.equal(result.status,502);
    assert.match((await result.json()).detail,/corrective retry/);
    assert.equal(calls,2);
  }
});

test('invalid request boundaries, types and size never leave the browser', async () => {
  const prepare=groq.createGroqPreparer(()=> 'key',async()=>assert.fail('No provider request expected'));
  for(const body of [null,{...payload,start:5},{...payload,end:10},{...payload,language:'da'},{...payload,start:'4'},{...payload,context:'x'.repeat(2001)},{context:'a '.repeat(61).trim(),start:0,end:121,language:'en'}]){
    assert.equal((await prepare('',options(body))).status,422);
  }
  const noKey=groq.createGroqPreparer(()=> '',async()=>assert.fail('No provider request expected'));
  assert.equal((await noKey('',options(payload))).status,401);
});

test('provider errors have safe messages and preserve rate-limit cooldown', async () => {
  for(const [status,expected] of [[401,401],[403,401],[429,429],[500,503],[400,502]]){
    const prepare=groq.createGroqPreparer(()=> 'key',async()=>new Response('secret source text',{status,headers:{'Retry-After':'12.5'}}));
    const result=await prepare('',options(payload));
    assert.equal(result.status,expected);
    assert.doesNotMatch((await result.json()).detail,/secret source text/);
    if(status===429) assert.equal(result.headers.get('Retry-After'),'13');
  }
  const missing=groq.createGroqPreparer(()=> 'key',async()=>new Response('',{status:429}));
  assert.equal((await missing('',options(payload))).headers.get('Retry-After'),'60');
});

test('network errors become actionable responses and aborts propagate', async () => {
  const unavailable=groq.createGroqPreparer(()=> 'key',async()=>{throw new TypeError('network detail');});
  assert.equal((await unavailable('',options(payload))).status,503);
  const aborted=groq.createGroqPreparer(()=> 'key',async()=>{throw new DOMException('aborted','AbortError');});
  await assert.rejects(aborted('',options(payload)),{name:'AbortError'});
});

test('explicit selection translates the complete piece in one entry',async()=>{
  let body;
  const prepare=groq.createGroqPreparer(()=> 'key',async(_url,init)=>{
    body=JSON.parse(init.body);return response([entry([1,2,3])]);
  },{selection:true});
  const result=await prepare('',options({...payload,end:18}));
  assert.equal(result.status,200);
  assert.match(body.messages[0].content,/exactly ONE entry/);
  assert.equal((await result.json()).entries.length,1);
  let calls=0;
  const invalid=groq.createGroqPreparer(()=> 'key',async()=>{calls++;return response([entry([1]),entry([2,3])]);},{selection:true});
  assert.equal((await invalid('',options({...payload,end:18}))).status,502);
  assert.equal(calls,2);
});

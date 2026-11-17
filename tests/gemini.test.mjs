import test from 'node:test';
import assert from 'node:assert/strict';
import * as gemini from '../static/gemini.js';

const key='AQ.testing';
const options={body:JSON.stringify({context:'Hej du',start:0,end:6,language:'en'})};
const output=(ids=[0,1])=>Response.json({steps:[{type:'thought',content:[{type:'text',text:'ignored'}]},
  {type:'model_output',content:[{type:'text',text:JSON.stringify({entries:ids.map(id=>({word_ids:[id],translation:'hello',uncertain:false}))})}]}],
  usage:{total_input_tokens:30,total_output_tokens:10,total_cached_tokens:4,total_tokens:45}});
const limited=(error={code:'rate_limit_exceeded'},headers)=>Response.json({error},{status:429,headers});

test('Gemini validates the key with a bodyless authenticated model-list request',async()=>{
  await gemini.checkGeminiKey(key,async(url,request)=>{
    assert.equal(new URL(url).pathname,'/v1beta/models');
    assert.equal(new Headers(request.headers).get('x-goog-api-key'),key);
    assert.equal(request.referrerPolicy,'strict-origin-when-cross-origin');
    assert.equal(request.body,undefined);
    return Response.json({models:[]});
  });
  await assert.rejects(gemini.checkGeminiKey(key,async()=>Response.json({}, {status:403})),/Gemini.*key/i);
  await assert.rejects(gemini.checkGeminiKey(key,async()=>Response.json({error:{status:'FAILED_PRECONDITION'}},{status:400})),/billing/i);
});

test('Gemini shares structured validation and maps usage after one corrective retry',async()=>{
  const bodies=[],headers=[];
  const pool=gemini.createGeminiPool(key,async(_url,request)=>{
    assert.equal(request.referrerPolicy,'strict-origin-when-cross-origin');
    bodies.push(JSON.parse(request.body));
    headers.push(new Headers(request.headers));
    return bodies.length===1?output([0]):output();
  });
  const data=await (await pool.prepare('prepare',options)).json();
  assert.equal(bodies.length,2);
  assert.equal(headers[0].has('api-revision'),false);
  assert.equal(bodies[0].store,false);
  assert.equal(bodies[0].response_format.mime_type,'application/json');
  assert.match(bodies[1].system_instruction,/cover every target ID exactly once/i);
  assert.equal(bodies[0].model,'gemini-3.1-flash-lite');
  assert.equal(data.model,'gemini-3.1-flash-lite');
  assert.deepEqual(data.entries.map(item=>item.highlights[0]),[{start:0,end:3},{start:4,end:6}]);
  assert.equal(data.metrics.requests,2);
  assert.equal(data.metrics.total_tokens,90);
  assert.equal(data.metrics.cached_tokens,8);
});

test('an incomplete Gemini response gets one retry with more output headroom',async()=>{
  const limits=[];
  const pool=gemini.createGeminiPool(key,async(_url,request)=>{
    limits.push(JSON.parse(request.body).generation_config.max_output_tokens);
    if(limits.length===1)return Response.json({status:'incomplete',steps:[]});
    return output();
  });
  assert.equal((await pool.prepare('prepare',options)).status,200);
  assert.equal(limits.length,2);
  assert.ok(limits[1]>limits[0]);
});

test('Gemini server errors show the model and actual HTTP status without exposing the raw response',async()=>{
  const model=gemini.GEMINI_MODELS[0];
  for(const [response,expected] of [
    [Response.json({error:{code:'service_unavailable',message:`Provider echoed ${key} and Hej du`}}, {status:503}),`${model} · HTTP 503 · service_unavailable`],
    [Response.json({error:{code:504,status:'DEADLINE_EXCEEDED'}}, {status:504}),`${model} · HTTP 504 · deadline_exceeded`],
    [Response.json({error:{code:'untrusted_error_code'}}, {status:500}),`${model} · HTTP 500`],
    [new Response('<h1>Upstream failed</h1>', {status:502}),`${model} · HTTP 502`],
  ]){
    const pool=gemini.createGeminiPool(key,async()=>response);
    const result=await (await pool.prepare('prepare',options)).json();
    assert.ok(result.detail.includes(`(${expected})`),result.detail);
    assert.doesNotMatch(result.detail,/AQ\.testing|Hej du|untrusted_error_code|Upstream failed/);
  }
});

test('fallback shares per-model cooldown across selection, new pools and retried requests',async()=>{
  let time=Date.parse('2026-11-17T12:00:00Z'),first=true;
  const models=[],cooldowns=new Map();
  const fetcher=async(_url,request)=>{
    assert.equal(new Headers(request.headers).get('x-goog-api-key'),key);
    models.push(JSON.parse(request.body).model);
    if(first){
      first=false;
      return limited({status:'RESOURCE_EXHAUSTED',message:'You exceeded your current quota. Please check your plan and billing details.',
        details:[{violations:[{quotaId:'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',quotaDimensions:{model:models[0]}}]}]},
      {'Retry-After':'7'});
    }
    return output([0]);
  };
  const config={cooldowns,now:()=>time};
  const short={body:JSON.stringify({context:'Hej',start:0,end:3,language:'en'})};
  const [top,fallback]=gemini.GEMINI_MODELS;
  const pool=gemini.createGeminiPool(key,fetcher,config);
  assert.equal((await pool.prepare('prepare',short)).status,200);
  assert.equal((await gemini.createGeminiPool(key,fetcher,config).selection('selection',short)).status,200);
  time+=7000;
  assert.equal((await pool.prepare('prepare',short)).status,200);
  assert.deepEqual(models,[top,fallback,fallback,top]);
});

test('exhausted daily quotas return a shared retry deadline at midnight Pacific',async()=>{
  let calls=0;
  const pool=gemini.createGeminiPool(key,async()=>{calls++;return limited({code:'quota_exceeded'});},
    {now:()=>Date.parse('2026-11-01T06:30:00Z')});
  for(const operation of ['prepare','selection']){
    const response=await pool[operation](operation,options);
    assert.equal(response.status,429);
    assert.equal(response.headers.get('Retry-After'),'1800');
    assert.match((await response.json()).detail,/retry/i);
  }
  assert.equal(calls,gemini.GEMINI_MODELS.length);
});

test('billing, project-wide limits, and cancellation stop further Gemini attempts',async()=>{
  for(const [response,status,message] of [[Response.json({}, {status:402}),402,/billing/i],
    [Response.json({error:{code:'failed_precondition'}}, {status:400}),402,/billing/i],
    [limited({code:'rate_limit_exceeded',message:'Project spend cap exceeded'}),402,/billing/i],
    [limited({code:'rate_limit_exceeded',message:'Project-wide rate limit reached'}),429,/project/i],
    [limited({status:'RESOURCE_EXHAUSTED',details:[{violations:[{quotaId:'GenerateRequestsPerDayPerProject-FreeTier',quotaDimensions:{location:'global'}}]}]}),429,/project/i]]){
    let calls=0;
    const pool=gemini.createGeminiPool(key,async()=>{calls++;return response.clone();});
    const result=await pool.prepare('prepare',options);
    assert.equal(result.status,status);
    assert.match((await result.json()).detail,message);
    assert.equal(calls,1);
  }
  const controller=new AbortController();
  let calls=0;
  const pool=gemini.createGeminiPool(key,async()=>{calls++;controller.abort();return limited();});
  await assert.rejects(pool.prepare('prepare',{...options,signal:controller.signal}),{name:'AbortError'});
  assert.equal(calls,1);
});

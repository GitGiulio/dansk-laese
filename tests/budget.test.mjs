import test from 'node:test';
import assert from 'node:assert/strict';
import {createTokenBudget,TOKENS_PER_MINUTE,REQUEST_TOKEN_LIMIT} from '../static/budget.js';
const fraction=share=>Math.round(share*TOKENS_PER_MINUTE);

const clock=()=>{let time=0;const waits=[];return {now:()=>time,waits,sleep:async(ms,signal)=>{signal?.throwIfAborted();waits.push(ms);time+=ms;},advance:ms=>{time+=ms;}};};

test('rolling reservations stay within the TPM limit and actual usage releases only unused capacity',async()=>{
  const timer=clock(),budget=createTokenBudget(timer);
  const first=await budget.reserve(fraction(.65));
  budget.settle(first,fraction(.05));
  await budget.reserve(REQUEST_TOKEN_LIMIT);
  assert.deepEqual(timer.waits,[]);
  await budget.reserve(fraction(.1));
  assert.deepEqual(timer.waits,[60000]);
});

test('unknown usage and sent cancellation keep conservative reservations',async()=>{
  const timer=clock(),budget=createTokenBudget(timer);
  const sent=await budget.reserve(fraction(.75));
  budget.settle(sent,undefined);
  await budget.reserve(fraction(.5));
  assert.deepEqual(timer.waits,[60000]);
  await assert.rejects(budget.reserve(TOKENS_PER_MINUTE+1),/budget/i);
});

test('provider remaining tokens and reset duration further restrict reservations',async()=>{
  const timer=clock(),budget=createTokenBudget(timer);
  const sent=await budget.reserve(1000);
  budget.settle(sent,100,new Headers({'x-ratelimit-remaining-tokens':'20','x-ratelimit-reset-tokens':'1m2s'}));
  await budget.reserve(300);
  assert.deepEqual(timer.waits,[62000]);
});

test('429 Retry-After pauses all subsequent requests',async()=>{
  const timer=clock(),budget=createTokenBudget(timer);
  const sent=await budget.reserve(1000);
  budget.settle(sent,undefined,new Headers({'Retry-After':'70'}),429);
  await budget.reserve(100);
  assert.deepEqual(timer.waits,[70000]);
});

test('aborting a token wait does not reserve unsent tokens',async()=>{
  let waiting;
  const budget=createTokenBudget({now:()=>0,sleep:(_ms,signal)=>new Promise((resolve,reject)=>{
    waiting=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  })});
  const first=await budget.reserve(REQUEST_TOKEN_LIMIT),controller=new AbortController();
  const pending=budget.reserve(fraction(.25),controller.signal);
  assert.equal(typeof waiting,'function');
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  budget.settle(first,fraction(.05));
  await budget.reserve(REQUEST_TOKEN_LIMIT);
});

test('fully cached input can settle to zero charge without an extra cooldown',async()=>{
  const timer=clock(),budget=createTokenBudget(timer);
  const cached=await budget.reserve(REQUEST_TOKEN_LIMIT);
  budget.settle(cached,0);
  await budget.reserve(REQUEST_TOKEN_LIMIT);
  assert.deepEqual(timer.waits,[]);
});

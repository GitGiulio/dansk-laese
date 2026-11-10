import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConnection,createGroqPool} from '../static/keys.js';

test('key lists validate, deduplicate and preserve legacy vault preference fields',()=>{
  assert.deepEqual(normalizeConnection(' gsk_one '),{keys:['gsk_one'],independent:false});
  assert.deepEqual(normalizeConnection({keys:['gsk_one','gsk_one','gsk_two'],independent:true}),{keys:['gsk_one','gsk_two'],independent:true});
  for(const input of [{keys:[]},{keys:['bad key']},{keys:['x'],independent:'yes'},{keys:Array(9).fill('x')}])assert.throws(()=>normalizeConnection(input));
});

test('transport rotates keys and preserves separate budgets regardless of legacy quota preference',async()=>{
  const used=[],reservations=[],budgets=new Map();
  const budgetFactory=()=>{const id=reservations.length;reservations.push([]);return {reserve:async tokens=>{reservations[id].push(tokens);return {};},settle(){}};};
  const fetcher=async(_url,options)=>{
    used.push(options.headers.Authorization);
    return Response.json({choices:[{message:{content:JSON.stringify({entries:[{word_ids:[0],translation:'hello',uncertain:false}]})}}],usage:{total_tokens:20}});
  };
  const options={body:JSON.stringify({context:'Hej',start:0,end:3,language:'en'})};
  const pool=await createGroqPool({keys:['gsk_one','gsk_two'],independent:false},fetcher,{budgets,budgetFactory});
  await pool.prepare('prepare',options);await pool.prepare('prepare',options);
  assert.deepEqual(used,['Bearer gsk_one','Bearer gsk_two']);assert.equal(reservations.length,2);
  assert.equal(reservations[0].length,1);assert.equal(reservations[1].length,1);
  const separate=await createGroqPool({keys:['gsk_one','gsk_two'],independent:true},fetcher,{budgets,budgetFactory});
  await Promise.all([separate.prepare('prepare',options),separate.prepare('prepare',options)]);
  assert.equal(reservations.length,2);
  const again=await createGroqPool({keys:['gsk_two','gsk_one'],independent:true},fetcher,{budgets,budgetFactory});
  await again.selection('selection',options);assert.equal(reservations.length,2);
  assert.ok([...budgets.keys()].every(key=>!key.includes('gsk_')));
});

test('all eight keys can prepare concurrently with separate quotas',async()=>{
  const {PreparationClient}=await import('../static/reader.js');
  const {importText}=await import('../static/documents.js');
  const active=new Set(),releases=[];
  const pool=await createGroqPool({keys:Array.from({length:8},(_,i)=>`gsk_key${i}`),independent:false},async(_url,options)=>{
    active.add(options.headers.Authorization);
    await new Promise(resolve=>releases.push(resolve));
    return Response.json({error:{message:'test complete'}},{status:500});
  });
  assert.equal(pool.concurrency,8);
  const client=new PreparationClient({configured:true,concurrency:pool.concurrency},pool.prepare);
  client.prioritize(importText(Array.from({length:400},(_,i)=>`ord${i}`).join(' ')).paragraphs,'en');
  try{
    for(let i=0;i<100 && active.size<8;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(active.size,8);
  }finally{client.reset();releases.forEach(release=>release());}
});

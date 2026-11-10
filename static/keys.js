import {createGroqPreparer} from './groq.js';
import {createTokenBudget} from './budget.js';

export function normalizeConnection(value) {
  if(typeof value==='string')value={keys:[value],independent:false};
  if(!value || !Array.isArray(value.keys) || !value.keys.length || value.keys.length>8
    || (value.independent!==undefined && typeof value.independent!=='boolean'))throw new Error('Enter between 1 and 8 Groq API keys.');
  const keys=value.keys.map(key=>{
    if(typeof key!=='string' || !key.trim() || key.trim().length>512 || /\s/.test(key.trim()))throw new Error('Enter valid Groq API keys.');
    return key.trim();
  });
  return {keys:[...new Set(keys)],independent:value.independent===true};
}

export async function createGroqPool(connection,fetcher=globalThis.fetch.bind(globalThis),{budgets=new Map(),budgetFactory=createTokenBudget}={}) {
  connection=normalizeConnection(connection);
  let cursor=0;
  const lanes=await Promise.all(connection.keys.map(async key=>{
    const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(!budgets.has(fingerprint))budgets.set(fingerprint,budgetFactory());
    const budget=budgets.get(fingerprint);
    return {busy:0,prepare:createGroqPreparer(()=>key,fetcher,{budget}),selection:createGroqPreparer(()=>key,fetcher,{budget,selection:true})};
  }));
  const dispatch=kind=>async(operation,options)=>{
    const ordered=lanes.slice(cursor).concat(lanes.slice(0,cursor));
    const lane=ordered.reduce((best,lane)=>lane.busy<best.busy?lane:best);
    cursor=(lanes.indexOf(lane)+1)%lanes.length;lane.busy++;
    try{return await lane[kind](operation,options);}finally{lane.busy--;}
  };
  return {concurrency:lanes.length,prepare:dispatch('prepare'),selection:dispatch('selection')};
}

import {createGroqPreparer,MODEL} from './groq.js';
import {createGeminiPool} from './gemini.js';
import {createTokenBudget} from './budget.js';

export function keyProvider(key) {
  if(key.startsWith('gsk_'))return 'groq';
  if(key.startsWith('AQ.') || key.startsWith('AIza'))return 'gemini';
  return null;
}

export function normalizeConnection(value,{requireProvider=false}={}) {
  if(typeof value==='string')value={keys:[value],independent:false};
  if(!value || !Array.isArray(value.keys) || !value.keys.length || value.keys.length>8
    || (value.independent!==undefined && typeof value.independent!=='boolean'))throw new Error('Enter between 1 and 8 API keys.');
  if(value.providers!==undefined && (!Array.isArray(value.providers) || value.providers.length!==value.keys.length))throw new Error('Choose a valid API key provider.');
  const unique=new Map();
  value.keys.forEach((input,index)=>{
    if(typeof input!=='string' || !input.trim() || input.trim().length>512 || /\s/.test(input.trim()))throw new Error('Enter valid API keys.');
    const key=input.trim(),detected=keyProvider(key),choice=value.providers?.[index] ?? null;
    if(choice!==null && !['groq','gemini'].includes(choice))throw new Error('Choose a valid API key provider.');
    const override=detected?null:choice;
    if(requireProvider && !detected && !override)throw new Error(`Choose a provider for API key ${index+1}.`);
    if(unique.has(key) && unique.get(key)!==override)throw new Error('Choose the same provider for duplicate API keys.');
    unique.set(key,override);
  });
  const keys=[...unique.keys()],providers=[...unique.values()];
  if(keys.filter((key,index)=>(keyProvider(key) || providers[index])==='gemini').length>1)throw new Error('Enter only one Gemini API key.');
  return {keys,independent:value.independent===true,...(providers.some(Boolean)?{providers}:{})};
}

export function connectionKeys(connection,provider) {
  return connection.keys.filter((key,index)=>(keyProvider(key) || connection.providers?.[index] || 'groq')===provider);
}

async function keyFingerprint(key) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
  return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}

export async function createTranslationPool(connection,fetcher=globalThis.fetch.bind(globalThis),{provider,budgets,geminiCooldowns=new Map()}={}) {
  connection=normalizeConnection(connection);
  const [gemini]=connectionKeys(connection,'gemini'),groq=connectionKeys(connection,'groq');
  if(gemini && (provider!=='groq' || !groq.length)){
    const fingerprint=await keyFingerprint(gemini);
    if(!geminiCooldowns.has(fingerprint))geminiCooldowns.set(fingerprint,new Map());
    return createGeminiPool(gemini,fetcher,{cooldowns:geminiCooldowns.get(fingerprint)});
  }
  return {...await createGroqPool({keys:groq},fetcher,{budgets}),provider:'groq',model:MODEL};
}

export async function createGroqPool(connection,fetcher=globalThis.fetch.bind(globalThis),{budgets=new Map(),budgetFactory=createTokenBudget}={}) {
  connection=normalizeConnection(connection);
  let cursor=0;
  const lanes=await Promise.all(connection.keys.map(async key=>{
    const fingerprint=await keyFingerprint(key);
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

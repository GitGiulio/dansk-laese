import {PROMPT_VERSION,SCHEMA,validateRequest,validateAnswer,sourceParagraphs,translationMessages,correctionFor,outputTokenLimit,translationMetrics} from './translation.js';

const API='https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_MODELS=Object.freeze(['gemini-3.1-flash-lite','gemini-4-hydrogen','gemini-3.8-flash']);
const pacific=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',hourCycle:'h23'});
const requestOptions={credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'strict-origin-when-cross-origin'};
const encoder=new TextEncoder();
const billingMessage='Gemini billing or project setup needs attention. Check Google AI Studio.';

function billingError(status,error) {
  return status===402 || /failed_precondition|payment_required/i.test(`${error?.code} ${error?.status}`)
    || (status===429 && /\b(?:spend(?:ing)?[ _-]+cap|prepa(?:y|id)[ _-]+(?:funds|balance)|billing[ _-]+(?:disabled|inactive|suspended)|insufficient[ _-]+(?:credits|funds))\b/i.test(error?.message || ''));
}

export async function checkGeminiKey(key,fetcher=globalThis.fetch.bind(globalThis)) {
  let response;
  try {
    response=await fetcher(`${API}/models?pageSize=1`,{...requestOptions,headers:{'x-goog-api-key':key},signal:AbortSignal.timeout(15000)});
  } catch {
    throw new Error('Cannot reach Gemini to check your API key. Try again.');
  }
  if(response.ok)return;
  const data=await response.json().catch(()=>null);
  if(billingError(response.status,data?.error))throw new Error(billingMessage);
  if(response.status===429 || response.status>=500)throw new Error('Gemini could not check your API key right now. Try again.');
  throw new Error('Gemini rejected the API key. Check the key in Google AI Studio.');
}

function nextPacificMidnight(time) {
  const parts=Object.fromEntries(pacific.formatToParts(time).map(({type,value})=>[type,Number(value)]));
  const candidate=Date.UTC(parts.year,parts.month-1,parts.day+1,7);
  // Pacific midnight is 07:00 UTC during daylight saving time and 08:00 UTC otherwise.
  return pacific.formatToParts(candidate).find(part=>part.type==='hour').value==='00'?candidate:candidate+3600000;
}

function rateLimit(response,error={},time) {
  const details=Array.isArray(error.details)?error.details:[];
  const violations=details.flatMap(detail=>Array.isArray(detail?.violations)?detail.violations:[]);
  const reason=`${error.code || ''} ${error.message || ''} ${JSON.stringify(details)}`;
  const project=/spend(?:ing)?[-_\s]+(?:based[-_\s]+)?(?:rate[-_\s]+)?limit|project[-_\s]+(?:wide|level)/i.test(reason)
    || violations.some(violation=>/per[-_\s]*project/i.test(violation?.quotaId) && !/per[-_\s]*model/i.test(violation.quotaId) && !violation.quotaDimensions?.model);
  const daily=/quota_exceeded|per[-_\s]*day|daily/i.test(reason);
  const header=response.headers.get('Retry-After');
  const retryInfo=details.find(detail=>typeof detail?.retryDelay==='string')?.retryDelay;
  const seconds=header?.trim() && Number.isFinite(Number(header))?Number(header):null;
  const retryAt=seconds!==null?time+seconds*1000:Date.parse(header);
  const retryDelay=/^(\d+(?:\.\d+)?)s$/.exec(retryInfo)?.[1];
  const provided=Number.isFinite(retryAt)?retryAt:retryDelay!==undefined?time+Number(retryDelay)*1000:0;
  return {project,until:Math.max(time+1000,provided || (daily?0:time+60000),daily?nextPacificMidnight(time):0)};
}

function responseText(decoded) {
  return decoded.steps.filter(step=>step.type==='model_output').flatMap(step=>step.content)
    .filter(part=>part?.type==='text').map(part=>part.text).join('');
}

function recordUsage(metrics,usage,estimatedTokens) {
  const count=value=>Number.isSafeInteger(value) && value>=0?value:0;
  metrics.input_tokens+=count(usage?.total_input_tokens);
  metrics.output_tokens+=count(usage?.total_output_tokens);
  metrics.total_tokens+=count(usage?.total_tokens);
  metrics.cached_tokens+=count(usage?.total_cached_tokens);
  if(!count(usage?.total_tokens))metrics.estimated_tokens+=estimatedTokens;
}

export function createGeminiPool(key,fetcher=globalThis.fetch.bind(globalThis),{cooldowns=new Map(),now=Date.now,timeoutMs=20000}={}) {
  const dispatch=selection=>async(_operation,options={})=>{
    const metrics=translationMetrics();
    const failure=(detail,status,headers)=>Response.json({detail,metrics},{status,headers});
    const unavailable=(until,project=false)=>{
      const seconds=Math.max(1,Math.ceil((until-now())/1000));
      const deadline=new Date(until).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
      return failure(`Gemini ${project?'project usage limit reached':'models are at their usage limits'}. Retry after ${deadline}.`,429,{'Retry-After':String(seconds)});
    };
    options.signal?.throwIfAborted();
    let request,tokens,target;
    try {
      request=JSON.parse(options.body);
      ({tokens,target}=validateRequest(request,selection));
    } catch(error){return failure(error instanceof SyntaxError?'Invalid preparation request.':error.message,422);}
    const paragraphs=sourceParagraphs(request.context,tokens);
    const [system,input]=translationMessages(request,selection,tokens,target);
    let maxOutputTokens=Math.max(4096,outputTokenLimit(selection,target.size));
    let corrected=false;
    const projectUntil=cooldowns.get('project') || 0;
    if(projectUntil>now())return unavailable(projectUntil,true);
    for(const model of GEMINI_MODELS){
      if((cooldowns.get(model) || 0)>now())continue;
      for(;;){
        options.signal?.throwIfAborted();
        const body=JSON.stringify({model,store:false,input:input.content,
          system_instruction:corrected?`${system.content}\n${correctionFor(selection)}`:system.content,
          generation_config:{thinking_level:'low',max_output_tokens:maxOutputTokens},
          response_format:{type:'text',mime_type:'application/json',schema:SCHEMA}});
        const estimatedTokens=Math.ceil(encoder.encode(body).length/3)+maxOutputTokens;
        const timeout=AbortSignal.timeout(timeoutMs);
        const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
        let response,decoded;
        const started=now();metrics.requests++;
        try {
          // Use the default API revision for browser CORS.
          response=await fetcher(`${API}/interactions`,{...requestOptions,method:'POST',signal,body,
            headers:{'x-goog-api-key':key,'Content-Type':'application/json'}});
          decoded=await response.json().catch(()=>null);
          signal.throwIfAborted();
        } catch {
          options.signal?.throwIfAborted();
          recordUsage(metrics,undefined,estimatedTokens);
          return timeout.aborted?failure('Gemini request timed out. Retry to continue.',504):failure('Cannot reach Gemini. Check your internet connection and try again.',503);
        } finally {metrics.request_ms+=Math.max(0,now()-started);}
        recordUsage(metrics,decoded?.usage,estimatedTokens);
        if(billingError(response.status,decoded?.error))return failure(billingMessage,402);
        if(response.status===429){
          const {project,until}=rateLimit(response,decoded?.error || {},now());
          cooldowns.set(project?'project':model,until);
          if(project)return unavailable(until,true);
          break;
        }
        if([401,403].includes(response.status) || /api_key_invalid|authentication/i.test(decoded?.error?.code || ''))return failure('Gemini rejected the API key or model access. Check Google AI Studio.',401);
        if(response.status>=500){
          const code=[decoded?.error?.code,decoded?.error?.status]
            .map(value=>typeof value==='string'?value.toLowerCase():'')
            .find(value=>/^(api_error|internal|internal_server_error|bad_gateway|unavailable|service_unavailable|deadline_exceeded|gateway_timeout|unimplemented|unknown|data_loss)$/.test(value));
          const details=[model,`HTTP ${response.status}`,code].filter(Boolean).join(' · ');
          return failure(`Gemini returned a server error (${details}). Try again.`,503);
        }
        if(!response.ok)return failure('Gemini could not accept this request. Check model and account access.',502);
        try {
          if(decoded?.status==='incomplete'){
            // Gemini counts thinking against its output cap. Give a truncated response more room on the single retry.
            maxOutputTokens=Math.min(65536,Math.max(16384,maxOutputTokens*2));
            throw new Error('Incomplete Gemini response');
          }
          const entries=validateAnswer(JSON.parse(responseText(decoded)),tokens,target,selection,paragraphs);
          return Response.json({entries,next_request_ms:0,model,prompt_version:PROMPT_VERSION,metrics});
        } catch {
          if(corrected)return failure('Gemini did not return complete contextual meanings after one corrective retry. Retry to continue.',502);
          corrected=true;
        }
      }
    }
    return unavailable(Math.min(...GEMINI_MODELS.map(model=>cooldowns.get(model))));
  };
  return {provider:'gemini',model:`gemini:${GEMINI_MODELS.join(',')}`,concurrency:1,prepare:dispatch(false),selection:dispatch(true)};
}

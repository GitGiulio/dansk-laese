import {words} from './documents.js';
import {REQUEST_TOKEN_LIMIT,sharedTokenBudget} from './budget.js';
import {PROMPT_VERSION,SCHEMA,validateRequest,validateAnswer,sourceParagraphs,translationMessages,correctionFor,outputTokenLimit,translationMetrics} from './translation.js';
export {PROMPT_VERSION};

export const MODEL = 'openai/gpt-oss-120b';
function cooldown(header) {
  if (header === null || header.trim() === '') return 60;
  const numeric = Number(header);
  if (Number.isFinite(numeric)) return Math.max(1, Math.ceil(numeric));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date-Date.now())/1000)) : 60;
}

const encoder=new TextEncoder();
const inputTokens=body=>Math.ceil(encoder.encode(JSON.stringify(body)).length/3)+48;

function completionBody(request,selection,messages) {
  const tokens=words(request.context),target=tokens.filter(word=>word.start>=request.start && word.end<=request.end).map(word=>word.id);
  const body={model:MODEL,messages:messages || translationMessages(request,selection,tokens,target),
    temperature:0,reasoning_effort:'low',max_completion_tokens:outputTokenLimit(selection,target.length),
    response_format:{type:'json_schema',json_schema:{name:'contextual_translation',strict:true,schema:SCHEMA}}};
  if(selection){
    for(let i=0;i<3;i++)body.max_completion_tokens=Math.min(body.max_completion_tokens,Math.max(0,REQUEST_TOKEN_LIMIT-inputTokens(body)));
  }
  return body;
}

export function estimatePreparation(request) {
  const body=completionBody(request,false);
  const input=inputTokens(body);
  return {inputTokens:input,maxCompletionTokens:body.max_completion_tokens,totalTokens:input+body.max_completion_tokens};
}

function tokenUsage(usage) {
  const valid=value=>Number.isSafeInteger(value) && value>=0;
  const total=valid(usage?.total_tokens) && usage.total_tokens>0?usage.total_tokens:undefined;
  const input=valid(usage?.prompt_tokens) && (!total || usage.prompt_tokens<=total)?usage.prompt_tokens:0;
  const output=valid(usage?.completion_tokens) && (!total || usage.completion_tokens<=total)?usage.completion_tokens:0;
  const cached=usage?.prompt_tokens_details?.cached_tokens;
  return {total,input,output,cached:total && valid(cached) && cached<=input && cached<=total?cached:0};
}

export function createGroqPreparer(getApiKey, fetcher = globalThis.fetch.bind(globalThis),{selection=false,budget=sharedTokenBudget,timeoutMs=15000,now=Date.now}={}) {
  return async function (_logicalOperation, options = {}) {
    const metrics=translationMetrics();
    const failure=(detail,status,headers={})=>Response.json({detail,metrics},{status,headers});
    let request, tokens, target;
    try {
      request = JSON.parse(options.body);
      ({tokens, target} = validateRequest(request,selection));
    } catch (error) {
      return failure(error instanceof SyntaxError ? 'Invalid preparation request.' : error.message, 422);
    }
    const key = getApiKey()?.trim();
    if (!key) return failure('Enter your Groq API key to prepare contextual meanings.', 401);
    const paragraphIds=sourceParagraphs(request.context,tokens);
    let body=completionBody(request,selection);
    const messages=body.messages;
    for (let attempt = 0; attempt < 2; attempt++) {
      if(attempt)body=completionBody(request,selection,messages);
      let input=inputTokens(body);
      if(attempt && !selection && input+body.max_completion_tokens>REQUEST_TOKEN_LIMIT){
        body.max_completion_tokens=Math.max(0,REQUEST_TOKEN_LIMIT-input);
        input=inputTokens(body);
      }
      const estimated=input+body.max_completion_tokens;
      if(estimated>REQUEST_TOKEN_LIMIT || body.max_completion_tokens<(selection?256:768))return failure(selection?'This selection exceeds the token budget. Shorten the selection and try again.':'This preparation chunk exceeds the token budget. Use a shorter context or fewer target words.',422);
      const waitingAt=now();
      const reservation=await budget.reserve(estimated,options.signal,options.onBudgetWait);
      metrics.budget_wait_ms+=Math.max(0,now()-waitingAt);
      options.signal?.throwIfAborted();
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(new DOMException('Groq request timed out','TimeoutError')),timeoutMs);
      const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
      const started=now();metrics.requests++;
      let settled=false;
      const finish=(decoded,response)=>{
        if(settled)return;
        settled=true;
        const usage=tokenUsage(decoded?.usage);
        metrics.request_ms+=Math.max(0,now()-started);
        metrics.input_tokens+=usage.input;metrics.output_tokens+=usage.output;
        metrics.total_tokens+=usage.total || 0;metrics.cached_tokens+=usage.cached;
        if(usage.total===undefined)metrics.estimated_tokens+=estimated;
        budget.settle(reservation,usage.total===undefined?undefined:usage.total-usage.cached,response?.headers,response?.status);
      };
      try {
        const response = await fetcher('https://api.groq.com/openai/v1/chat/completions', {
          method:'POST', headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json'},
          credentials:'omit', referrerPolicy:'no-referrer', signal,body:JSON.stringify(body),
        });
        let decoded;
        try{decoded=await response.json();}
        catch(error){if(signal.aborted)throw error;}
        finish(decoded,response);
        if(!response.ok){
          if([401,403].includes(response.status))return failure('Groq rejected the API key. Check your key and model access.',401);
          if(response.status===429)return failure("Groq's usage limit was reached. Wait before trying again.",429,{'Retry-After':String(cooldown(response.headers.get('Retry-After')))});
          if(response.status>=500)return failure('Groq is temporarily unavailable. Please try again later.',503);
          if(response.status!==400 || decoded?.error?.code!=='json_validate_failed')return failure('Groq could not accept this request. Check model and account access.',502);
        }else{
          try{
            const answer=JSON.parse(decoded.choices[0].message.content);
            const entries=validateAnswer(answer,tokens,target,selection,paragraphIds);
            return Response.json({entries,next_request_ms:0,model:MODEL,prompt_version:PROMPT_VERSION,metrics});
          }catch(error){if(signal.aborted)throw error;}
        }
      }catch(error){
        finish();
        if(options.signal?.aborted)throw options.signal.reason;
        if(controller.signal.aborted)return failure('Groq request timed out after 15 seconds. Retry preparation to continue.',504);
        if(error.name==='AbortError')throw error;
        return failure('Cannot reach Groq. Check your internet connection and retry preparation.',503);
      }finally{clearTimeout(timeout);}
      if(attempt===0)messages.push({role:'user',content:correctionFor(selection)});
    }
    return failure('Groq did not return complete contextual meanings after one corrective retry. Retry preparation to continue.', 502);
  };
}

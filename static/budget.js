export const TOKENS_PER_MINUTE = 8000;
export const REQUEST_TOKEN_LIMIT = 7200;

function sleep(ms,signal) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
    const timer=setTimeout(finish,ms);
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    signal?.addEventListener('abort',abort,{once:true});
  });
}

function resetDelay(value,now) {
  if(value===null || value.trim()==='')return 60000;
  if(Number.isFinite(Number(value)))return Math.max(0,Number(value)*1000);
  const parts=[...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if(parts.length && parts.map(match=>match[0]).join('')===value.trim())return parts.reduce((sum,[,amount,unit])=>sum+Number(amount)*{ms:1,s:1000,m:60000,h:3600000}[unit],0);
  const date=Date.parse(value);
  return Number.isFinite(date)?Math.max(0,date-now):60000;
}

export function createTokenBudget({now=Date.now,sleep:wait=sleep}={}) {
  let reservations=[],remaining=null,resetAt=0,blockedUntil=0;
  return {
    async reserve(tokens,signal,onWait=()=>{}) {
      if(!Number.isSafeInteger(tokens) || tokens<=0 || tokens>TOKENS_PER_MINUTE)throw new Error(`Request exceeds the ${TOKENS_PER_MINUTE}-token budget.`);
      let waiting=false;
      try {
        while(true){
          signal?.throwIfAborted();
          const time=now();
          reservations=reservations.filter(record=>record.at+60000>time);
          if(time>=resetAt)remaining=null;
          let until=Math.max(time,blockedUntil);
          if(remaining!==null && tokens>remaining)until=Math.max(until,resetAt);
          let total=reservations.reduce((sum,record)=>sum+record.tokens,0);
          for(const record of [...reservations].sort((a,b)=>a.at-b.at)){
            if(total+tokens<=TOKENS_PER_MINUTE)break;
            until=Math.max(until,record.at+60000);total-=record.tokens;
          }
          if(until<=time){
            const record={at:time,tokens};reservations.push(record);
            if(remaining!==null)remaining=Math.max(0,remaining-tokens);
            return record;
          }
          if(!waiting){waiting=true;onWait(true);}
          await wait(until-time,signal);
        }
      }finally{if(waiting)onWait(false);}
    },
    settle(record,usage,headers,status=200) {
      if(Number.isSafeInteger(usage) && usage>=0)record.tokens=usage;
      // Keep sent work charged for a full minute after its response, including failures.
      record.at=now();
      if(!headers)return;
      const exposed=headers.get('x-ratelimit-remaining-tokens');
      if(exposed!==null && exposed.trim()!=='' && Number.isFinite(Number(exposed)) && Number(exposed)>=0){
        remaining=Number(exposed);resetAt=now()+resetDelay(headers.get('x-ratelimit-reset-tokens'),now());
      }
      if(status===429)blockedUntil=Math.max(blockedUntil,now()+Math.max(1000,resetDelay(headers.get('Retry-After'),now())));
    },
  };
}

export const sharedTokenBudget=createTokenBudget();

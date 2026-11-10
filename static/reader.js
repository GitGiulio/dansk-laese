import {estimatePreparation} from './groq.js';
import {REQUEST_TOKEN_LIMIT} from './budget.js';

function lowerBound(words,position,field) {
  let left=0,right=words.length;
  while(left<right){const middle=(left+right)>>>1;if(words[middle][field]<position)left=middle+1;else right=middle;}
  return left;
}

export function contextFor(paragraph, start, end, limit=2000, chars=Array.from(paragraph.text)) {
  if(end-start>limit)throw new Error('Select a shorter phrase, up to 2,000 characters.');
  let left=0,right=chars.length;
  if(chars.length>limit){
    const ideal=Math.max(0,Math.min(start-Math.floor((limit-(end-start))/2),chars.length-limit));
    left=paragraph.words[lowerBound(paragraph.words,ideal,'start')]?.start ?? start;
    right=Math.min(chars.length,left+limit);
    right=paragraph.words[lowerBound(paragraph.words,right+1,'end')-1]?.end ?? end;
  }
  return {context:chars.slice(left,right).join(''),start:start-left,end:end-left,offset:left};
}

export function preparationChunks(paragraph) {
  const chunks=[],words=paragraph.words,chars=Array.from(paragraph.text);
  for(let first=0;first<words.length;){
    let end=Math.min(first+48,words.length),chunk;
    for(;;){
      const span=words[end-1].end-words[first].start;
      if(span>1800 && end>first+1){end--;continue;}
      if(span>2000)throw new Error('A word is too long for the context limit. Edit or shorten this text.');
      let limit=Math.min(2000,Math.max(800,span));
      chunk=contextFor(paragraph,words[first].start,words[end-1].end,limit,chars);
      while(limit>Math.max(200,span) && estimatePreparation({...chunk,language:'en'}).totalTokens>REQUEST_TOKEN_LIMIT){
        limit=Math.max(200,span,limit-100);
        chunk=contextFor(paragraph,words[first].start,words[end-1].end,limit,chars);
      }
      if(estimatePreparation({...chunk,language:'en'}).totalTokens<=REQUEST_TOKEN_LIMIT)break;
      if(end>first+1){end--;continue;}
      chunk=contextFor(paragraph,words[first].start,words[first].end,Math.max(150,span),chars);
      if(estimatePreparation({...chunk,language:'en'}).totalTokens>REQUEST_TOKEN_LIMIT)throw new Error('A word is too long for the token budget. Edit or shorten this text.');
      break;
    }
    chunks.push(chunk);
    first=end;
  }
  return chunks;
}

export class PreparationClient {
  constructor(config,fetcher=globalThis.fetch.bind(globalThis),onChange=()=>{}) {
    this.config=config;this.fetcher=fetcher;this.onChange=onChange;
    this.records=new Map();this.queue=[];this.active=null;this.timer=null;
    this.language='en';this.epoch=0;this.nextAt=0;this.pausedUntil=0;this.error='';
    this.discovering=false;
    this.metrics={requests:0,request_ms:0,budget_wait_ms:0,input_tokens:0,output_tokens:0,total_tokens:0,cached_tokens:0,estimated_tokens:0};
  }

  key(paragraph,language) {return JSON.stringify([this.config.model,this.config.prompt_version,language,paragraph.text]);}

  reset() {
    this.epoch++;clearTimeout(this.timer);this.timer=null;
    this.active?.controller?.abort();this.active=null;
    this.records.clear();this.queue=[];this.error='';this.discovering=false;
    for(const key of Object.keys(this.metrics))this.metrics[key]=0;
    this.nextAt=Math.max(this.nextAt,this.pausedUntil);
    // Provider pacing survives document changes so replacing text cannot bypass it.
    this.onChange();
  }

  enqueue(paragraphs,language,priority=false,focus=null) {
    const keys=new Set(),group={};
    if(priority)this.language=language;
    try {
      for(const paragraph of paragraphs){
        const key=this.key(paragraph,language);keys.add(key);
        if(this.records.has(key))continue;
        const record={paragraph,language,group,byWord:new Map(),exact:new Map()};
        this.records.set(key,record);
        for(const chunk of preparationChunks(paragraph))this.queue.push({record,key,chunk,language});
      }
    } catch(error) {this.error=error.message;}
    if(priority){
      const order=new Map([...keys].map((key,index)=>[key,index]));
      const focusKey=focus?this.key(focus.paragraph,language):null;
      const rank=job=>{
        let group=order.get(job.key) ?? order.size+1;
        const start=job.chunk.start+job.chunk.offset,end=job.chunk.end+job.chunk.offset;
        if(job.key===focusKey){
          if(end<=focus.start)group=order.size;
          else if(start<=focus.start)return -1;
        }
        return group*1000000+start;
      };
      this.orderCompare=(a,b)=>rank(a)-rank(b);
      this.queue.sort(this.orderCompare);
      if(this.active?.waiting && (this.active.language!==language || (this.queue[0] && this.orderCompare(this.queue[0],this.active)<0))){
        this.active.reprioritized=true;this.active.controller.abort();
      }
    }
    this.onChange();this.pump();
  }

  prioritize(paragraphs,language,focus=null) {this.enqueue(paragraphs,language,true,focus);}

  get(paragraph,start,end,language) {
    const record=this.records.get(this.key(paragraph,language));
    if(!record)return null;
    const selected=paragraph.words.filter(w=>w.start>=start && w.end<=end);
    if(selected.length===1)return record.byWord.get(selected[0].start) ?? null;
    return record.exact.get(selected.map(w=>w.start).join(',')) ?? null;
  }

  availability(paragraph,start,end,language) {
    const record=this.records.get(this.key(paragraph,language));
    const selected=paragraph.words.filter(w=>w.start>=start && w.end<=end);
    return record && selected.every(w=>record.byWord.has(w.start))?'unsupported':'pending';
  }

  status() {
    const records=[...this.records.values()].filter(r=>r.language===this.language);
    return {ready:records.reduce((sum,r)=>sum+r.byWord.size,0),
      total:records.reduce((sum,r)=>sum+r.paragraph.words.length,0),
      error:this.error,running:!!this.active,waiting:!!this.active?.waiting,discovering:this.discovering,metrics:{...this.metrics}};
  }

  retry() {
    if(Date.now()<this.pausedUntil){this.error=`Wait ${Math.ceil((this.pausedUntil-Date.now())/1000)} seconds before retrying preparation.`;this.onChange();return;}
    this.error='';this.onChange();this.pump();
  }

  batch(first) {
    const complete=job=>job.chunk.offset===0 && job.chunk.context===job.record.paragraph.text
      && job.chunk.start===job.record.paragraph.words[0]?.start && job.chunk.end===job.record.paragraph.words.at(-1)?.end;
    const parts=[{job:first,start:0,end:Array.from(first.chunk.context).length,offset:first.chunk.offset}];
    let chunk=first.chunk,count=first.record.paragraph.words.length;
    if(complete(first)){
      for(;;){
        const index=this.queue.findIndex(job=>job.language===first.language),next=this.queue[index];
        if(!next || next.record.group!==first.record.group || !complete(next) || count+next.record.paragraph.words.length>48)break;
        const base=Array.from(chunk.context).length+2,context=chunk.context+'\n\n'+next.chunk.context;
        const candidate={context,start:chunk.start,end:base+next.chunk.end,offset:0};
        if(Array.from(context).length>2000 || estimatePreparation({...candidate,language:first.language}).totalTokens>REQUEST_TOKEN_LIMIT)break;
        this.queue.splice(index,1);parts.push({job:next,start:base,end:base+Array.from(next.chunk.context).length,offset:-base});
        count+=next.record.paragraph.words.length;chunk=candidate;
      }
    }
    return {parts,chunk};
  }

  store(batch,entries) {
    const mapped=entries.map(item=>{
      const part=batch.parts.find(part=>item.highlights.every(h=>h.start>=part.start && h.end<=part.end));
      if(!part)throw new Error('Translation combined unrelated paragraphs. Retry preparation.');
      const entry={...item,highlights:item.highlights.map(h=>({start:h.start+part.offset,end:h.end+part.offset}))};
      return {record:part.job.record,entry};
    });
    for(const {record,entry} of mapped){
      const starts=entry.highlights.map(h=>h.start);
      record.exact.set(starts.join(','),entry);
      for(const start of starts){
        const previous=record.byWord.get(start);
        if(!previous || previous.highlights.length<entry.highlights.length)record.byWord.set(start,entry);
      }
    }
  }

  async pump() {
    if(this.active || this.timer || this.error || this.suspended)return;
    const index=this.queue.findIndex(job=>job.language===this.language);
    if(index<0)return;
    if(!this.config.configured){this.error='Enter your Groq API key to prepare meanings.';this.onChange();return;}
    if(Date.now()<this.nextAt){
      this.timer=setTimeout(()=>{this.timer=null;this.pump();},this.nextAt-Date.now());
      return;
    }
    const job=this.queue.splice(index,1)[0],epoch=this.epoch,started=Date.now();
    const batch=this.batch(job);
    this.active=job;job.controller=new AbortController();this.onChange();
    try {
      const {offset,...payload}=batch.chunk;
      const response=await this.fetcher('prepare',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...payload,language:job.language}),signal:job.controller.signal,
        onBudgetWait:waiting=>{job.waiting=waiting;this.onChange();}});
      const result=await response.json();
      if(epoch!==this.epoch)return;
      for(const key of Object.keys(this.metrics)){
        const value=result.metrics?.[key];if(Number.isFinite(value) && value>=0)this.metrics[key]+=value;
      }
      if(!response.ok){
        if(response.status===429)this.pausedUntil=Date.now()+(Number(response.headers.get('Retry-After'))||60)*1000;
        throw new Error(typeof result.detail==='string'?result.detail:'Preparation failed. Retry to continue.');
      }
      if(!Array.isArray(result.entries))throw new Error('Preparation returned incomplete data. Retry to continue.');
      this.store(batch,result.entries);
      const delay=Number(result.next_request_ms);
      this.nextAt=Math.max(this.nextAt,started+(Number.isFinite(delay)&&delay>=0?delay:0));
    } catch(error) {
      if(epoch!==this.epoch)return;
      if(job.reprioritized){
        job.reprioritized=false;this.queue.push(...batch.parts.map(part=>part.job));this.queue.sort(this.orderCompare);
      }else{
        this.queue.unshift(...batch.parts.map(part=>part.job));
        this.error=['AbortError','TimeoutError'].includes(error.name)?'Preparation timed out. Retry to continue.':error.message;
      }
    } finally {
      if(this.active===job)this.active=null;
      if(epoch===this.epoch){this.onChange();this.pump();}
    }
  }
}

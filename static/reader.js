export function contextFor(paragraph, start, end) {
  const chars=Array.from(paragraph.text),limit=2000;
  if(end-start>limit)throw new Error('Select a shorter phrase, up to 2,000 characters.');
  let left=0,right=chars.length;
  if(chars.length>limit){
    const ideal=Math.max(0,Math.min(start-Math.floor((limit-(end-start))/2),chars.length-limit));
    left=paragraph.words.find(w=>w.start>=ideal && w.start<=start)?.start ?? start;
    right=Math.min(chars.length,left+limit);
    right=paragraph.words.filter(w=>w.end<=right && w.end>=end).at(-1)?.end ?? end;
  }
  return {context:chars.slice(left,right).join(''),start:start-left,end:end-left,offset:left};
}

export function preparationChunks(paragraph) {
  const chunks=[],words=paragraph.words;
  for(let first=0;first<words.length;){
    let end=Math.min(first+60,words.length);
    while(end>first+1 && words[end-1].end-words[first].start>900)end--;
    chunks.push(contextFor(paragraph,words[first].start,words[end-1].end));
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
  }

  key(paragraph,language) {return JSON.stringify([this.config.model,this.config.prompt_version,language,paragraph.text]);}

  reset() {
    this.epoch++;clearTimeout(this.timer);this.timer=null;
    this.active?.controller?.abort();this.active=null;
    this.records.clear();this.queue=[];this.error='';this.discovering=false;
    this.nextAt=Math.max(this.nextAt,this.pausedUntil);
    // Provider pacing survives document changes so replacing text cannot bypass it.
    this.onChange();
  }

  enqueue(paragraphs,language,priority=false) {
    const keys=new Set();
    if(priority)this.language=language;
    try {
      for(const paragraph of paragraphs){
        const key=this.key(paragraph,language);keys.add(key);
        if(this.records.has(key))continue;
        const record={paragraph,language,byWord:new Map(),exact:new Map()};
        this.records.set(key,record);
        for(const chunk of preparationChunks(paragraph))this.queue.push({record,key,chunk,language});
      }
    } catch(error) {this.error=error.message;}
    if(priority)this.queue.sort((a,b)=>Number(keys.has(b.key))-Number(keys.has(a.key)));
    this.onChange();this.pump();
  }

  prioritize(paragraphs,language) {this.enqueue(paragraphs,language,true);}

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
      error:this.error,running:!!this.active,discovering:this.discovering};
  }

  retry() {
    if(Date.now()<this.pausedUntil){this.error=`Wait ${Math.ceil((this.pausedUntil-Date.now())/1000)} seconds before retrying preparation.`;this.onChange();return;}
    this.error='';this.onChange();this.pump();
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
    this.active=job;job.controller=new AbortController();this.onChange();
    const timeout=setTimeout(()=>job.controller.abort(),15000);
    try {
      const {offset,...payload}=job.chunk;
      const response=await this.fetcher('prepare',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...payload,language:job.language}),signal:job.controller.signal});
      const result=await response.json();
      if(epoch!==this.epoch)return;
      if(!response.ok){
        if(response.status===429)this.pausedUntil=Date.now()+(Number(response.headers.get('Retry-After'))||60)*1000;
        throw new Error(typeof result.detail==='string'?result.detail:'Preparation failed. Retry to continue.');
      }
      if(!Array.isArray(result.entries))throw new Error('Preparation returned incomplete data. Retry to continue.');
      for(const item of result.entries){
        const entry={...item,highlights:item.highlights.map(h=>({start:h.start+offset,end:h.end+offset}))};
        const starts=entry.highlights.map(h=>h.start);
        job.record.exact.set(starts.join(','),entry);
        for(const start of starts){
          const previous=job.record.byWord.get(start);
          if(!previous || previous.highlights.length<entry.highlights.length)job.record.byWord.set(start,entry);
        }
      }
      const delay=Number(result.next_request_ms);
      this.nextAt=Math.max(this.nextAt,started+(Number.isFinite(delay)&&delay>=0?delay:24000));
    } catch(error) {
      if(epoch!==this.epoch)return;
      this.queue.unshift(job);
      this.error=error.name==='AbortError'?'Preparation timed out. Retry to continue.':error.message;
    } finally {
      clearTimeout(timeout);
      if(this.active===job)this.active=null;
      if(epoch===this.epoch){this.onChange();this.pump();}
    }
  }
}

const MAX_PIXELS=6000000,MAX_EDGE=4096;
const normal=text=>String(text || '').normalize('NFC').replace(/\u00ad/g,'').replace(/\s+/g,' ').trim();
const closed=()=>new Error('OCR was cancelled because the document closed.');

function recognitionCanvas(canvas) {
  if(!Number.isFinite(canvas?.width) || !Number.isFinite(canvas?.height) || canvas.width<=0 || canvas.height<=0)throw new Error('This page has no usable image for recognition.');
  const scale=Math.min(1,MAX_EDGE/canvas.width,MAX_EDGE/canvas.height,Math.sqrt(MAX_PIXELS/(canvas.width*canvas.height)));
  if(scale===1)return canvas;
  const resized=document.createElement('canvas');
  resized.width=Math.max(1,Math.floor(canvas.width*scale));resized.height=Math.max(1,Math.floor(canvas.height*scale));
  const context=resized.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,resized.width,resized.height);
  context.drawImage(canvas,0,0,resized.width,resized.height);
  return resized;
}

async function mapRecognition(raw,width,height,importText) {
  const paragraphs=[];
  for(const block of raw.blocks || []){
    for(const paragraph of block.paragraphs || (block.lines?[block]:[])){
      let text='';const runs=[];
      for(const line of paragraph.lines || []){
        const chunks=(line.words || []).map(word=>({...word,text:normal(word.text)})).filter(word=>word.text);
        if(!chunks.length)continue;
        if(text)text+='\n';
        for(const [index,word] of chunks.entries()){
          if(index)text+=' ';
          const start=Array.from(text).length;text+=word.text;
          runs.push({start,end:Array.from(text).length,bbox:word.bbox});
        }
      }
      if(text)paragraphs.push({text,runs});
    }
  }
  const text=paragraphs.map(paragraph=>paragraph.text).join('\n\n');
  if(!text){
    const fallback=typeof raw.text==='string'?raw.text.trim():'';
    if(fallback){const data=await importText(fallback);data.warnings.push('Word positions were unavailable. Use text view to read or recognize the page again.');return {data,tokens:[],width,height};}
    return {data:{text:'',paragraphs:[],warnings:['No readable text was found. Try a clearer image or recognize the page again.']},tokens:[],width,height};
  }
  const data=await importText(text),tokens=[];
  for(const paragraph of data.paragraphs){
    const runs=paragraphs[paragraph.id]?.runs || [];
    for(const word of paragraph.words){
      const run=runs.find(run=>word.start>=run.start && word.end<=run.end),box=run?.bbox;
      if(!box || !['x0','y0','x1','y1'].every(key=>Number.isFinite(box[key])))continue;
      const bbox={x0:Math.max(0,box.x0),y0:Math.max(0,box.y0),x1:Math.min(width,box.x1),y1:Math.min(height,box.y1)};
      if(bbox.x1<=bbox.x0 || bbox.y1<=bbox.y0)continue;
      tokens.push({paragraph:paragraph.id,start:word.start,end:word.end,text:word.text,bbox});
    }
  }
  return {data,tokens,width,height};
}

export class OcrEngine {
  constructor(onProgress=()=>{},{createWorker,timeoutMs=90000}={}) {
    this.onProgress=onProgress;this.createWorker=createWorker;this.timeoutMs=timeoutMs;
    this.worker=null;this.startingWorker=null;this.workerPromise=null;this.queue=Promise.resolve();this.destroyed=false;this.generation=0;this.cancel=null;this.fail=null;
  }

  async getWorker() {
    if(this.destroyed)throw closed();
    if(!this.workerPromise){
      const generation=this.generation;
      this.workerPromise=(async()=>{
        this.onProgress('Loading Danish recognition...');
        const create=this.createWorker || (await import('./vendor/tesseract/tesseract.esm.min.js')).default.createWorker;
        if(this.destroyed || generation!==this.generation)throw closed();
        const options={
          workerPath:new URL('./vendor/tesseract/worker.min.js',import.meta.url).href,
          corePath:new URL('./vendor/tesseract/core/',import.meta.url).href,
          langPath:new URL('./vendor/tesseract/lang/',import.meta.url).href,
          cacheMethod:'none',workerBlobURL:false,gzip:true,
          errorHandler:()=>{if(!this.destroyed && generation===this.generation)this.fail?.();},
          logger:message=>{
            if(this.destroyed || generation!==this.generation)return;
            this.onProgress(message.status==='recognizing text'?`Recognizing Danish text ${Math.round((message.progress || 0)*100)}%`:'Loading Danish recognition...');
          },
        };
        // ponytail: pinned v7 creates Worker synchronously. Capture only that call;
        // remove this adapter when upstream exposes cancellation during initialization.
        const NativeWorker=globalThis.Worker,engine=this;
        function CaptureWorker(url,settings){
          const native=new NativeWorker(url,settings);
          if(String(url)===options.workerPath)engine.startingWorker=native;
          return native;
        }
        if(NativeWorker){CaptureWorker.prototype=NativeWorker.prototype;globalThis.Worker=CaptureWorker;}
        let pending;
        try{pending=create('dan',1,options);}
        finally{if(NativeWorker)globalThis.Worker=NativeWorker;}
        const worker=await pending;
        if(this.destroyed || generation!==this.generation){await worker.terminate();throw closed();}
        this.startingWorker=null;
        this.worker=worker;
        // The worker's single-block default joins unrelated columns into each line.
        await worker.setParameters({tessedit_pageseg_mode:'3'});
        return worker;
      })();
    }
    return this.workerPromise;
  }

  recognize(canvas,importText) {
    const pending=this.queue.then(()=>this.run(canvas,importText));
    this.queue=pending.catch(()=>{});return pending;
  }

  async run(canvas,importText) {
    if(this.destroyed)throw closed();
    let source,timer,timedOut=false;
    const cancelled=new Promise((_resolve,reject)=>{
      this.cancel=()=>reject(closed());
      this.fail=()=>reject(new Error('OCR worker failed.'));
      timer=setTimeout(()=>{timedOut=true;reject(new Error('OCR timed out. Try a smaller or clearer page and recognize again.'));},this.timeoutMs);
    });
    try{
      source=recognitionCanvas(canvas);
      return await Promise.race([cancelled,(async()=>{
        const worker=await this.getWorker();
        if(this.destroyed)throw closed();
        this.onProgress('Recognizing Danish text...');
        const answer=await worker.recognize(source,{}, {text:true,blocks:true});
        if(this.destroyed)throw closed();
        const result=await mapRecognition(answer.data,source.width,source.height,importText);
        if(this.destroyed)throw closed();
        return result;
      })()]);
    }catch(error){
      await this.stopWorker();
      if(this.destroyed)throw closed();
      if(timedOut)throw new Error('OCR timed out. Try a smaller or clearer page and recognize again.');
      throw new Error('Could not recognize this page. Try a clearer image or recognize the page again.');
    }finally{
      clearTimeout(timer);this.cancel=null;this.fail=null;
      if(source && source!==canvas){source.width=0;source.height=0;}
      if(!this.destroyed)this.onProgress('');
    }
  }

  async stopWorker() {
    this.generation++;
    this.startingWorker?.terminate();this.startingWorker=null;
    const worker=this.worker;this.worker=null;this.workerPromise=null;
    if(worker)await Promise.resolve(worker.terminate()).catch(()=>{});
  }

  async destroy() {
    if(this.destroyed)return;
    this.destroyed=true;this.cancel?.();this.onProgress('');
    await this.stopWorker();
  }
}

export function renderOcrLayer(result,displayWidth,displayHeight) {
  const layer=document.createElement('div');layer.className='ocrLayer';
  Object.assign(layer.style,{position:'absolute',inset:'0',color:'transparent',userSelect:'text'});
  const positions=new Map();
  for(const token of result.tokens){
    if(!positions.has(token.paragraph))positions.set(token.paragraph,[]);
    positions.get(token.paragraph).push(token);
  }
  for(const [index,paragraph] of result.data.paragraphs.entries()){
    if(index)layer.append(document.createTextNode('\n\n'));
    let cursor=0;const chars=Array.from(paragraph.text);
    for(const token of positions.get(paragraph.id) || []){
      layer.append(document.createTextNode(chars.slice(cursor,token.start).join('')));
      const span=document.createElement('span'),box=token.bbox;
      span.className='word';span.textContent=token.text;
      Object.assign(span.dataset,{paragraph:token.paragraph,start:token.start,end:token.end});
      Object.assign(span.style,{position:'absolute',left:`${box.x0/result.width*100}%`,top:`${box.y0/result.height*100}%`,
        width:`${(box.x1-box.x0)/result.width*100}%`,height:`${(box.y1-box.y0)/result.height*100}%`,
        fontSize:`${Math.max(1,(box.y1-box.y0)/result.height*displayHeight)}px`,lineHeight:'1',whiteSpace:'pre',color:'transparent'});
      layer.append(span);cursor=token.end;
    }
    layer.append(document.createTextNode(chars.slice(cursor).join('')));
  }
  return layer;
}

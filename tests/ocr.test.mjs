import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {OcrEngine,renderOcrLayer} from '../static/ocr.js';
import {importText} from '../static/documents.js';

const bbox=(x0,y0,x1,y1)=>({x0,y0,x1,y1});
const raw={blocks:[{paragraphs:[
  {lines:[{words:[{text:'😀',bbox:bbox(0,0,10,10)},{text:'A\u030ase',bbox:bbox(12,0,40,10)}]},{words:[{text:'ser',bbox:bbox(0,12,20,22)},{text:'øer.',bbox:bbox(25,12,50,22)}]}]},
  {lines:[{words:[{text:'blå\u00adgrønne',bbox:bbox(0,40,70,50)}]}]},
]}]};
const canvas={width:100,height:60};

test('OCR enables automatic page layout before recognizing multi-column documents',async()=>{
  const calls=[];
  const engine=new OcrEngine(()=>{},{createWorker:async()=>({
    setParameters:async parameters=>calls.push(parameters),
    recognize:async()=>{calls.push('recognize');return {data:raw};},terminate:async()=>{},
  })});
  try{
    await engine.recognize(canvas,importText);
    assert.deepEqual(calls,[{tessedit_pageseg_mode:'3'},'recognize']);
  }finally{await engine.destroy();}
});

test('bundled OCR files retain verified published hashes and Danish-only language data',async()=>{
  const base=new URL('../static/vendor/tesseract/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('integrity.json',base),'utf8'));
  for(const archive of manifest){
    assert.match(archive.integrity,/^sha512-/);
    assert.match(archive.tarball,/^https:\/\/registry.npmjs.org\//);
    for(const [file,expected] of Object.entries(archive.files)){
      const data=await readFile(new URL(file,base));
      assert.equal(data.length,expected.bytes);
      assert.equal(createHash('sha256').update(data).digest('hex'),expected.sha256);
    }
  }
  assert.equal(manifest[2].package,'@tesseract.js-data/dan');
});

test('the pinned ESM default API reaches native worker creation',async()=>{
  const originalWorker=globalThis.Worker,originalWindow=globalThis.window,originalSelf=globalThis.self;
  globalThis.self=globalThis;
  globalThis.Worker=class {constructor(){throw new Error('Native OCR worker reached');}};
  globalThis.window={location:{href:'http://localhost/'}};
  const engine=new OcrEngine();
  try{await assert.rejects(engine.getWorker(),/Native OCR worker reached/);}
  finally{await engine.destroy();globalThis.Worker=originalWorker;globalThis.window=originalWindow;globalThis.self=originalSelf;}
});

test('OCR maps normalized Danish words to code point offsets while preserving paragraphs and lines',async()=>{
  let settings,calls=0;const progress=[];
  const worker={setParameters:async()=>{},recognize:async(_canvas,_options,output)=>{assert.equal(output.blocks,true);calls++;return {data:raw};},terminate:async()=>{}};
  const engine=new OcrEngine(message=>progress.push(message),{createWorker:async(lang,oem,options)=>{assert.equal(lang,'dan');assert.equal(oem,1);settings=options;return worker;}});
  const result=await engine.recognize(canvas,importText);
  assert.equal(result.data.text,'😀 Åse\nser øer.\n\nblågrønne');
  assert.deepEqual(result.tokens.map(token=>[token.paragraph,token.start,token.end,token.text]),[[0,2,5,'Åse'],[0,6,9,'ser'],[0,10,13,'øer'],[1,0,9,'blågrønne']]);
  assert.deepEqual(result.tokens[0].bbox,bbox(12,0,40,10));
  assert.equal(settings.cacheMethod,'none');assert.equal(settings.workerBlobURL,false);
  assert.match(settings.workerPath,/vendor\/tesseract\/worker.min.js$/);
  assert.match(settings.corePath,/vendor\/tesseract\/core\/?$/);
  assert.match(settings.langPath,/vendor\/tesseract\/lang\/?$/);
  assert.equal(calls,1);assert.equal(progress.at(-1),'');
  await engine.destroy();
});

test('recognition calls serialize and share one lazy worker',async()=>{
  let release,active=0,peak=0,created=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const worker={setParameters:async()=>{},recognize:async()=>{active++;peak=Math.max(peak,active);await gate;active--;return {data:raw};},terminate:async()=>{}};
  const engine=new OcrEngine(()=>{},{createWorker:async()=>{created++;return worker;}});
  const first=engine.recognize(canvas,importText),second=engine.recognize(canvas,importText);
  release();await Promise.all([first,second]);
  assert.equal(created,1);assert.equal(peak,1);await engine.destroy();
});

test('destroy during worker startup terminates late work and never resurrects the engine',async()=>{
  let release,terminated=0;
  const worker={setParameters:async()=>{},recognize:async()=>assert.fail('Closed engine must not recognize'),terminate:async()=>{terminated++;}};
  const gate=new Promise(resolve=>{release=resolve;});
  const engine=new OcrEngine(()=>{},{createWorker:async()=>{await gate;return worker;}});
  const pending=engine.recognize(canvas,importText);
  await Promise.resolve();await engine.destroy();release();
  await assert.rejects(pending,/closed|cancel/i);
  await assert.rejects(engine.recognize(canvas,importText),/closed|cancel/i);
  assert.equal(terminated,1);
});

test('destroy terminates the native worker before asynchronous initialization finishes',async()=>{
  const original=globalThis.Worker;let terminated=0,release;
  globalThis.Worker=class {terminate(){terminated++;}};
  const gate=new Promise(resolve=>{release=resolve;});
  const engine=new OcrEngine(()=>{},{createWorker:async(_lang,_oem,options)=>{
    const native=new Worker(options.workerPath);await gate;
    return {setParameters:async()=>{},recognize:async()=>assert.fail('Closed initialization cannot recognize'),terminate:async()=>native.terminate()};
  }});
  try{
    const pending=assert.rejects(engine.recognize(canvas,importText),/closed|cancel/i);
    await Promise.resolve();await engine.destroy();
    assert.equal(terminated,1);release();await pending;
  }finally{release();await engine.destroy();globalThis.Worker=original;}
});

test('worker errors are safe, release the worker and allow recognition retry',async()=>{
  let created=0,terminated=0;
  const engine=new OcrEngine(()=>{},{createWorker:async()=>{
    const attempt=created++;
    return {setParameters:async()=>{},recognize:async()=>{if(!attempt)throw new Error('PRIVATE IMAGE TEXT');return {data:raw};},terminate:async()=>{terminated++;}};
  }});
  await assert.rejects(engine.recognize(canvas,importText),error=>/recogn|OCR/i.test(error.message) && !error.message.includes('PRIVATE'));
  assert.equal((await engine.recognize(canvas,importText)).data.paragraphs.length,2);
  assert.equal(created,2);assert.equal(terminated,1);await engine.destroy();
});

test('late errors from an old worker cannot cancel a replacement recognition',async()=>{
  const handlers=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const engine=new OcrEngine(()=>{},{createWorker:async(_lang,_oem,options)=>{
    handlers.push(options.errorHandler);const attempt=handlers.length;
    return {setParameters:async()=>{},recognize:async()=>{if(attempt===1)throw new Error('old worker failed');await gate;return {data:raw};},terminate:async()=>{}};
  }});
  await assert.rejects(engine.recognize(canvas,importText),/recognize/i);
  const pending=engine.recognize(canvas,importText);
  await new Promise(resolve=>setImmediate(resolve));
  handlers[0]();release();
  assert.equal((await pending).data.paragraphs.length,2);await engine.destroy();
});

test('late initialization cannot drop the native handle of a replacement worker',async()=>{
  const original=globalThis.Worker,workers=[],handlers=[],releases=[];
  globalThis.Worker=class {constructor(){this.closed=false;workers.push(this);}terminate(){this.closed=true;}};
  const engine=new OcrEngine(()=>{},{createWorker:async(_lang,_oem,options)=>{
    const native=new Worker(options.workerPath);handlers.push(options.errorHandler);
    await new Promise(resolve=>releases.push(resolve));
    return {setParameters:async()=>{},recognize:async()=>assert.fail('Cancelled workers cannot recognize'),terminate:async()=>native.terminate()};
  }});
  try{
    const first=assert.rejects(engine.recognize(canvas,importText),/recognize/i);
    await new Promise(resolve=>setImmediate(resolve));handlers[0]();await first;
    const second=assert.rejects(engine.recognize(canvas,importText),/cancel|closed/i);
    await new Promise(resolve=>setImmediate(resolve));releases[0]();
    await new Promise(resolve=>setImmediate(resolve));await engine.destroy();
    assert.equal(workers[1].closed,true);releases[1]();await second;
  }finally{releases.forEach(release=>release());await engine.destroy();globalThis.Worker=original;}
});

test('recognition timeout terminates the worker and empty pages return an actionable warning',async()=>{
  let terminated=0;
  const engine=new OcrEngine(()=>{},{timeoutMs:5,createWorker:async()=>({setParameters:async()=>{},recognize:async()=>new Promise(()=>{}),terminate:async()=>{terminated++;}})});
  await assert.rejects(engine.recognize(canvas,importText),/timed out/i);
  assert.equal(terminated,1);await engine.destroy();
  const empty=new OcrEngine(()=>{},{createWorker:async()=>({setParameters:async()=>{},recognize:async()=>({data:{text:'',blocks:[]}}),terminate:async()=>{}})});
  const result=await empty.recognize(canvas,importText);
  assert.equal(result.data.text,'');assert.deepEqual(result.tokens,[]);assert.match(result.data.warnings[0],/no.*text/i);
  await empty.destroy();
});

test('OCR overlay uses text-only positioned spans with occurrence metadata',()=>{
  const original=globalThis.document;
  globalThis.document={createElement:tag=>({tagName:tag,style:{},dataset:{},children:[],append(...nodes){this.children.push(...nodes);}}),createTextNode:text=>({textContent:text})};
  try{
    const layer=renderOcrLayer({width:100,height:50,data:{paragraphs:[{id:0,text:'<img>'}]},tokens:[{paragraph:0,start:0,end:5,text:'<img>',bbox:bbox(10,5,50,15)}]},200,100);
    assert.equal(layer.className,'ocrLayer');
    const span=layer.children.find(node=>node.className==='word');
    assert.equal(span.textContent,'<img>');assert.equal(span.innerHTML,undefined);
    assert.deepEqual(span.dataset,{paragraph:0,start:0,end:5});
    assert.equal(span.style.left,'10%');assert.equal(span.style.top,'10%');
    assert.equal(span.style.width,'40%');assert.equal(span.style.height,'20%');assert.equal(span.style.fontSize,'20px');
    assert.equal(span.style.color,'transparent');
  }finally{globalThis.document=original;}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as pdf from '../static/pdf-reader.js';
import { importText } from '../static/documents.js';

const item = (str,x=40,y=700,width=100,height=12) => ({str,transform:[height,0,0,height,x,y],width,height});

test('PDF OCR decision keeps native text and catches scans with only a page number', () => {
  assert.equal(typeof pdf.pdfNeedsOcr, 'function');
  assert.equal(pdf.pdfNeedsOcr('',false),true);
  assert.equal(pdf.pdfNeedsOcr('12',true),true);
  assert.equal(pdf.pdfNeedsOcr('Det er lige meget.',false),false);
  assert.equal(pdf.pdfNeedsOcr('En hel side med mange forskellige danske ord som allerede kan vælges direkte.',true),false);
});

test('native PDF page cache retains fragment offsets and does not initialize OCR', async () => {
  const reader=new pdf.PdfReader({});
  reader.document={getPage:async()=>({getTextContent:async()=>({items:[item('ord',40,700,18),item('bog',58,700,18),
    item(' med mange danske ord som vi allerede kan læse uden at genkende billedet',76,700,500)]})})};
  const first=await reader.pageData(1,importText);
  const second=await reader.pageData(1,importText);
  assert.equal(first,second);
  assert.equal(first.data.paragraphs[0].words[0].text,'ordbog');
  assert.deepEqual(first.blocks[0].runs.slice(0,2).map(run=>[run.start,run.end]),[[0,3],[3,6]]);
  assert.equal(reader.ocrEngine,null);
});

test('scanned PDF recognition is cached and its bounded raster is released', async () => {
  const oldDocument=globalThis.document,canvases=[];
  globalThis.document={createElement:()=>{
    const canvas={width:0,height:0,getContext:()=>({})};canvases.push(canvas);return canvas;
  }};
  try {
    const reader=new pdf.PdfReader({});
    let recognitionCount=0;
    reader.ocrReady=Promise.resolve({recognize:async(canvas,parse)=>{
      recognitionCount++;
      assert.ok(canvas.width<=3000 && canvas.height<=3000);
      assert.ok(canvas.width*canvas.height<=6000000);
      assert.ok(canvas.width>canvas.height);
      return {data:parse('En genkendt side.'),tokens:[],width:canvas.width,height:canvas.height};
    }});
    reader.document={getPage:async()=>({getTextContent:async()=>({items:[]}),
      getViewport:({scale})=>({width:4000*scale,height:3000*scale}),render:()=>({promise:Promise.resolve(),cancel(){}})})};
    const first=await reader.pageData(1,importText),second=await reader.pageData(1,importText);
    assert.equal(first.data.text,'En genkendt side.');
    assert.equal(first,second);
    assert.equal(recognitionCount,1);
    assert.ok(first.ocr);
    assert.equal(canvases[0].width,0);
    assert.equal(canvases[0].height,0);
  } finally {
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  }
});

test('manual PDF recognition replaces native page data and failures keep a readable original view', async () => {
  const reader=new pdf.PdfReader({});
  reader.document={getPage:async()=>({getTextContent:async()=>({items:[item('En eksisterende tekst.')]})})};
  reader.pages.set(1,Promise.resolve({data:importText('Gammel tekst.')}));
  reader.recognizePage=async()=>({data:importText('Ny genkendt tekst.'),tokens:[],width:100,height:100});
  const result=await reader.forceOcr(1,importText);
  assert.equal(result.data.text,'Ny genkendt tekst.');
  assert.equal((await reader.pageData(1,importText)).data.text,'Ny genkendt tekst.');
  reader.recognizePage=async()=>{throw new Error('worker failure');};
  const failed=await reader.forceOcr(1,importText);
  assert.equal(failed.data.text,'');
  assert.equal(failed.data.paragraphs.length,0);
  assert.ok(failed.data.warnings.length);
  assert.equal(failed.content.items[0].str,'En eksisterende tekst.');
});

test('PDF text view includes cached OCR pages and respects the text limit', async () => {
  const reader=new pdf.PdfReader({});
  reader.document={numPages:2};
  reader.pages.set(1,Promise.resolve({data:importText('En dansk side.')}));
  reader.pages.set(2,Promise.resolve({data:importText('En genkendt side.'),ocr:{tokens:[]}}));
  assert.equal(await reader.extractedText(importText),'En dansk side.\n\nEn genkendt side.');
  reader.pages.set(2,Promise.resolve({data:{text:'a'.repeat(200000)}}));
  await assert.rejects(reader.extractedText(importText),/200,000/);
});

test('closing a PDF clears OCR page data and releases its engine', async () => {
  const reader=new pdf.PdfReader({});
  let closed=false;
  reader.ocrEngine={destroy:async()=>{closed=true;}};
  reader.pages.set(1,Promise.resolve({data:importText('En side.')}));
  await reader.destroy();
  assert.equal(closed,true);
  assert.equal(reader.pages.size,0);
  assert.equal(reader.document,null);
});

test('closing during PDF recognition rejects late text and releases its canvas', async () => {
  const oldDocument=globalThis.document,canvas={width:0,height:0,getContext:()=>({})};
  globalThis.document={createElement:()=>canvas};
  try {
    const reader=new pdf.PdfReader({});
    const started=Promise.withResolvers(),completion=Promise.withResolvers();
    reader.ocrEngine={recognize:()=>{started.resolve();return completion.promise;},destroy:async()=>{}};
    reader.ocrReady=Promise.resolve(reader.ocrEngine);
    reader.document={getPage:async()=>({getTextContent:async()=>({items:[]}),
      getViewport:({scale})=>({width:600*scale,height:800*scale}),render:()=>({promise:Promise.resolve(),cancel(){}})})};
    const pending=reader.pageData(1,importText);
    await started.promise;
    await reader.destroy();
    completion.resolve({data:importText('For sent.'),tokens:[],width:1500,height:2000});
    await assert.rejects(pending,/PDF closed/);
    assert.equal(reader.pages.size,0);
    assert.equal(canvas.width,0);
    assert.equal(canvas.height,0);
  } finally {
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  }
});

test('PDF raster allocation is released even when the renderer fails synchronously', async () => {
  const oldDocument=globalThis.document,canvas={width:0,height:0,getContext:()=>({})};
  globalThis.document={createElement:()=>canvas};
  try {
    const reader=new pdf.PdfReader({});
    reader.ocrReady=Promise.resolve({});
    const page={getViewport:({scale})=>({width:600*scale,height:800*scale}),render:()=>{throw new Error('Damaged raster');}};
    await assert.rejects(reader.recognizePage(page,importText),/Damaged raster/);
    assert.equal(canvas.width,0);
    assert.equal(canvas.height,0);
  } finally {
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  }
});

test('rapid PDF requests allocate one OCR canvas and prioritize the newest requested page', async () => {
  const oldDocument=globalThis.document,canvases=[],started=[],completions=new Map();
  globalThis.document={createElement:()=>{const canvas={width:0,height:0,getContext(){return {canvas:this};}};canvases.push(canvas);return canvas;}};
  try {
    const reader=new pdf.PdfReader({});
    reader.ocrReady=Promise.resolve({recognize:canvas=>{
      started.push(canvas.page);const done=Promise.withResolvers();completions.set(canvas.page,done);return done.promise;
    }});
    reader.document={getPage:async number=>({getTextContent:async()=>({items:[]}),
      getViewport:({scale})=>({width:600*scale,height:800*scale}),
      render:({canvasContext})=>{canvasContext.canvas.page=number;return {promise:Promise.resolve(),cancel(){}};}})};
    const active=reader.pageData(2,importText);
    while(!started.length)await new Promise(resolve=>setImmediate(resolve));
    const earlier=reader.pageData(20,importText);
    const forced=reader.forceOcr(20,importText);
    reader.requestedPage=30;
    const latest=reader.pageData(30,importText);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(canvases.length,1);
    assert.deepEqual(started,[2]);
    const result=number=>({data:importText(`Side ${number}.`),tokens:[],width:1500,height:2000});
    completions.get(2).resolve(result(2));await active;
    while(!completions.has(30))await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(started,[2,30]);
    assert.equal(canvases.filter(canvas=>canvas.width>0).length,1);
    completions.get(30).resolve(result(30));await latest;
    while(!completions.has(20))await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(started,[2,30,20]);
    completions.get(20).resolve(result(20));await earlier;await forced;
    assert.equal((await reader.pageData(20,importText)).data.text,'Side 20.');
    assert.equal(canvases.length,3);
    assert.equal(canvases.filter(canvas=>canvas.width>0).length,0);
  } finally {
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  }
});

test('closing rejects queued PDF recognition without allocating another raster', async () => {
  const oldDocument=globalThis.document,canvases=[],started=Promise.withResolvers(),completion=Promise.withResolvers();
  globalThis.document={createElement:()=>{const canvas={width:0,height:0,getContext:()=>({})};canvases.push(canvas);return canvas;}};
  try {
    const reader=new pdf.PdfReader({});
    reader.ocrEngine={recognize:()=>{started.resolve();return completion.promise;},destroy:async()=>{}};
    reader.ocrReady=Promise.resolve(reader.ocrEngine);
    reader.document={getPage:async()=>({getTextContent:async()=>({items:[]}),getViewport:({scale})=>({width:600*scale,height:800*scale}),
      render:()=>({promise:Promise.resolve(),cancel(){}})})};
    const active=reader.pageData(2,importText);
    await started.promise;
    const queued=reader.pageData(3,importText);
    const activeRejected=assert.rejects(active,/closed/),queuedRejected=assert.rejects(queued,/closed/);
    await new Promise(resolve=>setImmediate(resolve));
    await reader.destroy();
    await Promise.race([Promise.all([activeRejected,queuedRejected]),new Promise((_,reject)=>setTimeout(()=>reject(new Error('OCR jobs did not cancel')),100))]);
    assert.equal(canvases.length,1);
    assert.equal(canvases[0].width,0);
    completion.resolve({data:importText('For sent.'),tokens:[],width:1,height:1});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(canvases.length,1);
  } finally {
    completion.resolve({data:importText('For sent.'),tokens:[],width:1,height:1});
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageReader} from '../static/image-reader.js';

function png(width=1200,height=800) {
  const bytes=new Uint8Array(24);
  bytes.set([137,80,78,71,13,10,26,10]);
  const view=new DataView(bytes.buffer);view.setUint32(16,width);view.setUint32(20,height);
  return Object.assign(new Blob([bytes],{type:'image/png'}),{name:'page.png'});
}
function platform(t,width=1200,height=800) {
  const previous={document:globalThis.document,window:globalThis.window,createImageBitmap:globalThis.createImageBitmap};
  const canvases=[],bitmap={width,height,closed:false,close(){this.closed=true;}};
  globalThis.window={devicePixelRatio:2};
  globalThis.createImageBitmap=async()=>bitmap;
  globalThis.document={createElement(tag){
    const element={tag,style:{setProperty(){}},dataset:{},children:[],setAttribute(){},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;}};
    if(tag==='canvas') {element.getContext=()=>({drawImage(...args){element.draw=args;}});canvases.push(element);}
    return element;
  }};
  t.after(()=>{Object.assign(globalThis,previous);});
  return {bitmap,canvases};
}
const result={width:1200,height:800,tokens:[],data:{text:'Røde æbler.',paragraphs:[],warnings:[]}};
const engine=()=>({calls:0,destroyed:false,async recognize(){this.calls++;return result;},async destroy(){this.destroyed=true;}});

test('image zoom reuses OCR and displays original pixels with a selectable overlay',async t=>{
  const {bitmap,canvases}=platform(t),ocr=engine(),reader=new ImageReader(png(),{engine:ocr});
  assert.equal(await reader.open(),1);assert.equal(reader.document.numPages,1);
  const first=await reader.show(1,'fit',602,()=>{});
  assert.equal(first.element.className,'pdf-page');assert.equal(first.element.style.width,'600px');
  assert.equal(first.element.children[0].draw[0],bitmap);
  assert.equal(first.element.children[1].className,'ocrLayer');
  assert.equal(first.data.text,'Røde æbler.');
  await reader.show(1,2,602,()=>{});
  assert.equal(ocr.calls,1);assert.equal(await reader.extractedText(),'Røde æbler.');
  assert.equal(canvases[0].width,0);
  await reader.destroy();assert.equal(bitmap.closed,true);assert.equal(ocr.destroyed,true);
  assert.equal(reader.file,null);assert.equal(reader.document,null);
  assert.ok(canvases.every(canvas=>canvas.width===0 && canvas.height===0));
});

test('oversized image metadata is rejected before bitmap allocation',async t=>{
  platform(t);let decodes=0;globalThis.createImageBitmap=async()=>{decodes++;};
  await assert.rejects(new ImageReader(png(10000,10000),{engine:engine()}).open(),/40|large|pixels/i);
  assert.equal(decodes,0);
  const large=png();Object.defineProperty(large,'size',{value:10*1024*1024+1});
  await assert.rejects(new ImageReader(large,{engine:engine()}).open(),/10 MiB/);
});

test('JPEG and each WebP header are checked before native decoding',async t=>{
  platform(t);
  const jpeg=new Uint8Array([255,216,255,192,0,8,8,3,32,4,176,0]);
  const webp=kind=>{const bytes=new Uint8Array(32);bytes.set(new TextEncoder().encode('RIFF'),0);bytes.set(new TextEncoder().encode(`WEBP${kind}`),8);return bytes;};
  const extended=webp('VP8X');extended.set([175,4,0,31,3,0],24);
  const lossy=webp('VP8 ');lossy.set([157,1,42,176,4,32,3],23);
  const lossless=webp('VP8L');lossless[20]=47;new DataView(lossless.buffer).setUint32(21,1199+(799<<14),true);
  for(const bytes of [jpeg,extended,lossy,lossless]) {
    const reader=new ImageReader(new Blob([bytes]),{engine:engine()});
    assert.equal(await reader.open(),1);await reader.destroy();
  }
  jpeg.set([39,16,39,16],7);extended.set([15,39,0,15,39,0],24);
  lossy.set([16,39,16,39],26);new DataView(lossless.buffer).setUint32(21,9999+(9999<<14),true);
  globalThis.createImageBitmap=()=>{assert.fail('Oversized metadata must be rejected before decoding.');};
  for(const bytes of [jpeg,extended,lossy,lossless])
    await assert.rejects(new ImageReader(new Blob([bytes]),{engine:engine()}).open(),/too large/);
  await assert.rejects(new ImageReader(new Blob(['invalid']),{engine:engine()}).open(),/valid PNG/);
});

test('render canvases remain within memory and browser dimension limits',async t=>{
  platform(t,8000,5000);const reader=new ImageReader(png(8000,5000),{engine:engine()});
  await reader.open();const shown=await reader.show(1,8,600,()=>{}),canvas=shown.element.children[0];
  assert.ok(canvas.width*canvas.height<=16777216);
  assert.ok(canvas.width<=8192 && canvas.height<=8192);
  await assert.rejects(reader.pageData(2,()=>{}),/page/i);
  await reader.destroy();
});

test('recognition failure leaves original image readable and manual retry recovers',async t=>{
  platform(t);const ocr=engine();ocr.recognize=async function(){this.calls++;if(this.calls===1)throw new Error('worker failed');return result;};
  const reader=new ImageReader(png(),{engine:ocr});await reader.open();
  const failed=await reader.show(1,1,600,()=>{});
  assert.equal(failed.element.children.length,1);assert.match(failed.data.warnings.join(' '),/retry|try again/i);
  assert.equal((await reader.forceOcr(1,()=>{})).data.text,'Røde æbler.');
  assert.equal(ocr.calls,2);await reader.destroy();
});

test('closing during decode closes the late bitmap and prevents reopening',async t=>{
  const {bitmap}=platform(t);let finishDecode;
  globalThis.createImageBitmap=()=>new Promise(resolve=>{finishDecode=resolve;});
  const reader=new ImageReader(png(),{engine:engine()}),opening=reader.open();
  while(!finishDecode)await new Promise(resolve=>setImmediate(resolve));
  await reader.destroy();finishDecode(bitmap);
  await assert.rejects(opening,/closed/i);assert.equal(bitmap.closed,true);
  await assert.rejects(reader.open(),/closed/i);assert.equal(reader.document,null);
});

test('closing during recognition cannot attach late results or retain processing pixels',async t=>{
  const {canvases}=platform(t);let finishRecognition;
  const ocr=engine();ocr.recognize=()=>new Promise(resolve=>{finishRecognition=resolve;});
  const reader=new ImageReader(png(),{engine:ocr});await reader.open();
  const showing=reader.show(1,1,600,()=>{});
  while(!finishRecognition)await new Promise(resolve=>setImmediate(resolve));
  await reader.destroy();finishRecognition(result);
  assert.equal(await showing,null);assert.equal(reader.pages.size,0);
  assert.ok(canvases.every(canvas=>canvas.width===0 && canvas.height===0));
});

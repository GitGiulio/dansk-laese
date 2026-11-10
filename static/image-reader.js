import {OcrEngine,renderOcrLayer} from './ocr.js';

const MAX_BYTES=10*1024*1024,MAX_PIXELS=40000000;

function imageDimensions(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length>=24 && bytes.slice(0,8).every((value,index)=>value===[137,80,78,71,13,10,26,10][index]))
    return [view.getUint32(16),view.getUint32(20)];
  if(bytes.length>=30 && String.fromCharCode(...bytes.slice(0,4))==='RIFF'
    && String.fromCharCode(...bytes.slice(8,12))==='WEBP') {
    const kind=String.fromCharCode(...bytes.slice(12,16));
    if(kind==='VP8X')return [1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16),1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16)];
    if(kind==='VP8 ' && bytes[23]===157 && bytes[24]===1 && bytes[25]===42)
      return [view.getUint16(26,true)&16383,view.getUint16(28,true)&16383];
    if(kind==='VP8L' && bytes[20]===47) {
      const bits=view.getUint32(21,true);return [(bits&16383)+1,((bits>>>14)&16383)+1];
    }
  }
  if(bytes[0]===255 && bytes[1]===216) {
    for(let offset=2;offset+3<bytes.length;) {
      if(bytes[offset++]!==255)break;
      while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];
      if(marker===217 || marker===218)break;
      if(offset+2>bytes.length)break;
      const length=view.getUint16(offset);
      if(length<2 || offset+length>bytes.length)break;
      if(length>=7 && [192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))
        return [view.getUint16(offset+5),view.getUint16(offset+3)];
      offset+=length;
    }
  }
  throw new Error('Choose a valid PNG, JPEG, or WebP image.');
}

function checkDimensions(width,height) {
  if(!width || !height || width>32767 || height>32767 || width*height>MAX_PIXELS)
    throw new Error('Image is too large. Use an image below 40 million pixels and 32,768 pixels per side.');
}

function raster(bitmap,width,height,density=1,maxPixels=16777216,maxSide=8192) {
  const canvas=document.createElement('canvas');
  // ponytail: bound raster memory; tiled image rendering can wait for larger documents.
  const ratio=Math.min(density,Math.sqrt(maxPixels/(width*height)),maxSide/width,maxSide/height);
  canvas.width=Math.max(1,Math.floor(width*ratio));canvas.height=Math.max(1,Math.floor(height*ratio));
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
  return canvas;
}

async function decode(file) {
  if(typeof createImageBitmap==='function')return createImageBitmap(file);
  const url=URL.createObjectURL(file);
  try {
    const image=new Image();image.src=url;await image.decode();return image;
  } finally {URL.revokeObjectURL(url);}
}

export class ImageReader {
  constructor(file,{onProgress=()=>{},engine}={}) {
    this.file=file;this.engine=engine ?? new OcrEngine(onProgress);
    this.document=null;this.page=1;this.pages=new Map();
    this.bitmap=null;this.opening=null;this.renderedCanvas=null;this.processingCanvas=null;
    this.destroyed=false;this.version=0;
  }

  async open() {
    if(this.destroyed)throw new Error('Image closed.');
    if(!this.opening) {
      this.opening=(async()=>{
        if(this.file.size>MAX_BYTES)throw new Error('Images are limited to 10 MiB.');
        const bytes=new Uint8Array(await this.file.arrayBuffer());
        if(this.destroyed)throw new Error('Image closed.');
        checkDimensions(...imageDimensions(bytes));
        const bitmap=await decode(this.file);
        if(this.destroyed){bitmap.close?.();throw new Error('Image closed.');}
        try {checkDimensions(bitmap.width,bitmap.height);}
        catch(error){bitmap.close?.();throw error;}
        this.bitmap=bitmap;this.document={numPages:1};return 1;
      })();
      this.opening.catch(()=>{if(!this.destroyed)this.opening=null;});
    }
    return this.opening;
  }

  async pageData(number,importText) {
    if(this.destroyed)throw new Error('Image closed.');
    if(number!==1)throw new Error('Image page does not exist.');
    await this.open();
    if(this.destroyed)throw new Error('Image closed.');
    if(!this.pages.has(number)) {
      const pending=(async()=>{
        const canvas=raster(this.bitmap,this.bitmap.width,this.bitmap.height,1,6000000,4096);
        this.processingCanvas=canvas;
        try {
          const result=await this.engine.recognize(canvas,importText);
          if(this.destroyed)throw new Error('Image closed.');
          return result;
        } finally {
          canvas.width=0;canvas.height=0;
          if(this.processingCanvas===canvas)this.processingCanvas=null;
        }
      })();
      this.pages.set(number,pending);
      pending.catch(()=>{if(this.pages.get(number)===pending)this.pages.delete(number);});
    }
    return this.pages.get(number);
  }

  async forceOcr(number,importText) {
    await this.pages.get(number)?.catch(()=>{});
    this.pages.delete(number);
    return this.pageData(number,importText);
  }

  async show(number,zoom,availableWidth,importText) {
    if(number!==1)throw new Error('Image page does not exist.');
    const version=++this.version;
    let result;
    try {result=await this.pageData(number,importText);}
    catch(error) {
      if(this.destroyed || version!==this.version)return null;
      if(!this.bitmap)throw error;
      result={data:{text:'',paragraphs:[],warnings:[`Recognition failed: ${error.message} Try again with the recognition button.`]}};
    }
    if(this.destroyed || version!==this.version)return null;
    const scale=zoom==='fit'?Math.max(.1,(availableWidth-2)/this.bitmap.width):Number(zoom);
    if(!Number.isFinite(scale) || scale<=0)throw new Error('Invalid image zoom.');
    const width=this.bitmap.width*scale,height=this.bitmap.height*scale;
    const element=document.createElement('div');element.className='pdf-page';
    element.style.width=`${width}px`;element.style.height=`${height}px`;
    const canvas=raster(this.bitmap,width,height,Math.min(globalThis.window?.devicePixelRatio || 1,2));
    canvas.setAttribute('aria-hidden','true');canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;
    if(this.renderedCanvas){this.renderedCanvas.width=0;this.renderedCanvas.height=0;}
    this.renderedCanvas=canvas;element.append(canvas);
    if(result.tokens)element.append(renderOcrLayer(result,width,height));
    this.page=number;return {element,data:result.data};
  }

  async extractedText() {
    if(this.destroyed)throw new Error('Image closed.');
    const result=await this.pages.get(1);
    if(this.destroyed)throw new Error('Image closed.');
    if(!result?.data.text)throw new Error('Recognize the image text before switching to text view.');
    return result.data.text;
  }

  async destroy() {
    this.destroyed=true;this.version++;
    this.bitmap?.close?.();this.bitmap=null;
    for(const canvas of [this.renderedCanvas,this.processingCanvas])if(canvas){canvas.width=0;canvas.height=0;}
    this.renderedCanvas=null;this.processingCanvas=null;
    this.pages.clear();this.file=null;this.document=null;
    await this.engine.destroy();
  }
}

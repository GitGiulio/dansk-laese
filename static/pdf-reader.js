const clean = text => text.normalize('NFC').replace(/\u00ad/g,'').replace(/[\r\n]+/g,' ');

export function pdfTextBlocks(items) {
  const pieces = items.flatMap((item,itemIndex) => {
    if (typeof item.str !== 'string' || !item.str.trim()) return [];
    return [{itemIndex,text:clean(item.str),x:item.transform[4],y:item.transform[5],
      width:item.width,height:Math.max(1,item.height || Math.hypot(item.transform[2],item.transform[3]))}];
  }).sort((a,b) => b.y-a.y || a.x-b.x);
  const lines=[];
  for(const piece of pieces) {
    let line=lines.findLast(line => Math.abs(line.y-piece.y)<=Math.min(line.height,piece.height)*.3);
    if(!line) { line={y:piece.y,height:piece.height,pieces:[]};lines.push(line); }
    line.pieces.push(piece);
  }
  const runs=[];
  for(const line of lines) {
    let run;
    for(const piece of line.pieces.sort((a,b)=>a.x-b.x)) {
      if(!run || piece.x-run.right > Math.max(24,line.height*2.5)) {
        run={x:piece.x,right:piece.x,y:line.y,height:line.height,pieces:[]};runs.push(run);
      }
      run.pieces.push(piece);run.right=piece.x+piece.width;
    }
  }
  const blocks=[];
  for(const line of runs) {
    // ponytail: geometric grouping covers ordinary columns; complex magazine layouts may need text-view correction.
    const block=blocks.findLast(block => {
      const last=block.lines.at(-1), gap=last.y-line.y;
      return gap>line.height*.3 && gap<=Math.max(last.height,line.height)*2
        && Math.min(last.height,line.height)/Math.max(last.height,line.height)>.7
        && Math.abs(block.x-line.x)<=Math.max(line.height*2,12);
    });
    if(block)block.lines.push(line);
    else blocks.push({x:line.x,lines:[line]});
  }
  return blocks.map(block => {
    let text='', mapping=[];
    for(const [lineIndex,line] of block.lines.entries()) {
      if(lineIndex)text+='\n';
      let previous;
      for(const piece of line.pieces) {
        if(previous && !/\s$/.test(text) && !/^\s/.test(piece.text)
          && piece.x-(previous.x+previous.width)>piece.height*.15)text+=' ';
        const start=Array.from(text).length;
        text+=piece.text;
        mapping.push({itemIndex:piece.itemIndex,start,end:Array.from(text).length,itemStart:0});
        previous=piece;
      }
    }
    const trimStart=Array.from(text).length-Array.from(text.trimStart()).length;
    text=text.trim();
    const length=Array.from(text).length;
    mapping=mapping.map(run=>({itemIndex:run.itemIndex,start:Math.max(0,run.start-trimStart),
      end:Math.min(length,run.end-trimStart),itemStart:Math.max(0,trimStart-run.start)})).filter(run=>run.end>run.start);
    return {text,runs:mapping};
  });
}

let library;
async function pdfLibrary() {
  library ??= import('./vendor/pdfjs/build/pdf.min.mjs');
  const pdfjs=await library;
  pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs/build/pdf.worker.min.mjs',import.meta.url).href;
  return pdfjs;
}

export class PdfReader {
  constructor(file) {
    this.file=file;this.document=null;this.loading=null;this.renderTask=null;this.textLayer=null;
    this.pages=new Map();
    this.page=1;this.version=0;this.destroyed=false;
  }

  async open() {
    const pdfjs=await pdfLibrary();
    if(this.destroyed)throw new Error('PDF closed.');
    const bytes=new Uint8Array(await this.file.arrayBuffer());
    if(this.destroyed)throw new Error('PDF closed.');
    this.loading=pdfjs.getDocument({data:bytes,
      cMapUrl:new URL('./vendor/pdfjs/cmaps/',import.meta.url).href,cMapPacked:true,
      standardFontDataUrl:new URL('./vendor/pdfjs/standard_fonts/',import.meta.url).href,
      wasmUrl:new URL('./vendor/pdfjs/wasm/',import.meta.url).href,
      isEvalSupported:false,enableXfa:false});
    this.document=await this.loading.promise;
    if(this.destroyed)throw new Error('PDF closed.');
    return this.document.numPages;
  }

  async content(page) {
    const raw=await page.getTextContent();
    return {...raw,items:raw.items.map(item=>typeof item.str==='string'?{...item,str:clean(item.str)}:item)};
  }

  async pageData(number,importText) {
    if(!this.pages.has(number)){
      const pending=(async()=>{
        const content=await this.content(await this.document.getPage(number));
        const blocks=pdfTextBlocks(content.items),text=blocks.map(block=>block.text).join('\n\n');
        const data=text?await importText(text):{text:'',paragraphs:[],warnings:[]};
        if(this.destroyed)throw new Error('PDF closed.');
        return {content,blocks,data};
      })();
      this.pages.set(number,pending);
      pending.catch(()=>{if(this.pages.get(number)===pending)this.pages.delete(number);});
    }
    return this.pages.get(number);
  }

  async show(number,zoom,availableWidth,importText) {
    const version=++this.version;
    this.renderTask?.cancel();this.textLayer?.cancel();
    const pdfjs=await pdfLibrary();
    const page=await this.document.getPage(number);
    const base=page.getViewport({scale:1});
    const scale=zoom==='fit'?Math.max(.1,(availableWidth-2)/base.width):Number(zoom);
    const viewport=page.getViewport({scale});
    const {content,blocks,data}=await this.pageData(number,importText);
    if(this.destroyed || version!==this.version)return null;
    const element=document.createElement('div');element.className='pdf-page';
    element.style.width=`${viewport.width}px`;element.style.height=`${viewport.height}px`;
    element.style.setProperty('--scale-factor',scale);
    element.style.setProperty('--user-unit',page.userUnit);
    element.style.setProperty('--total-scale-factor',scale*page.userUnit);
    const canvas=document.createElement('canvas');canvas.setAttribute('aria-hidden','true');
    // ponytail: cap canvas memory at 16 megapixels; tiled rendering can wait for unusually large pages.
    const density=Math.min(window.devicePixelRatio || 1,2,Math.sqrt(16777216/(viewport.width*viewport.height)));
    canvas.width=Math.ceil(viewport.width*density);canvas.height=Math.ceil(viewport.height*density);
    canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`;
    element.append(canvas);
    const layer=document.createElement('div');layer.className='textLayer';element.append(layer);
    this.renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport,
      transform:density===1?null:[density,0,0,density,0,0]});
    this.textLayer=new pdfjs.TextLayer({textContentSource:content,container:layer,viewport});
    try { await Promise.all([this.renderTask.promise,this.textLayer.render()]); }
    catch(error) {if(this.destroyed || version!==this.version)return null;throw error;}
    if(this.destroyed || version!==this.version)return null;
    const divs=this.textLayer.textDivs;
    const divByItem=new Map();let divIndex=0;
    content.items.forEach((item,index)=>{if(typeof item.str==='string')divByItem.set(index,divs[divIndex++]);});
    for(const [paragraphIndex,block] of blocks.entries()) {
      const paragraph=data.paragraphs[paragraphIndex];
      for(const run of block.runs) {
        const div=divByItem.get(run.itemIndex);
        if(!div)continue;
        const chars=Array.from(content.items[run.itemIndex].str), fragment=document.createDocumentFragment();
        let cursor=0;
        for(const word of paragraph.words.filter(word=>word.end>run.start && word.start<run.end)) {
          const start=run.itemStart+Math.max(0,word.start-run.start);
          const end=run.itemStart+Math.min(run.end-run.start,word.end-run.start);
          fragment.append(document.createTextNode(chars.slice(cursor,start).join('')));
          const span=document.createElement('span');span.className='word';span.textContent=chars.slice(start,end).join('');
          span.dataset.paragraph=paragraph.id;span.dataset.start=word.start;span.dataset.end=word.end;
          fragment.append(span);cursor=end;
        }
        fragment.append(document.createTextNode(chars.slice(cursor).join('')));
        div.replaceChildren(fragment);
      }
    }
    this.page=number;
    return {element,data};
  }

  async extractedText() {
    const parts=[];let length=0;
    for(let number=1;number<=this.document.numPages;number++) {
      if(this.destroyed)throw new Error('PDF closed.');
      const content=await this.content(await this.document.getPage(number));
      const text=pdfTextBlocks(content.items).map(block=>block.text).join('\n\n');
      length+=Array.from(text).length+2;
      if(length>200000)throw new Error('Text view is limited to 200,000 characters. Continue using the original PDF view.');
      if(text)parts.push(text);
    }
    if(!parts.length)throw new Error('This PDF has no selectable text. OCR is needed for translation.');
    return parts.join('\n\n');
  }

  async destroy() {
    this.destroyed=true;this.version++;
    this.renderTask?.cancel();this.textLayer?.cancel();
    await this.loading?.destroy();
    this.pages.clear();
    this.file=null;this.document=null;
  }
}

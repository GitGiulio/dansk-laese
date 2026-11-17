import { PreparationClient, contextFor } from './reader.js';
import { PdfReader } from './pdf-reader.js';
import { ImageReader } from './image-reader.js';
import { importText, extractFile, words } from './documents.js';
import {PROMPT_VERSION} from './translation.js';
import {checkGeminiKey} from './gemini.js';
import {normalizeConnection,keyProvider,connectionKeys,createTranslationPool} from './keys.js';
import { AccountClient } from './accounts.js';
import { SUPABASE } from './config.js';
import { normalizeUsername, validateUsername, suggestUsernames } from './usernames.js';

const $ = id => document.getElementById(id);
const screens = ['auth-screen','import-screen','preview-screen','reader-screen'];
const reader = $('reader'), tooltip = $('tooltip');
const selectionActions = $('selection-actions'), highlightColors = document.querySelector('.highlight-colors');
const highlights = new WeakMap();
let documentData = null, documentName = '', wordElements = [], service;
let pdfReader = null, pdfTextData = null, resizeTimer, catalogueVersion=0;
let importVersion = 0, closeTimer, pinned = false, anchor = null, selectionTarget = null, currentTarget = null;
const account = new AccountClient(SUPABASE);
let selectionController=null;
const selectionCache=new Map();
let connection=null,editingConnection=null,translationPool=null,authVersion=0,resumeScreen='import-screen';
const quotaBudgets=new Map();
const geminiCooldowns=new Map();

function updateKeyForm(prefix,busy=false) {
  const rows=[...$(`${prefix}-list`).querySelectorAll('.key-row')],count=rows.length;
  document.querySelector(`[data-add-key="${prefix}"]`).disabled=busy || count>=8;
  const providers=new Set();
  rows.forEach((row,index)=>{
    const input=row.querySelector('input'),show=row.querySelector('[data-show-key]'),remove=row.querySelector('[data-remove-key]');
    const select=row.querySelector('select'),key=input.value.trim(),detected=keyProvider(key);
    input.setAttribute('aria-label',`API key ${index+1}`);
    select.setAttribute('aria-label',`Provider for API key ${index+1}`);
    select.hidden=!key || !!detected;
    if(key)providers.add(detected || select.value);
    show.textContent=input.type==='password'?'Show':'Hide';
    show.setAttribute('aria-label',`${show.textContent} key ${index+1}`);
    show.setAttribute('aria-pressed',String(input.type==='text'));
    remove.setAttribute('aria-label',`Remove key ${index+1}`);remove.disabled=busy || count===1;
  });
  if(prefix==='api-key')$('translation-provider-choice').hidden=!(providers.has('gemini') && providers.has('groq'));
}

function keyRow(prefix,input,first=false) {
  const list=$(`${prefix}-list`),row=document.createElement('div'),show=document.createElement('button'),remove=document.createElement('button');
  const provider=document.createElement('select');
  provider.add(new Option('Choose a provider',''));provider.add(new Option('Gemini','gemini'));provider.add(new Option('Groq','groq'));
  input.addEventListener('input',()=>{provider.value='';updateKeyForm(prefix);});
  provider.addEventListener('change',()=>updateKeyForm(prefix));
  row.className='key-row'+(first?' first-key-row':'');
  show.type='button';show.className='text-button';show.dataset.showKey='';
  show.addEventListener('click',()=>{input.type=input.type==='password'?'text':'password';updateKeyForm(prefix);});
  remove.type='button';remove.className='text-button';remove.textContent='Remove';
  remove.dataset.removeKey='';
  remove.addEventListener('click',()=>{
    if(list.querySelectorAll('input').length===1)return;
    if(first){
      const next=list.querySelector('.key-row:not(.first-key-row)');
      input.value=next.querySelector('input').value;input.type='password';provider.value=next.querySelector('select').value;
      next.querySelector('input').value='';next.remove();
    }else{input.value='';row.remove();}
    updateKeyForm(prefix);
  });
  row.append(input,show,remove,provider);list.append(row);updateKeyForm(prefix);
}
for(const prefix of ['api-key','signup-key'])keyRow(prefix,$(prefix),true);

function addKeyField(prefix,value='') {
  if($(`${prefix}-list`).querySelectorAll('input').length>=8)return;
  const input=document.createElement('input');
  input.type='password';input.autocomplete='off';input.required=true;input.maxLength=512;input.spellcheck=false;input.value=value;
  keyRow(prefix,input);return input;
}
for(const button of document.querySelectorAll('[data-add-key]'))button.addEventListener('click',()=>addKeyField(button.dataset.addKey)?.focus());

function keyFormValue(prefix) {
  const rows=[...$(`${prefix}-list`).querySelectorAll('.key-row')];
  return normalizeConnection({keys:rows.map(row=>row.querySelector('input').value),independent:true,
    providers:rows.map(row=>row.querySelector('select').value || null)},{requireProvider:true});
}
const vaultValue=value=>value.keys.length===1 && !value.providers?value.keys[0]:value;

function authStatus(message='') {
  $('auth-status').textContent=message;$('auth-status').hidden=!message;
}

function authMode(mode) {
  authStatus();
  for(const button of document.querySelectorAll('[data-auth-mode]'))button.setAttribute('aria-pressed',String(button.dataset.authMode===mode));
  for(const name of ['key','login','signup'])$(name==='key'?'api-key-form':`${name}-form`).hidden=name!==mode;
  $('save-key-label').hidden=!account.user;
}

function authBusy(value) {
  $('change-key').disabled=value;
  document.querySelectorAll('#auth-screen input,#auth-screen button,#auth-screen select').forEach(element=>element.disabled=value);
  for(const button of document.querySelectorAll('[data-auth-mode]')){
    if(button.dataset.authMode!=='key')button.disabled=value || !account.configured || !!account.user;
  }
  for(const prefix of ['api-key','signup-key'])updateKeyForm(prefix,value);
}

function clearSecrets() {
  for(const id of ['api-key','login-password','signup-password','signup-password-confirm','signup-key'])$(id).value='';
  for(const prefix of ['api-key','signup-key']){
    $(prefix).type='password';
    $(prefix).closest('.key-row').querySelector('select').value='';
    $(`${prefix}-list`).querySelectorAll('.key-row:not(.first-key-row)').forEach(row=>{row.querySelector('input').value='';row.remove();});
    updateKeyForm(prefix);
  }
  $('translation-provider').value='gemini';
  $('signup-password-confirm').setCustomValidity('');
}

function fillKeyForm(value,provider='gemini') {
  clearSecrets();
  editingConnection=value;
  if(connectionKeys(value,'gemini').length && connectionKeys(value,'groq').length)$('translation-provider').value=provider;
  value.keys.forEach((key,index)=>{
    const input=index===0?$('api-key'):addKeyField('api-key',key);
    input.value=key;
    input.closest('.key-row').querySelector('select').value=keyProvider(key)?'':value.providers?.[index] || 'groq';
  });
  updateKeyForm('api-key');
}

async function checkedPool(value,provider,previous=null) {
  const pool=await createTranslationPool(value,fetch,{provider,budgets:quotaBudgets,geminiCooldowns});
  const [gemini]=connectionKeys(value,'gemini');
  if(gemini && (pool.provider==='gemini' || !previous || gemini!==connectionKeys(previous,'gemini')[0]))await checkGeminiKey(gemini);
  return pool;
}

function connect(value,version,pool) {
  if(version!==authVersion)return;
  connection=value;editingConnection=null;translationPool=pool;service?.reset();selectionCache.clear();
  service=new PreparationClient({configured:true,model:pool.model,prompt_version:PROMPT_VERSION,concurrency:pool.concurrency},pool.prepare,preparationChanged);
  clearSecrets();authStatus();notice('');
  showSessionControls();
  screen(resumeScreen);
  if(resumeScreen==='reader-screen' && documentData){prepareVisible();if(pdfReader)queuePdfPages();}
  else if(resumeScreen==='import-screen')$('paste').focus();
}

function showSessionControls() {
  $('session-controls').hidden=false;
  $('session-label').textContent=account.user?.username || '';
  $('disconnect').textContent=account.user?'Log out':'Disconnect';
}

async function connectSaved(value,version) {
  const normalized=normalizeConnection(value);
  try {connect(normalized,version,await checkedPool(normalized));}
  catch(error){
    if(version!==authVersion)return;
    showSessionControls();authMode('key');fillKeyForm(normalized);authStatus(error.message);
  }
}

for(const button of document.querySelectorAll('[data-auth-mode]'))button.addEventListener('click',()=>{clearSecrets();authMode(button.dataset.authMode);});

async function authenticate(event,operation) {
  event.preventDefault();const version=++authVersion;authBusy(true);authStatus('Connecting…');
  try {await operation(version);}
  catch(error){if(version===authVersion)authStatus(error.message || 'Could not connect. Please try again.');}
  finally {
    if(version===authVersion){
      for(const id of ['login-password','signup-password','signup-password-confirm'])$(id).value='';
      for(const input of document.querySelectorAll('.key-row input'))input.type='password';
      $('signup-password-confirm').setCustomValidity('');authBusy(false);
    }
  }
}

$('api-key-form').addEventListener('submit',event=>authenticate(event,async version=>{
  const value=keyFormValue('api-key');
  const provider=$('translation-provider-choice').hidden?undefined:$('translation-provider').value;
  const pool=await checkedPool(value,provider,editingConnection);
  if(version!==authVersion)return;
  if(account.user && $('save-key').checked)await account.saveApiKey(vaultValue(value));
  connect(value,version,pool);
}));
$('login-form').addEventListener('submit',event=>authenticate(event,async version=>{
  const result=await account.login($('login-email').value,$('login-password').value);
  if(version!==authVersion)return;
  if(result.apiKey)return connectSaved(result.connection || result.apiKey,version);
  else {authMode('key');authStatus(result.vaultLocked?'The saved key could not be unlocked. Enter an API key to replace it.':'Enter your translation API key.');}
}));
function validatePasswordConfirmation() {
  $('signup-password-confirm').setCustomValidity($('signup-password').value===$('signup-password-confirm').value?'':'Passwords do not match.');
}
for(const id of ['signup-password','signup-password-confirm'])$(id).addEventListener('input',validatePasswordConfirmation);
$('signup-form').addEventListener('submit',event=>authenticate(event,async version=>{
  if($('signup-password').value!==$('signup-password-confirm').value)throw new Error('Passwords do not match.');
  const value=keyFormValue('signup-key');
  const pool=await checkedPool(value);
  if(version!==authVersion)return;
  const result=await account.signUp($('signup-email').value,$('signup-password').value,vaultValue(value));
  if(version!==authVersion)return;
  if(result.confirmationRequired){clearSecrets();authStatus('Username accounts require email confirmation to be disabled in Supabase.');}
  else if(result.apiKey)connect(value,version,pool);
  else {authMode('key');authStatus('Enter your translation API key.');}
}));
$('change-key').addEventListener('click',()=>{
  const previous=connection || editingConnection,provider=translationPool?.provider;
  resumeScreen=screens.find(name=>name!=='auth-screen' && !$(name).hidden) || resumeScreen;
  authVersion++;importVersion++;catalogueVersion++;service?.reset();connection=null;translationPool=null;hideTooltip();notice('');
  if(!documentData || (pdfReader && !pdfReader.document)){
    documentData=null;wordElements=[];reader.replaceChildren();closePdf();
  }
  screen('auth-screen');clearSecrets();authMode('key');authBusy(false);$('api-key').focus();
  if(previous)fillKeyForm(previous,provider);
});
$('disconnect').addEventListener('click',()=>{
  usernameVersion++;clearTimeout(usernameTimer);$('username-suggestion').hidden=true;$('username-status').hidden=true;
  const version=++authVersion;importVersion++;catalogueVersion++;service?.reset();service=null;connection=null;editingConnection=null;translationPool=null;
  resumeScreen='import-screen';
  selectionCache.clear();documentData=null;documentName='';wordElements=[];closePdf();reader.replaceChildren();readerChrome();
  for(const id of ['paste','preview-text','file-input','login-email','signup-email'])$(id).value='';
  clearSecrets();$('paste').dispatchEvent(new Event('input'));notice('');screen('auth-screen');$('session-controls').hidden=true;
  const logout=account.logout();authMode('key');authBusy(false);
  logout.catch(()=>{if(version===authVersion)authStatus('Disconnected locally. The account provider could not be reached.');});
});
authBusy(false);
// Confirmation links may carry provider tokens. This app requires an explicit login.
if(location.hash.includes('access_token=') || location.hash.includes('error='))history.replaceState(null,'',location.pathname+location.search);

function preparationChanged() {
  if(!service)return;
  const status=service.status(),progress=$('preparation-progress');
  progress.closest('.preparation-strip').hidden=!status.error && !status.discovering && !status.running && status.ready===status.total;
  position();
  progress.max=status.total || 1;progress.value=status.ready;
  $('preparation-status').textContent=status.error?`Preparation paused: ${status.error}`:
    status.waiting?`Waiting for token allowance · ${status.ready.toLocaleString()} / ${status.total.toLocaleString()} words`:
    status.ready===status.total && !status.discovering?`Meanings ready · ${status.ready.toLocaleString()} words`:
      `Preparing meanings · ${status.ready.toLocaleString()} / ${status.total.toLocaleString()} words${status.discovering?' · reading PDF pages…':''}`;
  $('retry-preparation').hidden=!status.error || !service.config.configured;
  if(currentTarget && documentData && anchor?.isConnected && tooltip.classList.contains('loading')){
    const target=currentTarget;
    const paragraph=paragraphFor(target.element);
    if(paragraph && (pinned || target.element.matches(':hover')) && service.get(paragraph,target.start,target.end,$('language').value))lookup(target.element,target.start,target.end,target.keepOpen);
  }
}

function prepareVisible() {
  if(!documentData || !service)return;
  const paper=$('reader-paper').getBoundingClientRect();
  let visible,top=Infinity,left=Infinity;
  for(const word of wordElements){
    const rect=word.getBoundingClientRect();
    if(rect.bottom<=Math.max(0,paper.top) || rect.top>=Math.min(innerHeight,paper.bottom) || rect.right<=paper.left || rect.left>=paper.right)continue;
    if(rect.top<top || (rect.top===top && rect.left<left)){visible=word;top=rect.top;left=rect.left;}
    if(!reader.classList.contains('pdf-mode'))break;
  }
  const paragraph=visible?paragraphFor(visible):documentData.paragraphs[0];
  const index=documentData.paragraphs.indexOf(paragraph);
  const ordered=index>0?[...documentData.paragraphs.slice(index),...documentData.paragraphs.slice(0,index)]:documentData.paragraphs;
  service.prioritize(ordered,$('language').value,paragraph?{paragraph,start:Number(visible?.dataset.start || 0)}:null);
}

async function queuePdfPages(viewer=pdfReader) {
  if(!viewer?.document)return;
  const version=++catalogueVersion,language=$('language').value;
  service.discovering=true;preparationChanged();
  const count=viewer.document.numPages,start=viewer.page;
  for(let offset=0;offset<count;offset++){
    if(version!==catalogueVersion || viewer!==pdfReader)return;
    try {
      const {data}=await viewer.pageData((start-1+offset)%count+1,text=>importRequest(text));
      if(version!==catalogueVersion || viewer!==pdfReader)return;
      service.enqueue(data.paragraphs,language);
      await new Promise(resolve=>setTimeout(resolve,0));
    } catch(error) {
      if(version!==catalogueVersion || viewer!==pdfReader)return;
      notice('A PDF page could not be prepared. Other readable pages will continue.',true);
    }
  }
  if(version===catalogueVersion){service.discovering=false;preparationChanged();}
}

function notice(text = '',error = false) {
  $('app-status').textContent = text;
  $('app-status').hidden = !text;
  $('app-status').classList.toggle('error',error);
}

function screen(id) {
  screens.forEach(name => $(name).hidden = name !== id);
  hideTooltip();
  hideSelectionActions();
}

function hideSelectionActions() {
  selectionActions.hidden=true;
  selectionTarget=null;
}

function hideTooltip() {
  selectionController?.abort();selectionController=null;
  tooltip.classList.remove('loading');
  clearTimeout(closeTimer);
  pinned = false;
  tooltip.hidden = true;
  anchor = null;
  currentTarget = null;
  $('lookup-status').hidden=true;
  reader.querySelectorAll('.active').forEach(el => el.classList.remove('active'));
  reader.querySelectorAll('[aria-describedby]').forEach(el => {el.removeAttribute('aria-describedby');el.removeAttribute('aria-busy');});
}

function position() {
  if (!anchor || tooltip.hidden) return;
  const rect = anchor.getClientRects()[0] || anchor.getBoundingClientRect();
  const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
  tooltip.style.left = `${Math.max(12,Math.min(rect.left+(rect.width-width)/2,window.innerWidth-width-12))}px`;
  const above = rect.top-height-6;
  tooltip.style.top = `${Math.max(8,above>=8?above:Math.min(rect.bottom+6,window.innerHeight-height-8))}px`;
}

function paragraphFor(element) {
  return documentData.paragraphs[Number(element.dataset.paragraph)];
}

function lookup(element,start,end,keepOpen=false) {
  hideTooltip();
  pinned = keepOpen; anchor = element;
  currentTarget = {element,start,end,keepOpen};
  const paragraph = paragraphFor(element);
  if(!paragraph || !service)return;
  $('translation-text').textContent = '';
  $('translation-text').lang = $('language').value;
  element.setAttribute('aria-describedby','translation-text');
  const result=service.get(paragraph,start,end,$('language').value);
  if(!result){
    $('translation-text').textContent='...';tooltip.classList.add('loading');tooltip.hidden=false;position();return;
  }
  $('translation-text').textContent=result.translation;tooltip.hidden=false;
  for(const word of reader.querySelectorAll(`.word[data-paragraph="${paragraph.id}"]`)){
    if(result.highlights.some(h=>Number(word.dataset.start)===h.start && Number(word.dataset.end)===h.end))word.classList.add('active');
  }
  position();
}

function lookupWord(word,keepOpen=false) {
  return lookup(word,Number(word.dataset.start),Number(word.dataset.end),keepOpen);
}

function highlightKey(word) {
  const {paragraph,start,end}=word.dataset;
  return `${paragraph}:${start}:${end}`;
}

function showHighlights() {
  const marks=highlights.get(documentData);
  if(!marks)return;
  for(const word of wordElements){
    const color=marks.get(highlightKey(word));
    if(color)word.dataset.highlight=color;
    else delete word.dataset.highlight;
  }
}

function render() {
  const fragment = document.createDocumentFragment();
  wordElements = [];
  for (const paragraph of documentData.paragraphs) {
    const p = document.createElement('p'); p.dataset.paragraph = paragraph.id;
    const chars = Array.from(paragraph.text);
    let cursor = 0;
    for (const word of paragraph.words) {
      p.append(document.createTextNode(chars.slice(cursor,word.start).join('')));
      const span = document.createElement('span');
      span.className = 'word'; span.textContent = word.text;
      span.dataset.start = word.start; span.dataset.end = word.end;
      span.dataset.paragraph = paragraph.id;
      span.dataset.index = wordElements.length;
      span.tabIndex = wordElements.length ? -1 : 0;
      p.append(span); wordElements.push(span); cursor = word.end;
    }
    p.append(document.createTextNode(chars.slice(cursor).join('')));
    fragment.append(p);
  }
  reader.replaceChildren(fragment);
  showHighlights();
  readerChrome();
  $('document-meta').textContent = `${documentName || 'Pasted text'} · ${wordElements.length.toLocaleString()} words · Danish`;
  screen('reader-screen');
  window.scrollTo(0,0);
  prepareVisible();
}

function readerChrome() {
  const original = pdfReader && $('reading-mode').value==='pdf';
  const image=pdfReader instanceof ImageReader;
  $('reading-mode').options[0].textContent=image?'Original image':'Original PDF';
  $('pdf-controls').querySelector('.page-controls').hidden=image;
  $('reading-mode-control').hidden=!pdfReader;
  $('font-size-control').hidden=!!original;
  $('edit-document').hidden=!!original;
  $('pdf-controls').hidden=!original;
  $('end-mark').hidden=!!original;
  reader.classList.toggle('pdf-mode',!!original);
  $('reader-paper').classList.toggle('pdf-mode',!!original);
}

async function closePdf() {
  catalogueVersion++;
  $('ocr-status').textContent='';$('ocr-status').hidden=true;
  const previous=pdfReader;pdfReader=null;pdfTextData=null;
  if(previous)await previous.destroy().catch(()=>{});
}

async function showPdfPage(number=pdfReader?.page || 1) {
  const viewer=pdfReader;
  if(!viewer?.document || $('reading-mode').value!=='pdf')return;
  const version=++importVersion;
  number=Math.max(1,Math.min(viewer.document.numPages,Math.trunc(Number(number))||1));
  hideTooltip();hideSelectionActions();notice('Loading page…');
  try {
    const result=await viewer.show(number,$('pdf-zoom').value,$('reader-paper').clientWidth,text=>importRequest(text));
    if(!result || version!==importVersion || viewer!==pdfReader)return;
    hideTooltip();hideSelectionActions();
    documentData=result.data;
    reader.replaceChildren(result.element);
    wordElements=[...reader.querySelectorAll('.word')];
    wordElements.forEach((word,index)=>{word.dataset.index=index;word.tabIndex=index?-1:0;});
    showHighlights();
    $('pdf-page').value=number;$('pdf-page').max=viewer.document.numPages;
    $('pdf-page-count').textContent=`of ${viewer.document.numPages}`;
    $('pdf-previous').disabled=number===1;
    $('pdf-next').disabled=number===viewer.document.numPages;
    $('document-meta').textContent=documentName;
    const warnings=result.warnings || result.data.warnings || [];
    notice(warnings.join(' ') || (wordElements.length?'':'No readable text was found on this page. Try recognizing it again.'));
    prepareVisible();
  } catch(error) {
    if(version!==importVersion || viewer!==pdfReader)return;
    notice(error.message || 'Could not render this PDF page. Try the text view.',true);
  }
}

async function openPdf(file) {
  const image=/\.(png|jpe?g|webp)$/i.test(file.name);
  const version=++importVersion;busy(true);hideTooltip();notice(image?'Opening image…':'Opening PDF…');
  await closePdf();
  if(version!==importVersion)return;
  const Viewer=image?ImageReader:PdfReader;
  const viewer=new Viewer(file,{onProgress:message=>{
    if(viewer!==pdfReader)return;
    $('ocr-status').textContent=message;$('ocr-status').hidden=!message;
  }});pdfReader=viewer;documentName=file.name;
  try {
    await viewer.open();
    if(version!==importVersion || viewer!==pdfReader)return;
    service.reset();
    $('reading-mode').value='pdf';$('pdf-zoom').value='fit';
    reader.replaceChildren();readerChrome();screen('reader-screen');
    await showPdfPage(1);
    if(viewer===pdfReader)queuePdfPages(viewer);
  } catch(error) {
    if(viewer!==pdfReader || viewer.destroyed)return;
    await closePdf();readerChrome();screen('import-screen');
    notice(error.name==='PasswordException'?'This PDF is encrypted. Open an unencrypted copy instead.':image?(error.message || 'Could not open this image. Choose a PNG, JPEG or WebP file.'):'Could not open this PDF. It may be damaged or use an unsupported format.',true);
  } finally {busy(false);}
}

$('pdf-previous').addEventListener('click',()=>showPdfPage(pdfReader.page-1));
$('pdf-next').addEventListener('click',()=>showPdfPage(pdfReader.page+1));
$('pdf-page').addEventListener('change',event=>showPdfPage(event.target.value));
$('pdf-zoom').addEventListener('change',()=>showPdfPage());
$('recognize-page').addEventListener('click',async()=>{
  const viewer=pdfReader,number=viewer?.page;
  if(!viewer?.document)return;
  const version=++importVersion;hideTooltip();hideSelectionActions();$('recognize-page').disabled=true;notice('');
  try{
    await viewer.forceOcr(number,text=>importRequest(text));
    if(viewer!==pdfReader || version!==importVersion)return;
    pdfTextData=null;
    await showPdfPage(number);
    if(viewer===pdfReader)queuePdfPages(viewer);
  }catch(error){if(viewer===pdfReader && version===importVersion)notice(error.message || 'Recognition failed. Try again.',true);}
  finally{$('recognize-page').disabled=false;}
});
$('reading-mode').addEventListener('change',async()=>{
  hideTooltip();hideSelectionActions();
  if($('reading-mode').value==='pdf'){readerChrome();await showPdfPage();return;}
  const viewer=pdfReader,version=++importVersion;
  $('pdf-controls').hidden=true;
  if(pdfTextData){documentData=pdfTextData;notice('');render();return;}
  notice('Preparing text view…');
  try {
    const text=await viewer.extractedText();
    const data=await importRequest(text);
    if(version!==importVersion || viewer!==pdfReader)return;
    pdfTextData=data;documentData=data;notice('');render();
  } catch(error) {
    if(version!==importVersion || viewer!==pdfReader)return;
    $('reading-mode').value='pdf';readerChrome();notice(error.message,true);
  }
});

async function importRequest(body,isFile=false) {
  return isFile ? extractFile(body.get('file')) : importText(body);
}

function busy(value) {
  ['prepare','file-input','start-reading','sample'].forEach(id => $(id).disabled = value);
}

async function prepare(body,name='',isFile=false) {
  const version = ++importVersion;
  busy(true); notice('');
  try {
    const result = await importRequest(body,isFile);
    if (version !== importVersion) return;
    await closePdf();
    if(version!==importVersion)return;
    documentName = name; documentData = result;
    $('preview-text').value = result.text;
    updatePreviewCount();
    $('import-warnings').replaceChildren(...result.warnings.map(message => {const li=document.createElement('li');li.textContent=message;return li;}));
    $('import-warnings').hidden = !result.warnings.length;
    screen('preview-screen');
    $('preview-text').focus();
  } catch(error) { if(version===importVersion)notice(error.message || 'Could not import this text.',true); }
  finally { busy(false); }
}

function updatePreviewCount() { $('preview-count').textContent = `${Array.from($('preview-text').value).length.toLocaleString()} / 200,000 characters`; }
$('preview-text').addEventListener('input',updatePreviewCount);
$('paste').addEventListener('input',() => $('paste-count').textContent = `${Array.from($('paste').value).length.toLocaleString()} characters`);
$('import-form').addEventListener('submit',event => {event.preventDefault();prepare($('paste').value);});
$('file-input').addEventListener('change',event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 10*1024*1024) {notice('Choose a file no bigger than 10 MiB.',true);event.target.value='';return;}
  const data = new FormData();data.append('file',file);
  if(/\.(pdf|png|jpe?g|webp)$/i.test(file.name))openPdf(file);
  else prepare(data,file.name,true);
  event.target.value = '';
});
$('sample').addEventListener('click',() => {
  $('paste').value = 'En stille morgen\n\nSolen skinner gennem vinduet, og duften af kaffe fylder køkkenet. Sofie sætter sig ved bordet med en bog. Der er et ord, hun ikke kender, så hun slår det op.\n\n"Skal vi gå en tur nu eller senere?" spørger hendes bror.\n\n"Det er lige meget," siger hun og smiler. "Jeg har god tid i dag."';
  $('paste').dispatchEvent(new Event('input'));$('paste').focus();
});
$('start-reading').addEventListener('click',async () => {
  const version = ++importVersion;busy(true);notice('');
  try {
    const result = await importRequest($('preview-text').value);
    if(version!==importVersion)return;
    service.reset();
    if(documentData?.text!==result.text)documentData=result;
    if(pdfReader)pdfTextData=documentData;
    render();
    if(pdfReader)queuePdfPages(pdfReader);
  } catch(error) {notice(error.message || 'Could not import this text.',true);}
  finally {busy(false);}
});
$('cancel-preview').addEventListener('click',() => {importVersion++;screen('import-screen');});
$('edit-document').addEventListener('click',() => {
  catalogueVersion++;service?.reset();
  $('preview-text').value=documentData.text;updatePreviewCount();screen('preview-screen');
});
$('new-document').addEventListener('click',() => {
  importVersion++;service?.reset();selectionCache.clear();documentData=null;documentName='';wordElements=[];
  closePdf();readerChrome();
  reader.replaceChildren();$('paste').value='';$('preview-text').value='';$('file-input').value='';
  $('paste').dispatchEvent(new Event('input'));notice('');screen('import-screen');$('paste').focus();
});
$('language').addEventListener('change',() => {
  const target = currentTarget;
  prepareVisible();
  if(pdfReader)queuePdfPages();
  if (target) lookup(target.element,target.start,target.end,target.keepOpen);
  else hideTooltip();
});
$('font-size').addEventListener('input',event => {document.documentElement.style.setProperty('--reader-size',`${event.target.value}px`);position();});

reader.addEventListener('pointerover',event => {
  const word=event.target.closest('.word');
  if(!word || word.contains(event.relatedTarget) || pinned || !window.getSelection().isCollapsed)return;
  hideTooltip();
  lookupWord(word);
});
reader.addEventListener('pointerout',event => {
  const word=event.target.closest('.word');
  if(!word || word.contains(event.relatedTarget) || pinned)return;
  if(tooltip.contains(event.relatedTarget))return;
  closeTimer=setTimeout(hideTooltip,180);
});
tooltip.addEventListener('pointerenter',() => clearTimeout(closeTimer));
tooltip.addEventListener('pointerleave',() => {if(!pinned)closeTimer=setTimeout(hideTooltip,180);});
reader.addEventListener('click',event => {
  const word=event.target.closest('.word');
  if(word && window.getSelection().isCollapsed)lookupWord(word,true);
});
reader.addEventListener('focus',() => {wordElements[0]?.focus({preventScroll:true});});
reader.addEventListener('keydown',event => {
  const word=event.target.closest('.word');
  if(!word)return;
  if(['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) {
    event.preventDefault();
    const current=Number(word.dataset.index);
    const next=event.key==='Home'?0:event.key==='End'?wordElements.length-1:Math.max(0,Math.min(wordElements.length-1,current+(event.key==='ArrowRight'?1:-1)));
    word.tabIndex=-1;wordElements[next].tabIndex=0;wordElements[next].focus();
    if(!pinned)hideTooltip();
  } else if(event.key==='Enter' || event.key===' ') {event.preventDefault();lookupWord(word,true);}
});
document.addEventListener('keydown',event => {if(event.key==='Escape'){hideTooltip();hideSelectionActions();window.getSelection().removeAllRanges();}});

function captureSelection() {
  const selection=window.getSelection();
  hideSelectionActions();
  if($('reader-screen').hidden || selection.isCollapsed || !selection.rangeCount)return;
  const range=selection.getRangeAt(0);
  const selected=wordElements.filter(word => range.intersectsNode(word));
  if(!selected.length)return;
  const across=selected[0].dataset.paragraph!==selected.at(-1).dataset.paragraph;
  hideTooltip();
  const target={selected,element:selected[0],start:Number(selected[0].dataset.start),end:Number(selected.at(-1).dataset.end)};
  if(across){
    const text=selection.toString().trim(),tokens=words(text);
    if(!tokens.length)return;
    Object.assign(target,{start:tokens[0].start,end:tokens.at(-1).end,paragraph:{text,words:tokens}});
  }
  selectionTarget=target;
  $('selection-clear-highlight').hidden=!selected.some(word=>word.dataset.highlight);
  const rect=range.getBoundingClientRect();
  selectionActions.hidden=false;
  selectionActions.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-selectionActions.offsetWidth-12))}px`;
  selectionActions.style.top=`${Math.max(12,Math.min(rect.bottom+8,window.innerHeight-selectionActions.offsetHeight-12))}px`;
}
reader.addEventListener('mouseup',captureSelection);
reader.addEventListener('touchend',()=>requestAnimationFrame(captureSelection),{passive:true});
reader.addEventListener('keyup',event => {if(event.shiftKey)captureSelection();});
selectionActions.addEventListener('pointerdown',event=>event.preventDefault());
$('selection-translate').addEventListener('click',() => {
  if(!selectionTarget)return;
  const {element,start,end,paragraph:selectionParagraph}=selectionTarget;
  hideSelectionActions();window.getSelection().removeAllRanges();
  const paragraph=paragraphFor(element);
  if(!selectionParagraph && service.get(paragraph,start,end,$('language').value))lookup(element,start,end,true);
  else translateSelection(element,start,end,selectionParagraph);
});
function markSelection(color) {
  if(!selectionTarget)return;
  if(!highlights.has(documentData))highlights.set(documentData,new Map());
  const marks=highlights.get(documentData);
  for(const word of selectionTarget.selected){
    const key=highlightKey(word);
    if(color)marks.set(key,color);
    else marks.delete(key);
  }
  showHighlights();hideSelectionActions();window.getSelection().removeAllRanges();
}
$('selection-highlight').addEventListener('click',()=>markSelection(highlightColors.querySelector(':checked').value));
$('selection-clear-highlight').addEventListener('click',()=>markSelection());
document.addEventListener('pointerdown',event => {
  if(selectionActions.contains(event.target) || highlightColors.contains(event.target))return;
  if(!reader.contains(event.target)){
    hideSelectionActions();
    if(!tooltip.contains(event.target))hideTooltip();
  }
});
let visibleTimer;
function scrollTranslation() {
  hideSelectionActions();if(pinned)position();else hideTooltip();
  clearTimeout(visibleTimer);visibleTimer=setTimeout(()=>{if(!$('reader-screen').hidden)prepareVisible();},180);
}
window.addEventListener('scroll',scrollTranslation,{passive:true});
$('reader-paper').addEventListener('scroll',scrollTranslation,{passive:true});
window.addEventListener('resize',() => {
  position();clearTimeout(resizeTimer);
  if(pdfReader && $('reading-mode').value==='pdf' && $('pdf-zoom').value==='fit')resizeTimer=setTimeout(()=>showPdfPage(),120);
});
$('retry-preparation').addEventListener('click',()=>service?.retry());

async function translateSelection(element,start,end,selectionParagraph) {
  hideTooltip();pinned=true;anchor=element;
  const paragraph=selectionParagraph || paragraphFor(element),language=$('language').value,owner=service,pool=translationPool;
  let chunk;
  try {chunk=contextFor(paragraph,start,end);}catch(error){notice(error.message,true);return;}
  const {offset,...payload}=chunk;
  const key=JSON.stringify([paragraph.text,start,end,language,pool.model]);
  $('translation-text').lang=language;
  if(selectionCache.has(key)){$('translation-text').textContent=selectionCache.get(key);tooltip.hidden=false;position();return;}
  const controller=new AbortController();selectionController=controller;
  tooltip.classList.add('loading');$('translation-text').textContent='...';tooltip.hidden=false;position();
  owner.suspended=true;owner.manualRequest=controller;
  owner.yieldWaiting();
  try {
    while(owner.active || (pool.provider==='groq' && Date.now()<Math.max(owner.nextAt,owner.pausedUntil))){
      await new Promise(resolve=>setTimeout(resolve,100));
      if(controller.signal.aborted)return;
    }
    const started=Date.now();
    const response=await pool.selection('selection',{
      body:JSON.stringify({...payload,language}),signal:controller.signal});
    const result=await response.json();
    if(controller.signal.aborted || service!==owner || $('language').value!==language)return;
    if(!response.ok){
      if(response.status===429)owner.pausedUntil=Math.max(owner.pausedUntil,Date.now()+(Number(response.headers.get('Retry-After'))||60)*1000);
      throw new Error(result.detail);
    }
    owner.nextAt=Math.max(owner.nextAt,started+result.next_request_ms);
    const meaning=result.entries[0].translation;selectionCache.set(key,meaning);
    tooltip.classList.remove('loading');$('translation-text').textContent=meaning;position();
  }catch(error){
    if(!controller.signal.aborted){hideTooltip();notice(error.name==='TimeoutError'?'Translation timed out. Select the phrase to try again.':error.message,true);}
  }finally{if(owner.manualRequest===controller){owner.suspended=false;owner.manualRequest=null;owner.pump();}}
}
let usernameTimer,usernameVersion=0;
async function checkUsername() {
  const version=++usernameVersion,name=normalizeUsername($('signup-email').value);
  const suggestion=$('username-suggestion'),status=$('username-status');
  suggestion.hidden=true;status.hidden=true;
  try {
    if(name && validateUsername(name)){status.textContent=validateUsername(name);status.hidden=false;return;}
    if(name && await account.available(name)){if(version===usernameVersion){status.textContent='Available';status.hidden=false;}return;}
    const base=name || 'reader';
    const candidates=[...suggestUsernames(base),...Array.from({length:3},()=>base.slice(0,20)+'_'+crypto.getRandomValues(new Uint16Array(1))[0].toString().slice(-3))];
    for(const candidate of candidates){
      if(version!==usernameVersion)return;
      if(await account.available(candidate)){
        if(version!==usernameVersion)return;
        status.textContent=name?'Username taken.':'Choose a username.';status.hidden=false;
        suggestion.textContent=candidate;suggestion.hidden=false;return;
      }
    }
    if(version===usernameVersion){status.textContent='Try a different username.';status.hidden=false;}
  }catch(error){if(version===usernameVersion){status.textContent=error.message;status.hidden=false;}}
}
$('signup-email').addEventListener('input',()=>{
  usernameVersion++;clearTimeout(usernameTimer);$('username-suggestion').hidden=true;$('username-status').hidden=true;
  usernameTimer=setTimeout(checkUsername,300);
});
$('username-suggestion').addEventListener('click',()=>{$('signup-email').value=$('username-suggestion').textContent;$('signup-email').dispatchEvent(new Event('input'));});
document.querySelector('[data-auth-mode="signup"]').addEventListener('click',checkUsername);

async function restoreSignIn() {
  const version=++authVersion;authBusy(true);authStatus('Connecting…');
  try{
    const result=await account.restore();
    if(version!==authVersion)return;
    if(result?.apiKey)await connectSaved(result.connection || result.apiKey,version);
    else {authMode('key');if(result)authStatus('Enter your translation API key.');}
  }catch(error){if(version===authVersion){authMode('login');authStatus(error.message);}}
  finally{if(version===authVersion)authBusy(false);}
}
restoreSignIn();

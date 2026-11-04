import test from 'node:test';
import assert from 'node:assert/strict';
import * as documents from '../static/documents.js';

test('words use Python-compatible code point offsets and internal punctuation', () => {
  assert.deepEqual(documents.words("😀 Åse's blå-grønne ø’er 42_a"), [
    {id:0,text:"Åse's",start:2,end:7},
    {id:1,text:'blå-grønne',start:8,end:18},
    {id:2,text:'ø’er',start:19,end:23},
    {id:3,text:'42',start:24,end:26},
    {id:4,text:'a',start:27,end:28},
  ]);
});

test('import normalizes text and splits paragraphs without losing within-paragraph lines', () => {
  const result = documents.importText('\ufeff A\u030ase\r\nser\u00ad en ø.\r\n \t\r\nHej! \n');
  assert.equal(result.text, 'Åse\nser en ø.\n \t\nHej!');
  assert.deepEqual(result.paragraphs.map(p => [p.id,p.text,p.words.map(w=>w.id)]), [
    [0,'Åse\nser en ø.',[0,1,2,3]], [1,'Hej!',[0]],
  ]);
  assert.deepEqual(result.warnings, []);
});

test('imports reject invalid, empty, null-containing and oversized text', () => {
  for (const value of [null, 1, {}, undefined]) assert.throws(() => documents.importText(value), /text/i);
  assert.throws(() => documents.importText(' \n\t'), /readable text/i);
  assert.throws(() => documents.importText('a\0b'), /UTF-8 TXT/i);
  assert.throws(() => documents.importText('a'.repeat(documents.MAX_TEXT+1)), /200,000/);
  assert.equal(documents.importText('😀'.repeat(documents.MAX_TEXT)).text.length, documents.MAX_TEXT*2);
});

const file = (name, bytes) => ({name,size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
test('TXT imports support UTF-8, UTF-16 BOMs and Windows-1252 fallback', async () => {
  const utf8 = await documents.extractFile(file('DANSK.TXT',new TextEncoder().encode('\ufeffÆrlig ø')));
  assert.equal(utf8.text,'Ærlig ø');
  assert.deepEqual(utf8.warnings,[]);
  for (const bytes of [[0xff,0xfe,0xd8,0,0x20,0,0xe5,0],[0xfe,0xff,0,0xd8,0,0x20,0,0xe5]]) {
    assert.equal((await documents.extractFile(file('a.txt',bytes))).text,'Ø å');
  }
  const legacy = await documents.extractFile(file('a.txt',[0xc6,0x20,0xf8,0x20,0xe5]));
  assert.equal(legacy.text,'Æ ø å');
  assert.match(legacy.warnings[0],/Windows-1252/);
});

test('files reject unsupported types, damaged DOCX and file-size overflow', async () => {
  await assert.rejects(documents.extractFile(file('a.doc',[])),/Older .doc/);
  await assert.rejects(documents.extractFile(file('a.html',[])),/TXT.*DOCX/);
  await assert.rejects(documents.extractFile(file('a.docx',[1,2,3])),/damaged|unsupported/i);
  await assert.rejects(documents.extractFile({name:'a.txt',size:documents.MAX_FILE+1}),/10 MiB/);
  await assert.rejects(documents.extractFile(null),/file/i);
});

// Metadata-only ZIP: the guard must reject before trying to decompress anything.
test('DOCX central-directory guard rejects excessive expanded size and ZIP64', async () => {
  const archive = new Uint8Array(68), view = new DataView(archive.buffer);
  view.setUint32(0,0x02014b50,true);
  view.setUint32(24,50*1024*1024+1,true);
  view.setUint32(46,0x06054b50,true);
  view.setUint16(54,1,true);view.setUint16(56,1,true);
  view.setUint32(58,46,true);
  await assert.rejects(documents.extractFile(file('a.docx',archive)),/safe extraction limit/i);
  view.setUint32(24,0xffffffff,true);
  await assert.rejects(documents.extractFile(file('a.docx',archive)),/ZIP64|unsupported/i);
});

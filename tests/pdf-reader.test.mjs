import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfTextBlocks } from '../static/pdf-reader.js';

const item = (str,x,y,width=100,height=12) => ({str,transform:[height,0,0,height,x,y],width,height});

test('PDF text blocks keep two columns out of each other’s context', () => {
  const blocks=pdfTextBlocks([
    item('Det er lige meget.',40,700,120),item('Højre kolonne.',330,700,110),
    item('Jeg har god tid.',40,682,110),item('En anden historie.',330,682,125),
  ]);
  assert.equal(blocks.length,2);
  assert.equal(blocks[0].text,'Det er lige meget.\nJeg har god tid.');
  assert.equal(blocks[1].text,'Højre kolonne.\nEn anden historie.');
  assert.deepEqual(blocks[0].runs.map(r=>r.itemIndex),[0,2]);
});

test('PDF adjacent fragments form one word and keep original run offsets', () => {
  const blocks=pdfTextBlocks([item('ord',40,700,18),item('bog',58,700,18),item(' med æbler',76,700,72)]);
  assert.equal(blocks[0].text,'ordbog med æbler');
  assert.deepEqual(blocks[0].runs.map(r=>[r.start,r.end]),[[0,3],[3,6],[6,16]]);
});

test('PDF headings and separated paragraphs are distinct contexts', () => {
  const blocks=pdfTextBlocks([item('Overskrift',40,750,200,24),item('Første afsnit.',40,700),item('Næste afsnit.',40,630)]);
  assert.equal(blocks.length,3);
});

test('PDF Unicode and outer spaces retain codepoint mapping', () => {
  const blocks=pdfTextBlocks([item('  😀 Åse  ',40,700)]);
  assert.equal(blocks[0].text,'😀 Åse');
  assert.deepEqual(blocks[0].runs[0],{itemIndex:0,start:0,end:5,itemStart:2});
});

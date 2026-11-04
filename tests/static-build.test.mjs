import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,readdir,stat,writeFile,unlink} from 'node:fs/promises';

test('Pages artifact contains only public assets and relative entry points',async()=>{
  execFileSync(process.execPath,['scripts/build.mjs'],{stdio:'pipe'});
  const names=await readdir('dist');
  for(const privateFile of ['.env','app.py','tests','README.md','package.json'])assert.ok(!names.includes(privateFile));
  assert.ok(names.includes('.nojekyll'));
  const html=await readFile('dist/index.html','utf8');
  assert.match(html,/src="\.\/app.js"/);
  assert.doesNotMatch(html,/(?:href|src)="\/(?!\/)/);
  for(const name of ['app.js','accounts.js','documents.js','groq.js','reader.js','pdf-reader.js']){
    const code=await readFile(`dist/${name}`,'utf8');
    assert.doesNotMatch(code,/['"]\/api\//);
    assert.doesNotMatch(code,/['"]\/static\//);
    assert.doesNotMatch(code,/(?:localStorage|sessionStorage)\./);
  }
  assert.ok((await stat('dist/vendor/mammoth/mammoth.browser.min.js')).size>10000);
  assert.ok((await stat('dist/vendor/pdfjs/build/pdf.worker.min.mjs')).size>10000);
});

test('build rejects an accidentally embedded Groq credential before publishing',async()=>{
  const file='static/_build-secret-check.js';
  await writeFile(file,`export const leaked='${'gsk_'+'a'.repeat(40)}';`,{flag:'wx'});
  try {
    assert.throws(()=>execFileSync(process.execPath,['scripts/build.mjs'],{stdio:'pipe'}),
      error=>error.status!==0 && error.stderr.toString().includes('private key'));
    assert.ok(!(await readdir('dist')).includes('_build-secret-check.js'));
  } finally {await unlink(file);}
});

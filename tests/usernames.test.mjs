import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUsername,validateUsername,usernameEmail,usernameFromEmail,suggestUsernames} from '../static/usernames.js';

test('usernames normalize case and spaces but reject invalid characters and lengths',()=>{
  assert.equal(normalizeUsername(' Alice_2 '),'alice_2');
  assert.equal(validateUsername(' Alice_2 '),'');
  for (const value of ['ab','a'.repeat(25),'alice@example.com','alice smith','åse','alice-name','']) assert.ok(validateUsername(value));
  assert.equal(usernameEmail(' Alice_2 '),'alice_2@usernames.danskreader.invalid');
  assert.equal(usernameFromEmail('alice_2@usernames.danskreader.invalid'),'alice_2');
  assert.equal(usernameFromEmail('alice@example.com'),null);
  assert.equal(usernameFromEmail('alice@usernames.danskreader.invalid@evil.com'),null);
  assert.throws(()=>usernameEmail('alice smith'),/username/i);
});

test('small-variation suggestions stay valid, distinct, and close to the requested name',()=>{
  for (const username of ['alice','a'.repeat(24),'a'.repeat(23)+'1','reader_99']) {
    const suggestions=suggestUsernames(username);
    assert.equal(suggestions.length,3);
    assert.equal(new Set(suggestions).size,3);
    for (const candidate of suggestions) {
      assert.equal(validateUsername(candidate),'');
      assert.notEqual(candidate,username);
      assert.ok(candidate.startsWith(username.slice(0,20)));
    }
  }
  assert.deepEqual(suggestUsernames('bad name'),[]);
});

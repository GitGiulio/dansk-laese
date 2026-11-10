import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountClient } from '../static/accounts.js';

const config = {url:'https://example.supabase.co',publishableKey:'sb_publishable_test_public_key'};
const password = 'a long account password';
const alice = {id:'11111111-1111-4111-8111-111111111111',email:'alice@example.com'};
const bob = {id:'22222222-2222-4222-8222-222222222222',email:'bob@example.com'};
const response = (value,status=200) => new Response(status===204 ? null : JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});

function provider({confirmation=false,logoutError=false}={}) {
  const metadata = new Map(), passwords = new Map(), requests = [], registered = new Set();
  const fetcher = async (url,options={}) => {
    const target = new URL(url), headers = new Headers(options.headers);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({url:target,method:options.method || 'GET',headers,body});
    assert.equal(headers.get('apikey'),config.publishableKey);
    if (target.pathname==='/auth/v1/settings') return response({mailer_autoconfirm:!confirmation,external:{email:true}});
    if (target.pathname==='/rest/v1/rpc/username_available') {
      assert.equal(options.method,'POST');
      assert.deepEqual(Object.keys(body),['candidate']);
      return response(!registered.has(body.candidate));
    }
    if (target.pathname==='/auth/v1/token' && target.searchParams.get('grant_type')==='refresh_token') {
      assert.ok(body.refresh_token);assert.equal(body.password,undefined);
      return response({access_token:`token-${alice.id}`,refresh_token:'rotated-refresh-token',expires_in:3600,user:{...alice,user_metadata:metadata.get(alice.id) || {}}});
    }
    if (target.pathname==='/auth/v1/signup' || target.pathname==='/auth/v1/token') {
      assert.ok(body.email && body.password);
      const user = body.email.startsWith('bob@') ? bob : alice;
      if (target.pathname.endsWith('/signup')) {
        const username=body.email.split('@')[0];
        if (registered.has(username)) return response({message:'duplicate account'},422);
        registered.add(username);
        passwords.set(user.id,body.password);
        if (body.data) metadata.set(user.id,body.data);
      } else if (body.password !== (passwords.get(user.id) || password)) return response({message:'Invalid login credentials'},400);
      const account = {...user,email:body.email,user_metadata:metadata.get(user.id) || {}};
      if (target.pathname.endsWith('/signup') && confirmation) return response(account);
      return response({access_token:`token-${user.id}`,refresh_token:'unused-refresh-token',token_type:'bearer',expires_in:3600,user:account});
    }
    const token = headers.get('authorization');
    const user = token===`Bearer token-${alice.id}` ? alice : token===`Bearer token-${bob.id}` ? bob : null;
    assert.ok(user,'authenticated operations need the user bearer token');
    if (target.pathname==='/auth/v1/logout') return response(logoutError ? {message:'remote failure'} : null,logoutError ? 500 : 204);
    assert.equal(target.pathname,'/auth/v1/user');
    if(options.method==='GET')return response({...user,user_metadata:metadata.get(user.id) || {}});
    assert.equal(options.method,'PUT');
    assert.deepEqual(Object.keys(body),['data']);
    assert.deepEqual(Object.keys(body.data),['dansk_vault']);
    metadata.set(user.id,{...metadata.get(user.id),...body.data});
    return response({...user,user_metadata:metadata.get(user.id)});
  };
  return {fetcher,metadata,passwords,requests,registered};
}

function rememberedStorage() {
  let record=null;
  return {get:async()=>structuredClone(record),set:async value=>{record=structuredClone(value);},remove:async()=>{record=null;}};
}

test('remembered sign-in restores saved keys without storing password or plaintext API keys',async()=>{
  const server=provider(),storage=rememberedStorage(),client=new AccountClient(config,server.fetcher,{storage});
  await client.login(alice.email,password);await client.saveApiKey({keys:['gsk_secret_one','gsk_secret_two'],independent:true});
  const record=await storage.get();assert.equal(record.key.extractable,false);
  assert.ok(!JSON.stringify(record).includes(password));assert.ok(!JSON.stringify(record).includes('gsk_secret'));
  const fresh=new AccountClient(config,server.fetcher,{storage});
  assert.deepEqual((await fresh.restore()).connection,{keys:['gsk_secret_one','gsk_secret_two'],independent:true});
  await fresh.logout();assert.equal(await storage.get(),null);
  assert.equal(await new AccountClient(config,server.fetcher,{storage}).restore(),null);
});

test('expired remembered access tokens refresh and rotate before restoring legacy vaults',async()=>{
  const server=provider(),storage=rememberedStorage(),client=new AccountClient(config,server.fetcher,{storage});
  await client.login(alice.email,password);await client.saveApiKey('gsk_legacy');
  const record=await storage.get();record.expiresAt=0;await storage.set(record);
  const fresh=new AccountClient(config,server.fetcher,{storage});
  assert.equal((await fresh.restore()).apiKey,'gsk_legacy');
  assert.equal((await storage.get()).refreshToken,'rotated-refresh-token');
  assert.ok(server.requests.some(request=>request.url.searchParams.get('grant_type')==='refresh_token'));
});

test('revoked remembered sessions are removed and cannot restore account or keys',async()=>{
  const server=provider(),storage=rememberedStorage(),client=new AccountClient(config,server.fetcher,{storage});
  await client.login(alice.email,password);await client.saveApiKey('gsk_secret');
  const fresh=new AccountClient(config,async()=>response({},401),{storage});
  await assert.rejects(fresh.restore(),/denied|sign in|session/i);
  assert.equal(fresh.user,null);assert.equal(await storage.get(),null);
});

test('temporary account outages keep remembered credentials for the next refresh',async()=>{
  const server=provider(),storage=rememberedStorage(),client=new AccountClient(config,server.fetcher,{storage});
  await client.login(alice.email,password);await client.saveApiKey('gsk_secret');
  const fresh=new AccountClient(config,async()=>response({},503),{storage});
  await assert.rejects(fresh.restore(),/temporarily unavailable/);
  assert.ok(await storage.get());
  assert.equal((await new AccountClient(config,server.fetcher,{storage}).restore()).apiKey,'gsk_secret');
});

test('logout while restore is pending cannot resurrect remembered access',async()=>{
  const server=provider(),storage=rememberedStorage(),client=new AccountClient(config,server.fetcher,{storage});
  await client.login(alice.email,password);await client.saveApiKey('gsk_secret');
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
  const fresh=new AccountClient(config,async(...args)=>{started();await gate;return server.fetcher(...args);},{storage});
  const restoring=fresh.restore();await ready;await fresh.logout();release();
  await assert.rejects(restoring,/cancel|changed/);assert.equal(fresh.user,null);assert.equal(await storage.get(),null);
});

test('a key save waiting for refresh cannot write into a subsequently logged-in account',async()=>{
  const server=provider(),storage=rememberedStorage();
  const client=new AccountClient(config,async(url,options)=>{
    const result=await server.fetcher(url,options);
    if(url.includes('grant_type=password') && JSON.parse(options.body).email===alice.email){
      const session=await result.json();session.expires_in=-1;return response(session);
    }
    return result;
  },{storage});
  await client.login(alice.email,password);
  let release,started;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
  const set=storage.set;let block=true;
  storage.set=async record=>{if(block){block=false;started();await gate;}return set(record);};
  const saving=assert.rejects(client.saveApiKey('gsk_from_previous_account'),/cancel|changed/);
  await ready;const logout=client.logout(),login=client.login(bob.email,password);
  for(let i=0;i<200 && client.user?.id!==bob.id;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(client.user?.id,bob.id);release();await Promise.all([saving,logout,login]);
  assert.ok(server.requests.every(request=>request.method!=='PUT'));
});

test('missing, privileged, or unsafe browser configuration cannot make requests',async()=>{
  const jwt = role => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({role})).toString('base64url')}.signature`;
  for (const settings of [{},{...config,publishableKey:'sb_secret_private'},{...config,publishableKey:jwt('service_role')},{...config,url:'http://example.supabase.co'},{...config,url:'https://example.supabase.co.evil.com'},{...config,url:'https://example.supabase.co/private'}]) {
    let calls=0;
    const client = new AccountClient(settings,async()=>{calls++;throw new Error('unexpected request');});
    assert.equal(client.configured,false);
    await assert.rejects(client.login(alice.email,password),/configur/i);
    assert.equal(calls,0);
  }
  assert.equal(new AccountClient({...config,publishableKey:jwt('anon')}).configured,true);
});

test('Auth errors expose safe actionable codes without leaking provider response contents',async()=>{
  for(const [code,expected] of [['email_address_invalid',/internal.*identifier/i],['validation_failed',/validation_failed/],['weak_password',/stronger password/i],['signup_disabled',/disabled/i],['captcha_failed',/CAPTCHA/],['user_already_exists',/already taken/i]]){
    const client=new AccountClient(config,async()=>response({code:400,error_code:code,msg:'PRIVATE PASSWORD AND KEY'},400));
    await assert.rejects(client.login('reader_123',password),error=>expected.test(error.message) && !/PRIVATE PASSWORD AND KEY/.test(error.message));
  }
});

test('disabled Email provider is detected before sending signup',async()=>{
  const client=new AccountClient(config,async(url)=>{
    if(url.includes('username_available'))return response(true);
    if(url.includes('/settings'))return response({mailer_autoconfirm:true,external:{email:false}});
    assert.fail('Signup must not be sent to a disabled provider');
  });
  await assert.rejects(client.signUp('new_reader',password),/Enable the Email provider/);
});

test('encrypted vault survives a fresh login without sending plaintext to storage',async()=>{
  const server=provider(), client=new AccountClient(config,server.fetcher);
  assert.deepEqual(await client.login(alice.email,password),{user:alice,apiKey:null});
  await client.saveApiKey('gsk_private_groq_key');
  const first=structuredClone(server.metadata.get(alice.id).dansk_vault);
  assert.equal(first.version,1);
  assert.equal(Buffer.from(first.salt,'base64').length,16);
  assert.equal(Buffer.from(first.iv,'base64').length,12);
  assert.ok(!JSON.stringify(first).includes('gsk_private_groq_key'));
  assert.ok(!JSON.stringify(first).includes(password));
  await client.saveApiKey('gsk_private_groq_key');
  assert.notEqual(server.metadata.get(alice.id).dansk_vault.iv,first.iv);
  assert.notEqual(server.metadata.get(alice.id).dansk_vault.ciphertext,first.ciphertext);
  await client.logout();
  assert.equal(client.user,null);
  const fresh=new AccountClient(config,server.fetcher);
  assert.equal(fresh.user,null);
  const before=structuredClone(server.metadata.get(alice.id)),requestCount=server.requests.length;
  assert.deepEqual(await fresh.login(alice.email,password),{user:alice,apiKey:'gsk_private_groq_key'});
  assert.deepEqual(server.metadata.get(alice.id),before,'legacy vaults are not rewritten during login');
  assert.ok(server.requests.slice(requestCount).every(request=>request.method!=='PUT'));
});

test('multiple keys and quota preference survive encrypted account storage and fresh login',async()=>{
  const server=provider(),client=new AccountClient(config,server.fetcher);
  const connection={keys:['gsk_private_one','gsk_private_two'],independent:true};
  await client.signUp('alice',password,connection);
  const record=server.metadata.get(alice.id).dansk_vault;
  assert.equal(record.version,2);
  assert.ok(!JSON.stringify(record).includes('gsk_private'));
  await client.logout();
  const fresh=new AccountClient(config,server.fetcher);
  const result=await fresh.login('alice',password);
  assert.deepEqual(result.connection,connection);assert.equal(result.apiKey,connection.keys[0]);
  await fresh.saveApiKey({keys:['gsk_replacement'],independent:false});
  assert.deepEqual((await fresh.login('alice',password)).connection,{keys:['gsk_replacement'],independent:false});
});

test('invalid managed-auth password cannot overwrite or unlock a saved key',async()=>{
  const server=provider(), client=new AccountClient(config,server.fetcher);
  await client.login(alice.email,password);
  await client.saveApiKey('gsk_original');
  const saved=structuredClone(server.metadata.get(alice.id));
  await assert.rejects(client.login(alice.email,'wrong password'),/account request/i);
  assert.equal(client.user,null);
  await assert.rejects(client.saveApiKey('gsk_replacement'),/sign in|log in/i);
  assert.deepEqual(server.metadata.get(alice.id),saved);
});

test('password recovery preserves the locked vault until explicitly replaced',async()=>{
  const server=provider(), client=new AccountClient(config,server.fetcher);
  await client.login(alice.email,password);
  await client.saveApiKey('gsk_original');
  const saved=structuredClone(server.metadata.get(alice.id));
  server.passwords.set(alice.id,'new account password');
  assert.deepEqual(await client.login(alice.email,'new account password'),{user:alice,apiKey:null,vaultLocked:true});
  assert.deepEqual(server.metadata.get(alice.id),saved);
  assert.deepEqual(client.user,alice);
  await client.saveApiKey('gsk_replacement');
  assert.notDeepEqual(server.metadata.get(alice.id),saved);
  assert.equal((await client.login(alice.email,'new account password')).apiKey,'gsk_replacement');
});

test('accounts stay isolated and copied ciphertext cannot unlock under another email',async()=>{
  const server=provider(), client=new AccountClient(config,server.fetcher);
  await client.login(alice.email,password);
  await client.saveApiKey('gsk_alice');
  assert.deepEqual(await client.login(bob.email,password),{user:bob,apiKey:null});
  await client.saveApiKey('gsk_bob');
  assert.equal((await client.login(alice.email,password)).apiKey,'gsk_alice');
  server.metadata.set(bob.id,structuredClone(server.metadata.get(alice.id)));
  assert.deepEqual(await client.login(bob.email,password),{user:bob,apiKey:null,vaultLocked:true});
  assert.equal((await client.login(alice.email,password)).apiKey,'gsk_alice');
});

test('username signup requires twelve characters and detects incompatible email confirmation',async()=>{
  const server=provider({confirmation:true}), client=new AccountClient(config,server.fetcher);
  await assert.rejects(client.signUp('alice','short'),/12/);
  assert.equal(server.requests.length,0);
  await assert.rejects(client.signUp('alice',password),/confirmation|configuration/i);
  assert.ok(server.requests.every(request=>request.url.pathname!=='/auth/v1/signup'));
  assert.equal(client.user,null);
  await assert.rejects(client.saveApiKey('gsk_test'),/sign in|log in/i);
});

test('signup with an active provider session initializes an encrypted vault',async()=>{
  const server=provider(), client=new AccountClient(config,server.fetcher);
  const user={...alice,email:'alice@usernames.danskreader.invalid',username:'alice'};
  assert.deepEqual(await client.signUp('alice',password,'gsk_signup'),{confirmationRequired:false,user,apiKey:'gsk_signup'});
  assert.equal((await client.login('alice',password)).apiKey,'gsk_signup');
});

test('username signup saves encrypted metadata and normalizes the internal identity',async()=>{
  const server=provider(), client=new AccountClient(config,server.fetcher);
  await client.signUp(' ALICE ',password,'gsk_signup_key');
  const signup=server.requests.find(request=>request.url.pathname==='/auth/v1/signup').body;
  assert.equal(signup.email,'alice@usernames.danskreader.invalid');
  assert.equal(signup.data.dansk_vault.version,1);
  assert.ok(!JSON.stringify(signup.data).includes('gsk_signup_key'));
  assert.ok(!JSON.stringify(signup.data).includes(password));
  assert.equal((await client.login('ALICE',password)).apiKey,'gsk_signup_key');
});

test('availability is narrowly queried and taken or invalid usernames never reach signup',async()=>{
  const server=provider(), client=new AccountClient(config,server.fetcher);
  server.registered.add('alice');
  assert.equal(await client.available(' Alice '),false);
  assert.equal(await client.available('reader_2'),true);
  await assert.rejects(client.signUp('alice',password),/taken|available/i);
  await assert.rejects(client.available('bad name'),/username/i);
  await assert.rejects(client.signUp('alice@example.com',password),/username/i);
  assert.ok(server.requests.every(request=>request.url.pathname==='/rest/v1/rpc/username_available'));
});

test('logout clears locally before a failing remote request and clear drops the vault',async()=>{
  const server=provider({logoutError:true}), client=new AccountClient(config,server.fetcher);
  await client.login(alice.email,password);
  const logout=client.logout();
  assert.equal(client.user,null);
  await assert.rejects(logout,/account|provider|request/i);
  await assert.rejects(client.saveApiKey('gsk_test'),/sign in|log in/i);
  await client.login(alice.email,password);
  client.clear();
  assert.equal(client.user,null);
  await assert.rejects(client.saveApiKey('gsk_test'),/sign in|log in/i);
});

test('provider error text never exposes credentials and clears previous account state',async()=>{
  const server=provider();
  let fail=false;
  const client=new AccountClient(config,async(...args)=>fail ? response({message:`${password} secret-token`},400) : server.fetcher(...args));
  await client.login(alice.email,password);
  fail=true;
  await assert.rejects(client.login(alice.email,password),error=>!error.message.includes(password) && !error.message.includes('secret-token'));
  assert.equal(client.user,null);
});

test('clear during a pending login prevents the session from being restored',async()=>{
  const server=provider();
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const client=new AccountClient(config,async(...args)=>{await gate;return server.fetcher(...args);});
  const login=client.login(alice.email,password);
  client.clear();
  release();
  await assert.rejects(login,/cancel|changed/i);
  assert.equal(client.user,null);
});

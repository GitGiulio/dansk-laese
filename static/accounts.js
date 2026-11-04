import {normalizeUsername,usernameEmail,usernameFromEmail} from './usernames.js';

const encoder = new TextEncoder();
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = text => {
  if (typeof text !== 'string' || text.length > 12000) throw new Error('Invalid vault data');
  return Uint8Array.from(atob(text), character => character.charCodeAt(0));
};

function publicConfiguration({url,publishableKey} = {}) {
  try {
    const project = new URL(url);
    if (project.protocol !== 'https:' || !/^[a-z\d-]+\.supabase\.co$/i.test(project.hostname) || project.port || project.username || project.password || project.pathname !== '/' || project.search || project.hash) return null;
    if (typeof publishableKey !== 'string') return null;
    let allowed = /^sb_publishable_[\w-]+$/.test(publishableKey);
    if (!allowed && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(publishableKey)) {
      const payload = publishableKey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      allowed = JSON.parse(atob(payload)).role === 'anon';
    }
    return allowed ? {url:project.origin,publishableKey} : null;
  } catch {
    return null;
  }
}

async function deriveKey(password,salt) {
  const material = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}

async function encryptedRecord(apiKey,key,salt,email) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096) throw new Error('Enter a valid API key.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(email.trim().toLowerCase())},key,encoder.encode(apiKey.trim()));
  return {version:1,salt:encode(salt),iv:encode(iv),ciphertext:encode(ciphertext)};
}

export class AccountClient {
  #config;
  #fetch;
  #user = null;
  #token = null;
  #key = null;
  #salt = null;
  #generation = 0;

  constructor(config = {},fetcher = globalThis.fetch.bind(globalThis)) {
    this.#config = publicConfiguration(config);
    this.#fetch = fetcher;
  }

  get configured() { return this.#config !== null; }
  get user() { return this.#user ? {...this.#user} : null; }

  clear() {
    this.#generation++;
    this.#user = this.#token = this.#key = this.#salt = null;
  }

  #check(generation) {
    if (generation !== this.#generation) throw new Error('Account operation cancelled because the session changed.');
  }

  async #request(path,{method = 'GET',body,token} = {}) {
    if (!this.configured) throw new Error('Account service is not configured.');
    let response;
    try {
      response = await this.#fetch(this.#config.url + path,{
        method,headers:{apikey:this.#config.publishableKey,'Content-Type':'application/json',...(token ? {Authorization:`Bearer ${token}`} : {})},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}),
        credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error('Account provider could not be reached. Please try again.');
    }
    if (!response.ok) {
      if (response.status === 429) throw new Error('Too many account requests. Please try again later.');
      if (response.status === 404 && path === '/rest/v1/rpc/username_available') throw new Error('Username availability is not configured. The project owner must run the username SQL setup.');
      if (response.status === 401 || response.status === 403) throw new Error('Account request was denied. Check your credentials or sign in again.');
      let code;
      try {const error=await response.json();code=error.error_code || error.code;}catch{}
      const messages={
        email_provider_disabled:'Email/password authentication is disabled in Supabase. Enable the Email provider, while keeping Confirm email turned off. Readers still sign in with usernames.',
        signup_disabled:'New account creation is disabled in Supabase. The project owner must enable signups.',
        email_address_invalid:'Supabase rejected the internal account identifier. The project owner must configure a supported username identity domain.',
        weak_password:'Supabase requires a stronger password. Choose a longer password with varied characters.',
        captcha_failed:'Supabase requires a valid CAPTCHA. This project needs CAPTCHA integration before signup can work.',
        user_already_exists:'That username is already taken. Choose another username.',
        email_exists:'That username is already taken. Choose another username.',
        invalid_credentials:'Account request failed: incorrect username or password.',
        unexpected_failure:'Supabase could not save the account. Check the Auth and database logs, including the username trigger.',
      };
      if(Object.hasOwn(messages,code))throw new Error(messages[code]);
      if(typeof code==='string' && /^[a-z][a-z0-9_]{2,64}$/.test(code))throw new Error(`Account request failed (${code}). Check the Supabase Auth configuration.`);
      throw new Error('Account request failed. Check your username and password, or choose another username.');
    }
    if (response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new Error('Account provider returned an invalid response.'); }
  }

  async #authenticate(name,password,signup,apiKey) {
    this.clear();
    const generation = this.#generation;
    // Existing email accounts can still log in through the client API.
    const legacyEmail = !signup && typeof name === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name.trim());
    const email = legacyEmail ? name.trim().toLowerCase() : usernameEmail(name);
    if (typeof password !== 'string' || !password.length) throw new Error('Enter your account password.');
    if (signup && password.length < 12) throw new Error('Use an account password of at least 12 characters.');
    try {
      if (signup && !await this.available(name)) throw new Error('That username is already taken. Choose another username.');
      if (signup) {
        const settings = await this.#request('/auth/v1/settings');
        if(settings?.external?.email===false)throw new Error('Email/password authentication is disabled in Supabase. Enable the Email provider, while keeping Confirm email turned off. Readers still sign in with usernames.');
        if (settings?.mailer_autoconfirm !== true) throw new Error('Username signup requires email confirmations to be disabled in the Supabase project configuration.');
      }
      const body = {email,password};
      if (signup && apiKey !== undefined) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveKey(password,salt);
        body.data = {dansk_vault:await encryptedRecord(apiKey,key,salt,body.email)};
      }
      this.#check(generation);
      const session = await this.#request(signup ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password',{method:'POST',body});
      this.#check(generation);
      if (signup && !session?.access_token) throw new Error('Username signup requires email confirmations to be disabled in the Supabase project configuration.');
      const result = await this.#openVault(session,password,generation);
      return signup ? {confirmationRequired:false,...result} : result;
    } catch (error) {
      if (generation === this.#generation) this.clear();
      throw error;
    }
  }

  signUp(username,password,apiKey) { return this.#authenticate(username,password,true,apiKey); }
  login(username,password) { return this.#authenticate(username,password,false); }

  async available(username) {
    usernameEmail(username);
    const available = await this.#request('/rest/v1/rpc/username_available',{method:'POST',body:{candidate:normalizeUsername(username)}});
    if (typeof available !== 'boolean') throw new Error('Username availability returned an invalid response.');
    return available;
  }

  async #openVault(session,password,generation) {
    if (!uuid.test(session?.user?.id) || typeof session?.user?.email !== 'string' || !session.user.email || typeof session?.access_token !== 'string' || !session.access_token) throw new Error('Account provider returned an invalid session.');
    const username = usernameFromEmail(session.user.email);
    const user = {id:session.user.id,email:session.user.email,...(username ? {username} : {})};
    const row = session.user.user_metadata?.dansk_vault;
    const hasVault = row !== undefined && row !== null;
    let salt,key,apiKey = null,vaultLocked = false;
    try {
      salt = hasVault ? decode(row.salt) : crypto.getRandomValues(new Uint8Array(16));
      if (salt.length !== 16 || (hasVault && row.version !== 1)) throw new Error('Invalid vault data');
      key = await deriveKey(password,salt);
      if (hasVault) {
        const iv = decode(row.iv), ciphertext = decode(row.ciphertext);
        if (iv.length !== 12 || ciphertext.length < 16) throw new Error('Invalid vault data');
        const plaintext = await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(user.email.trim().toLowerCase())},key,ciphertext);
        apiKey = new TextDecoder('utf-8',{fatal:true}).decode(plaintext);
        if (!apiKey || apiKey.length > 4096) throw new Error('Invalid vault data');
      }
    } catch {
      if (!hasVault) throw new Error('Your browser could not initialize API-key encryption.');
      vaultLocked = true;
      apiKey = null;
      salt = crypto.getRandomValues(new Uint8Array(16));
      key = await deriveKey(password,salt);
    }
    this.#check(generation);
    this.#user = user;
    this.#token = session.access_token;
    this.#salt = salt;
    this.#key = key;
    return {user:{...user},apiKey,...(vaultLocked ? {vaultLocked:true} : {})};
  }

  async saveApiKey(apiKey) {
    if (!this.#user || !this.#key) throw new Error('Sign in before saving an API key.');
    const generation = this.#generation, user = this.#user, token = this.#token;
    const record = await encryptedRecord(apiKey,this.#key,this.#salt,user.email);
    this.#check(generation);
    await this.#request('/auth/v1/user',{
      method:'PUT',token,body:{data:{dansk_vault:record}},
    });
    this.#check(generation);
  }

  async logout() {
    const token = this.#token;
    this.clear();
    if (token) await this.#request('/auth/v1/logout?scope=local',{method:'POST',token});
  }
}

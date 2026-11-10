// IndexedDB can persist a non-exportable CryptoKey without serializing its bytes.
export function sessionStorageFor(project) {
  const name=project+':'+(typeof location==='undefined'?'':new URL('.',location.href).pathname);
  async function operation(mode,value) {
    if(!globalThis.indexedDB)return null;
    return new Promise(resolve=>{
      let finished=false;
      const done=result=>{if(!finished){finished=true;clearTimeout(timer);resolve(result);}};
      const timer=setTimeout(()=>done(null),5000);
      const request=indexedDB.open('dansk-reader-auth',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('sessions');
      request.onerror=()=>done(null);request.onblocked=()=>done(null);
      request.onsuccess=()=>{
        const db=request.result;if(finished){db.close();return;}
        try{
          const transaction=db.transaction('sessions',mode==='get'?'readonly':'readwrite'),store=transaction.objectStore('sessions');
          const action=mode==='get'?store.get(name):mode==='set'?store.put(value,name):store.delete(name);
          transaction.oncomplete=()=>{db.close();done(mode==='get'?action.result || null:true);};
          transaction.onerror=transaction.onabort=()=>{db.close();done(null);};
        }catch{db.close();done(null);}
      };
    });
  }
  return {get:()=>operation('get'),set:value=>operation('set',value),remove:()=>operation('remove')};
}

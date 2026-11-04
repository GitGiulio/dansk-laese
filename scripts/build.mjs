import {readdir,readFile,mkdir,copyFile,writeFile,lstat,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=await realpath(fileURLToPath(new URL('../',import.meta.url)));
const source=path.join(root,'static'), destination=path.resolve(root,'dist');
if(path.dirname(destination)!==root || path.basename(destination)!=='dist')throw new Error('Unsafe build destination.');
try {if((await lstat(destination)).isSymbolicLink())throw new Error('Refusing a linked build directory.');}
catch(error){if(error.code!=='ENOENT')throw error;}

async function assets(directory) {
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(entry.name.startsWith('.'))continue;
    const file=path.join(directory,entry.name);
    if(entry.isSymbolicLink())throw new Error('Public assets cannot be symbolic links.');
    if(entry.isDirectory())files.push(...await assets(file));
    else if(entry.isFile()){
      const content=await readFile(file,'utf8');
      if(/gsk_[a-z\d]{20,}|sb_secret_[\w-]{15,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(content))throw new Error('A public asset appears to contain a private key. Build stopped.');
      files.push(file);
    }
  }
  return files;
}
const files=await assets(source);
// Only this verified, project-local output directory is replaced.
await rm(destination,{recursive:true,force:true});
await mkdir(destination,{recursive:true});
for(const file of files){
  const target=path.join(destination,path.relative(source,file));
  await mkdir(path.dirname(target),{recursive:true});await copyFile(file,target);
}
await writeFile(path.join(destination,'.nojekyll'),'');
console.log(`Built ${files.length} public assets in dist/.`);

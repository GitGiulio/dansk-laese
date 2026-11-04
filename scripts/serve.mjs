import {createServer} from 'node:http';
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=await realpath(fileURLToPath(new URL('../dist/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.wasm':'application/wasm','.json':'application/json','.png':'image/png','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'};
const server=createServer(async(request,response)=>{
  response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
  try {
    if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
    const url=new URL(request.url,'http://localhost');
    let candidate=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(candidate!==root && !candidate.startsWith(root+path.sep))throw new Error();
    if((await stat(candidate)).isDirectory())candidate=path.join(candidate,'index.html');
    const file=await realpath(candidate);
    if(!file.startsWith(root+path.sep))throw new Error();
    const body=await readFile(file);
    response.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream'});
    response.end(request.method==='HEAD'?undefined:body);
  } catch {response.writeHead(404);response.end('Not found');}
});
server.listen(8000,'127.0.0.1',()=>console.log('Dansk: http://127.0.0.1:8000 (Ctrl+C to stop)'));

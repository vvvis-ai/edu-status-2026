import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createLocalEnvironment} from './local-storage.mjs';
import {handleApi} from './api.mjs';

const root=path.resolve(import.meta.dirname,'..');
const allowed = new Set(['edustatus_all.html','edustatus_admin.html','edu-style.css','edu-client.mjs','edu-shared.mjs','edu-public.mjs','edu-admin.mjs','edu-workbook.mjs','edu-zip.mjs']);
const mime={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
export async function startLocalServer({port=3198,host='127.0.0.1',dataDirectory=path.join(root,'.edu-data'),adminPassword,sessionSecret,seed}={}) {
  let variables={};
  try { variables=Object.fromEntries((await fs.readFile(path.join(root,'.dev.vars'),'utf8')).split(/\r?\n/).filter(l=>l.trim()&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];})); } catch(error) { if(error.code!=='ENOENT')throw error; }
  adminPassword ||= process.env.ADMIN_PASSWORD || variables.ADMIN_PASSWORD;
  sessionSecret ||= process.env.SESSION_SECRET || variables.SESSION_SECRET;
  if (!adminPassword || !sessionSecret) throw new Error('관리자 비밀번호와 세션 키를 .dev.vars 또는 환경변수로 설정해 주세요. docs/운영안내.md를 확인하세요.');
  seed ||= JSON.parse(await fs.readFile(path.join(root,'server/seed.json'),'utf8'));
  const env=await createLocalEnvironment({dataDirectory,adminPassword,sessionSecret,seed});
  const server=http.createServer(async(req,res)=>{
    try {
      const origin=`http://${host==='0.0.0.0'?'localhost':host}:${server.address().port}`;
      const url=new URL(req.url,origin);
      if (Number(req.headers['content-length']||0)>64*1024*1024) {res.writeHead(413,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'업로드 요청은 전체 64MB를 넘을 수 없습니다.'}));return;}
      const headers=new Headers(); for(const [name,value] of Object.entries(req.headers)) if(value!=null) headers.set(name,Array.isArray(value)?value.join(', '):value);
      const init={method:req.method,headers};
      if(!['GET','HEAD'].includes(req.method)){init.body=Readable.toWeb(req);init.duplex='half';}
      const request=new Request(url,init);
      let response=await handleApi(request,env);
      if(!response) {
        if(url.pathname==='/') response=new Response(null,{status:302,headers:{Location:`${origin}/edustatus_all.html`}});
        else {
          const filename=decodeURIComponent(url.pathname.slice(1));
          if(!allowed.has(filename)||!['GET','HEAD'].includes(req.method)) response=new Response('페이지를 찾을 수 없습니다.',{status:404});
          else {const bytes=await fs.readFile(path.join(root,filename));response=new Response(req.method==='HEAD'?null:bytes,{headers:{'Content-Type':mime[path.extname(filename)]||'application/octet-stream'}});}
        }
      }
      response.headers.set('Cache-Control','no-store');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','same-origin');
      if (!response.headers.has('Content-Security-Policy')) response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
      res.statusCode=response.status;
      for(const [name,value] of response.headers) if(name!=='set-cookie')res.setHeader(name,value);
      const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);
      if(response.body&&req.method!=='HEAD')await pipeline(Readable.fromWeb(response.body),res);else res.end();
    } catch(error) {
      console.error('요청 처리 실패:',error.message);
      if(!res.headersSent){res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'요청 처리 중 오류가 발생했습니다. 다시 시도해 주세요.'}));}else res.destroy(error);
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {server,env,url:`http://${host}:${server.address().port}`,close:async()=>{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));env.DB.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)) {
  const portArg=process.argv.indexOf('--port');
  const instance=await startLocalServer({port:portArg>=0?Number(process.argv[portArg+1]):3198});
  console.log(`교육 관리 앱: ${instance.url}/edustatus_all.html`);
  console.log(`관리자 화면: ${instance.url}/edustatus_admin.html`);
  console.log('데이터와 수료증은 .edu-data 폴더에 영구 보관됩니다. 종료: Ctrl+C');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void instance.close().then(()=>process.exit(0));});
}

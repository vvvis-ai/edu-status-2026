import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'..');
const routes=[
  {file:'index.html',destination:'/edustatus_all.html',label:'부서원 화면 열기'},
  {file:'edustatus_all.html',destination:'/edustatus_all.html',label:'부서원 화면 열기'},
  {file:'edustatus_admin.html',destination:'/edustatus_admin.html',label:'관리자 화면 열기'},
];

export function validateWorkerOrigin(value) {
  const message='workerOrigin은 경로·쿼리·해시·계정정보 없는 HTTPS origin이어야 합니다. 예: https://앱이름.계정.workers.dev';
  if(typeof value!=='string'||!/^https:\/\/[^\\/?#\s]+\/?$/i.test(value))throw new Error(message);
  let url;
  try {url=new URL(value);}catch {throw new Error(message);}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname)throw new Error(message);
  return url.origin;
}

function escapeAttribute(value) {
  return value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
}

function renderPage(destination,label) {
  const href=escapeAttribute(destination);
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="refresh" content="0; url=${href}">
  <title>교육 관리 앱으로 이동</title>
  <script>window.location.replace(${JSON.stringify(destination)});</script>
  <style>body{margin:0;padding:3rem 1.25rem;font-family:system-ui,sans-serif;color:#17273d;background:#f4f7fb}main{max-width:36rem;margin:auto;padding:2rem;border:1px solid #dbe3ec;border-radius:1rem;background:white}h1{font-size:1.5rem;line-height:1.5}p{line-height:1.7}a{display:inline-block;padding:.8rem 1rem;border-radius:.5rem;background:#175cd3;color:white;font-weight:700;text-decoration:none}a:focus-visible{outline:3px solid #17273d;outline-offset:4px}</style>
</head>
<body>
  <main>
    <h1>교육 관리 앱으로 이동합니다</h1>
    <p>자동으로 이동하지 않으면 아래 링크를 눌러 주세요.</p>
    <a href="${href}">${label}</a>
  </main>
</body>
</html>
`;
}

export async function buildPagesBridge({origin,outputDirectory=path.join(root,'pages-bridge')}={}) {
  const workerOrigin=validateWorkerOrigin(origin);
  const output=path.resolve(outputDirectory);
  if(path.basename(output)!=='pages-bridge'||!output.startsWith(root+path.sep))throw new Error('bridge 출력은 작업 폴더 안의 pages-bridge 디렉터리를 사용하세요.');
  await fs.mkdir(output,{recursive:true});
  if((await fs.lstat(output)).isSymbolicLink())throw new Error('심볼릭 링크 디렉터리에 bridge를 생성하지 않습니다.');
  const allowed=new Set(routes.map(route=>route.file));
  for(const filename of await fs.readdir(output)) {
    const info=await fs.lstat(path.join(output,filename));
    if(!allowed.has(filename)||!info.isFile()||info.isSymbolicLink())throw new Error('pages-bridge에 예상하지 않은 파일이 있습니다. 게시 전에 확인하세요.');
  }
  for(const route of routes)await fs.writeFile(path.join(output,route.file),renderPage(new URL(route.destination,workerOrigin).href,route.label));
  return {workerOrigin,outputDirectory:output,files:routes.map(route=>route.file)};
}

async function main() {
  const args=process.argv.slice(2);
  let origin;
  if(args.length) {
    if(args.length!==2||args[0]!=='--origin')throw new Error('사용법: npm run build:pages -- --origin https://앱이름.계정.workers.dev');
    origin=args[1];
  } else {
    let config;
    try {config=JSON.parse(await fs.readFile(path.join(root,'deployment.json'),'utf8'));}
    catch(error) {
      if(error.code==='ENOENT')throw new Error('deployment.example.json을 deployment.json으로 복사하고 검증한 Worker HTTPS origin을 입력하세요.');
      throw new Error('deployment.json을 올바른 JSON으로 작성해 주세요.');
    }
    origin=config?.workerOrigin;
  }
  const result=await buildPagesBridge({origin});
  console.log(`GitHub Pages 연결 페이지 ${result.files.length}개 준비 완료: pages-bridge/ → ${result.workerOrigin}`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}

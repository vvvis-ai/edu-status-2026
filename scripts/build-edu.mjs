import fs from 'node:fs/promises';
import path from 'node:path';
import {publicAssets,staticPolicy} from '../server/static-assets.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'web-dist');
// This directory is generated. Rebuild from the allowlist so stale files can
// never accidentally become public assets.
if(path.dirname(out)!==root||path.basename(out)!=='web-dist')throw new Error('빌드 경로를 확인하세요.');
try { if((await fs.lstat(out)).isSymbolicLink())throw new Error('web-dist 심볼릭 링크에는 빌드하지 않습니다.'); }
catch(error) { if(error.code!=='ENOENT')throw error; }
await fs.rm(out,{recursive:true,force:true});
await fs.mkdir(out,{recursive:true});
for(const file of publicAssets) {
  await fs.mkdir(path.dirname(path.join(out,file)),{recursive:true});
  await fs.copyFile(path.join(root,file),path.join(out,file));
}
await fs.writeFile(path.join(out,'_headers'),`/*
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Content-Security-Policy: ${staticPolicy('/')}

/edu-ocr-worker.js
  ! Content-Security-Policy
  Content-Security-Policy: ${staticPolicy('/edu-ocr-worker.js')}
`);
console.log(`교육 관리 앱 정적 파일 ${publicAssets.length}개 준비 완료. 비공개 설정과 서버 데이터는 포함하지 않습니다.`);

import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'web-dist');
const files=['edustatus_all.html','edustatus_admin.html','edu-style.css','edu-client.mjs','edu-shared.mjs','edu-public.mjs','edu-admin.mjs','edu-department.mjs','edu-workbook.mjs','edu-zip.mjs'];
// This directory is generated. Rebuild from the allowlist so stale files can
// never accidentally become public assets.
if(path.dirname(out)!==root||path.basename(out)!=='web-dist')throw new Error('빌드 경로를 확인하세요.');
try { if((await fs.lstat(out)).isSymbolicLink())throw new Error('web-dist 심볼릭 링크에는 빌드하지 않습니다.'); }
catch(error) { if(error.code!=='ENOENT')throw error; }
await fs.rm(out,{recursive:true,force:true});
await fs.mkdir(out,{recursive:true});
for(const file of files)await fs.copyFile(path.join(root,file),path.join(out,file));
await fs.writeFile(path.join(out,'_headers'),`/*
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
`);
console.log(`교육 관리 앱 정적 파일 ${files.length}개 준비 완료. 비공개 설정과 서버 데이터는 포함하지 않습니다.`);

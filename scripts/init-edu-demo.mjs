import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

const root=path.resolve(import.meta.dirname,'..');
async function createOnly(filename,create) {
  try { await create(); console.log(`${filename} 생성 완료.`); }
  catch(error) { if(error.code==='EEXIST')console.log(`${filename} 기존 파일 보존.`);else throw error; }
}
await createOnly('server/seed.json',()=>fs.copyFile(path.join(root,'server/seed.example.json'),path.join(root,'server/seed.json'),constants.COPYFILE_EXCL));
await createOnly('.dev.vars',()=>fs.writeFile(path.join(root,'.dev.vars'),`ADMIN_PASSWORD=${randomBytes(18).toString('base64url')}\nSESSION_SECRET=${randomBytes(48).toString('base64url')}\n`,{flag:'wx'}));
console.log('로컬 실행: npm start. 생성된 관리자 비밀번호는 이 PC의 .dev.vars에서 확인하세요.');
console.log('이 명령은 기존 데이터베이스와 수료증 파일을 변경하지 않습니다.');

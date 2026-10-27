import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const files=(await fs.readdir(root)).filter(file=>/^edu-.*\.mjs$/.test(file));
for(const directory of ['server','scripts','tests']) {
  for(const file of await fs.readdir(path.join(root,directory))) {
    if(/\.(?:mjs|cjs)$/.test(file))files.push(`${directory}/${file}`);
  }
}
files.push('certificate-parser.js','certificate-ocr.js','수료증_엑셀일괄변환.mjs');
for(const file of files) {
  const result=spawnSync(process.execPath,['--check',path.join(root,file)],{stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
JSON.parse(await fs.readFile(path.join(root,'server/seed.example.json'),'utf8'));
JSON.parse(await fs.readFile(path.join(root,'deployment.example.json'),'utf8'));
console.log(`${files.length}개 JavaScript 파일 구문 및 공개 설정 JSON 검사 통과.`);

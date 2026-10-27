import fs from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const args=process.argv.slice(2);
function argument(name,fallback) {
  const index=args.indexOf(name);
  if(index<0)return fallback;
  if(!args[index+1]||args[index+1].startsWith('--'))throw new Error(`${name} 값을 입력하세요.`);
  return args[index+1];
}
const seedPath=path.resolve(root,argument('--seed','server/seed.example.json'));
const output=path.resolve(root,argument('--output','.verification/edu-seed.sql'));
if(!output.startsWith(path.join(root,'.verification')+path.sep)&&!output.startsWith(path.join(root,'.edu-exports')+path.sep))throw new Error('SQL 출력은 비공개 .verification 또는 .edu-exports 폴더에만 저장하세요.');
const seed=JSON.parse(await fs.readFile(seedPath,'utf8'));
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const rows=[];
for(const collection of ['courses','members']) {
  if(!Array.isArray(seed[collection]))throw new Error(`${collection} 배열이 필요합니다.`);
  const ids=new Set();
  for(const record of seed[collection]) {
    if(typeof record.id!=='string'||!record.id||ids.has(record.id)||!Number.isSafeInteger(record.version)||record.version<1)throw new Error(`${collection}의 ID 또는 버전을 확인하세요.`);
    ids.add(record.id);
    rows.push([collection,record.id,JSON.stringify(record),record.version]);
  }
}
rows.push(['meta','initial-import',JSON.stringify({source:seed.source,exportedAt:seed.exportedAt,importedAt:new Date().toISOString()}),1]);
// One statement: either every row is inserted or no row is inserted. A
// non-empty target is left alone; this is initialization, never replacement.
const values=rows.map(row=>`(${row.map(quote).join(',')})`).join(',\n');
const sql=`-- 비공개 초기 이관 데이터. 기존 교육 또는 명단이 있으면 아무것도 삽입하지 않습니다.\nWITH initial_rows(collection,id,data,version) AS (VALUES\n${values}\n)\nINSERT INTO records(collection,id,data,version)\nSELECT collection,id,data,version FROM initial_rows\nWHERE NOT EXISTS(SELECT 1 FROM records WHERE collection IN ('courses','members'));\n`;
await fs.mkdir(path.dirname(output),{recursive:true});
await fs.writeFile(output,sql,{flag:'wx'});
console.log(`초기 이관 SQL 준비 완료: ${path.relative(root,output)} (교육 ${seed.courses.length}, 부서원 ${seed.members.length}). DB에는 아직 반영하지 않았습니다.`);

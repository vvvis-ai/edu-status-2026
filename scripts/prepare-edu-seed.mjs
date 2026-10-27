import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const before=await fs.readFile(path.join(root,'.verification/edu-v2-before/edustatus_all.html'),'utf8');
const admin=await fs.readFile(path.join(root,'.verification/edu-v2-before/edustatus_admin.html'),'utf8');
const match=before.match(/const courses = ([\s\S]*?);\s*const initialMembers = ([\s\S]*?);/);
if (!match) throw new Error('기존 교육·명단을 찾을 수 없습니다.');
const initial=vm.runInNewContext(`({courses:${match[1]},members:${match[2]}})`,{}, {timeout:1000});
let source='기존 HTML 기본 기록'; let members=initial.members;
if (!process.argv.includes('--offline')) {
  const endpoint=before.match(/const API_ENDPOINT\s*=\s*'([^']+)'/)[1];
  const response=await fetch(endpoint,{signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`기존 API 조회 실패 (${response.status}). 기존 현황을 확인한 뒤 다시 실행하세요.`);
  const data=await response.json();
  if (!Array.isArray(data.members) || !data.members.length) throw new Error('기존 API에 유효한 명단이 없어 자동 이관을 중단했습니다.');
  if (data.members.some(m=>!m.id || typeof m.name!=='string' || !Array.isArray(m.completions))) throw new Error('기존 API 데이터 형식이 예상과 다릅니다.');
  members=data.members; source='기존 운영 API 읽기 전용 조회';
  await fs.writeFile(path.join(root,'.verification/edu-v2-before/live-members.json'),JSON.stringify(data,null,2)+'\n');
}
const now=new Date().toISOString(), initialDate='2026-01-01T00:00:00.000Z';
const seed={version:2,source,exportedAt:now,courses:initial.courses.map(c=>({
  id:String(c.id),name:c.name,site:c.site,url:c.url,deadline:c.deadline,submissionDeadline:c.deadline,
  year:2026,periodType:'year',periodValue:0,details:c.detail || [],requirement:'custom',requirementNote:'기존 안내의 이수 조건을 확인해 주세요.',
  requestDepartment:'',description:'',published:true,archived:false,targetMode:'all',targetMemberIds:[],exemptMemberIds:[],createdAt:initialDate,updatedAt:now,version:1,
})),members:members.map(m=>({id:String(m.id),name:m.name,position:m.position||'',team:m.team||'',active:true,joinedOn:'',leftOn:'',note:'',legacyCompletions:[...new Set(m.completions.map(String))],createdAt:initialDate,updatedAt:now,version:1}))};
await fs.writeFile(path.join(root,'server/seed.json'),JSON.stringify(seed,null,2)+'\n');
await fs.mkdir(path.join(root,'.edu-data'),{recursive:true});
const password=admin.match(/const ADMIN_PASSWORD\s*=\s*'([^']+)'/)[1];
try { await fs.writeFile(path.join(root,'.dev.vars'),`ADMIN_PASSWORD=${password}\nSESSION_SECRET=${crypto.randomUUID()}${crypto.randomUUID()}\n`,{flag:'wx'}); } catch(e) { if(e.code!=='EEXIST') throw e; }
console.log(`교육 ${seed.courses.length}개, 부서원 ${seed.members.length}명, 기존 이수 ${seed.members.reduce((n,m)=>n+m.legacyCompletions.length,0)}건 이관 준비 완료 (${source}).`);

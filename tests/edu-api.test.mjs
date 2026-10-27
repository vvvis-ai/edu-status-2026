import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {handleApi} from '../server/api.mjs';
import {createLocalEnvironment} from '../server/local-storage.mjs';

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGkAAAAASUVORK5CYII=','base64');
const timestamp = '2026-01-01T00:00:00.000Z';
const course = (id,extra={}) => ({id,name:`교육 ${id}`,site:'교육원',url:'https://example.com/education',deadline:'2026-12-31',submissionDeadline:'2026-12-20',year:2026,periodType:'year',periodValue:0,details:['필수 과정'],requirement:'all',requirementNote:'',requestDepartment:'총무과',description:'',published:true,archived:false,targetMode:'all',targetMemberIds:[],exemptMemberIds:[],createdAt:timestamp,updatedAt:timestamp,version:1,...extra});
const member = (id,extra={}) => ({id,name:`직원${id}`,position:'행정9급',team:'총무팀',active:true,joinedOn:'',leftOn:'',note:'내부메모',legacyCompletions:[],createdAt:timestamp,updatedAt:timestamp,version:1,...extra});
const chartInput = ({leaderId='',teamMembers=[['m1'],['m2'],[],[]],names=[],activeMemberIds=['m1','m2'],version=0}={}) => ({leaderId,teams:Array.from({length:4},(_,index)=>({id:`team-${index+1}`,name:names[index] || `${index+1}팀`,memberIds:teamMembers[index] || []})),activeMemberIds,version});
const chartPeople = chart => [...(chart.leaderId?[chart.leaderId]:[]),...chart.teams.flatMap(team=>team.memberIds),...chart.unassignedMemberIds];

async function fixture(t,seed={courses:[course('c1')],members:[member('m1'),member('m2')]}) {
  const base = path.resolve('.verification');
  await fs.mkdir(base,{recursive:true});
  const directory = await fs.mkdtemp(path.join(base,'api-test-'));
  const env = await createLocalEnvironment({dataDirectory:directory,adminPassword:'test-admin-password',sessionSecret:'test-session-secret-more-than-32-bytes',seed});
  t.after(async()=>{
    env.DB.close();
    if (!path.resolve(directory).startsWith(base+path.sep)) throw Error('Unsafe test cleanup path');
    await fs.rm(directory,{recursive:true,force:true});
  });
  async function call(apiPath,{method='GET',body,cookie,origin='http://localhost'}={}) {
    const headers = new Headers();
    if (cookie) headers.set('Cookie',cookie);
    if (method!=='GET' && origin) headers.set('Origin',origin);
    let payload=body;
    if (body && !(body instanceof FormData)) { headers.set('Content-Type','application/json'); payload=JSON.stringify(body); }
    return handleApi(new Request(`http://localhost/api${apiPath}`,{method,headers,...(payload ? {body:payload}: {})}),env);
  }
  async function login() {
    const response=await call('/admin/login',{method:'POST',body:{password:'test-admin-password'}});
    assert.equal(response.status,200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  async function select(memberId='m1') {
    const response=await call('/member-session',{method:'POST',body:{memberId}});
    assert.equal(response.status,200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  function form({courseId='c1',file=PDF,name='수료증.pdf',type='application/pdf',expectedMemberId='m1',completedOn='2026-01-01'}={}) {
    const value=new FormData();
    value.set('courseId',courseId); value.set('completedOn',completedOn); value.set('comment','수료증 제출'); value.set('expectedMemberId',expectedMemberId);
    value.append('files',new File([file],name,{type}));
    return value;
  }
  return {env,call,login,select,form};
}

test('bootstrap hides private records and admin routes require server authentication',async t=>{
  const f=await fixture(t,{courses:[course('c1'),course('draft',{published:false}),course('old',{archived:true})],members:[member('m1',{legacyCompletions:['c1']}),member('left',{active:false})]});
  const data=await (await f.call('/bootstrap')).json();
  assert.deepEqual(data.courses.map(value=>value.id).sort(),['c1','old']);
  assert.equal(data.members.length,1);
  assert.equal('legacyCompletions' in data.members[0],false);
  assert.equal('note' in data.members[0],false);
  assert.equal((await f.call('/admin/data')).status,401);
  const rejected=await f.call('/admin/login',{method:'POST',body:{password:'wrong'}});
  assert.equal(rejected.status,401);
  const response=await f.call('/admin/login',{method:'POST',body:{password:'test-admin-password'}});
  const header=response.headers.get('set-cookie');
  assert.match(header,/HttpOnly/); assert.match(header,/SameSite=Strict/);
  const cookie=header.split(';')[0];
  assert.equal((await f.call('/admin/data',{cookie})).status,200);
  assert.equal((await f.call('/admin/logout',{method:'POST',cookie})).status,200);
  assert.equal((await f.call('/admin/data',{cookie})).status,401);
});

test('course edits use optimistic concurrency, and member edits preserve historical completions',async t=>{
  const f=await fixture(t,{courses:[course('c1')],members:[member('m1',{legacyCompletions:['c1']})]});
  const cookie=await f.login();
  const saved=await f.call('/admin/courses/c1',{method:'PUT',cookie,body:{...course('c1'),name:'바뀐 교육'}});
  assert.equal(saved.status,200);
  assert.equal((await saved.json()).course.version,2);
  assert.equal((await f.call('/admin/courses/c1',{method:'PUT',cookie,body:{...course('c1'),name:'뒤늦은 수정'}})).status,409);
  const updated=await f.call('/admin/members/m1',{method:'PUT',cookie,body:{...member('m1'),team:'새로운팀',legacyCompletions:[]}});
  assert.equal(updated.status,200);
  assert.deepEqual((await updated.json()).member.legacyCompletions,['c1']);
  const data=await (await f.call('/admin/data',{cookie})).json();
  assert.equal(data.courses[0].name,'바뀐 교육');
  assert.ok(data.audit.some(entry=>entry.action==='member_updated' && entry.detail.before.team==='총무팀' && entry.detail.after.team==='새로운팀'));
});

test('member order defaults to existing ID order, persists for public/admin views and preserves education and personnel records',async t=>{
  const f=await fixture(t,{courses:[course('c1')],members:[member('m2'),member('left',{active:false}),member('m1',{legacyCompletions:['c1']})]});
  const admin=await f.login(),selected=await f.select('m2');
  assert.equal((await f.call('/admin/member-order',{method:'PUT',body:{memberIds:['m2','m1'],version:0}})).status,401);
  assert.equal((await f.call('/admin/member-order',{method:'PUT',cookie:selected,body:{memberIds:['m2','m1'],version:0}})).status,401);
  const initial=await (await f.call('/admin/data',{cookie:admin})).json();
  assert.deepEqual(initial.memberOrder,{memberIds:['m1','m2'],version:0});
  assert.deepEqual(initial.members.map(value=>value.id),['m1','m2','left']);
  assert.deepEqual((await (await f.call('/bootstrap')).json()).members.map(value=>value.id),['m1','m2']);
  const submissionResponse=await f.call('/submissions',{method:'POST',cookie:selected,body:f.form({file:PNG,name:'가상수료증.png',type:'image/png',expectedMemberId:'m2'})});
  assert.equal(submissionResponse.status,201);
  const submission=(await submissionResponse.json()).submission;
  const before=await f.env.DB.prepare("SELECT collection,id,data,version FROM records WHERE collection NOT IN ('settings','audit') ORDER BY collection,id").all();
  const response=await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:['m2','m1'],version:0}});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).memberOrder,{memberIds:['m2','m1'],version:1});
  const data=await (await f.call('/admin/data',{cookie:admin})).json();
  assert.deepEqual(data.memberOrder,{memberIds:['m2','m1'],version:1});
  assert.deepEqual(data.members.map(value=>value.id),['m2','m1','left']);
  assert.deepEqual((await (await f.call('/bootstrap')).json()).members.map(value=>value.id),['m2','m1']);
  const after=await f.env.DB.prepare("SELECT collection,id,data,version FROM records WHERE collection NOT IN ('settings','audit') ORDER BY collection,id").all();
  assert.deepEqual(after.results,before.results,'sorting changes no staff version, completion, submission, file or education record');
  const original=await f.call(`/files/${submission.files[0].id}`,{cookie:selected});
  assert.deepEqual(Buffer.from(await original.arrayBuffer()),PNG);
  const audits=data.audit.filter(value=>value.action==='member_order_updated');
  assert.equal(audits.length,1);
  assert.deepEqual(audits[0].detail.memberIds,['m2','m1']);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection = 'settings' AND id = 'member-order'").first()).count,1);
});

test('member order validates complete current membership, duplicate/unknown IDs, versions and an empty active roster',async t=>{
  const f=await fixture(t,{courses:[course('c1')],members:[member('m1'),member('m2'),member('left',{active:false})]}),admin=await f.login();
  for(const [body,status] of [
    [{version:0},400],[{memberIds:'m1',version:0},400],[{memberIds:['m1','m1'],version:0},400],
    [{memberIds:['m1','unknown'],version:0},400],[{memberIds:['m1',2],version:0},400],
    [{memberIds:['m1'],version:0},409],[{memberIds:['m1','m2','left'],version:0},409],
    [{memberIds:['m1','m2']},400],[{memberIds:['m1','m2'],version:-1},400],[{memberIds:['m1','m2'],version:1},409],
  ]) assert.equal((await f.call('/admin/member-order',{method:'PUT',cookie:admin,body})).status,status);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection = 'settings'").first()).count,0);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection = 'audit'").first()).count,0);
  const empty=await fixture(t,{courses:[],members:[member('left',{active:false})]}),emptyAdmin=await empty.login();
  const response=await empty.call('/admin/member-order',{method:'PUT',cookie:emptyAdmin,body:{memberIds:[],version:0}});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).memberOrder,{memberIds:[],version:1});
});

test('member order appends newly added employees and ignores inactive saved IDs without modifying its version',async t=>{
  const f=await fixture(t),admin=await f.login();
  assert.equal((await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:['m2','m1'],version:0}})).status,200);
  const createdResponse=await f.call('/admin/members',{method:'POST',cookie:admin,body:{name:'가상신규직원',team:'가상팀',active:true}});
  assert.equal(createdResponse.status,201);
  const newcomer=(await createdResponse.json()).member;
  const added=await (await f.call('/admin/data',{cookie:admin})).json();
  assert.deepEqual(added.memberOrder,{memberIds:['m2','m1',newcomer.id],version:1});
  assert.equal((await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:['m2','m1'],version:1}})).status,409);
  assert.equal((await f.call('/admin/members/m2',{method:'PUT',cookie:admin,body:{...member('m2'),active:false,leftOn:'2026-10-01'}})).status,200);
  const transferred=await (await f.call('/admin/data',{cookie:admin})).json();
  assert.deepEqual(transferred.memberOrder,{memberIds:['m1',newcomer.id],version:1});
  assert.deepEqual((await (await f.call('/bootstrap')).json()).members.map(value=>value.id),['m1',newcomer.id]);
  assert.equal((await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:['m2','m1',newcomer.id],version:1}})).status,409);
  const saved=await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:[newcomer.id,'m1'],version:1}});
  assert.equal(saved.status,200);
  assert.deepEqual((await saved.json()).memberOrder,{memberIds:[newcomer.id,'m1'],version:2});
  assert.equal((await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:['m1',newcomer.id],version:1}})).status,409);
});

test('simultaneous initial and subsequent member-order saves each accept one result and produce one audit',async t=>{
  const f=await fixture(t),admin=await f.login();
  for(const expectedVersion of [0,1]) {
    const batch=f.env.DB.batch.bind(f.env.DB);
    let calls=0,release;
    const barrier=new Promise(resolve=>{release=resolve;});
    f.env.DB.batch=async statements=>{if(++calls===2)release();await barrier;return batch(statements);};
    const responses=await Promise.all([
      f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:['m1','m2'],version:expectedVersion}}),
      f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:['m2','m1'],version:expectedVersion}}),
    ]);
    f.env.DB.batch=batch;
    assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
    const saved=(await responses.find(response=>response.status===200).json()).memberOrder;
    const data=await (await f.call('/admin/data',{cookie:admin})).json();
    assert.deepEqual(data.memberOrder,saved);
    assert.equal(data.memberOrder.version,expectedVersion+1);
    assert.equal(data.audit.filter(value=>value.action==='member_order_updated').length,expectedVersion+1);
    assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection = 'settings'").first()).count,1);
  }
});

for(const rosterChange of ['addition','transfer','replacement']) test(`member-order atomic membership guard rejects a concurrent ${rosterChange} without saving an order or audit`,async t=>{
  const f=await fixture(t),admin=await f.login();
  assert.equal((await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:['m1','m2'],version:0}})).status,200);
  const before=await f.env.DB.prepare("SELECT data FROM records WHERE collection = 'settings' AND id = 'member-order'").first();
  const batch=f.env.DB.batch.bind(f.env.DB); let changed=false;
  f.env.DB.batch=async statements=>{
    if(!changed) {
      changed=true; const mutations=[];
      if(rosterChange!=='transfer')mutations.push(f.env.DB.prepare('INSERT INTO records(collection,id,data,version) VALUES(?,?,?,?)').bind('members','m3',JSON.stringify(member('m3')),1));
      if(rosterChange!=='addition')mutations.push(f.env.DB.prepare("UPDATE records SET data = ?, version = 2 WHERE collection = 'members' AND id = 'm2'").bind(JSON.stringify(member('m2',{active:false,version:2}))));
      await batch(mutations);
    }
    return batch(statements);
  };
  const response=await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:['m2','m1'],version:1}});
  assert.equal(response.status,409);
  assert.equal((await response.json()).code,'VERSION_CONFLICT');
  assert.deepEqual(await f.env.DB.prepare("SELECT data FROM records WHERE collection = 'settings' AND id = 'member-order'").first(),before);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection = 'audit' AND json_extract(data,'$.action') = 'member_order_updated'").first()).count,1);
});

test('member-order saving permits a concurrent team and position edit and uses bounded JSON-list SQL parameters',async t=>{
  const members=Array.from({length:125},(_,index)=>member(`m${String(index).padStart(3,'0')}`));
  const f=await fixture(t,{courses:[course('c1')],members}),admin=await f.login();
  const batch=f.env.DB.batch.bind(f.env.DB),prepare=f.env.DB.prepare.bind(f.env.DB); let edited=false;
  f.env.DB.prepare=sql=>{
    const statement=prepare(sql),bind=statement.bind.bind(statement);
    statement.bind=(...values)=>{assert.ok(values.length<100,'member arrays must not become one SQL parameter per employee');return bind(...values);};
    return statement;
  };
  f.env.DB.batch=async statements=>{
    if(!edited) {
      edited=true;
      await batch([prepare("UPDATE records SET data = ?, version = 2 WHERE collection = 'members' AND id = 'm000'").bind(JSON.stringify(member('m000',{team:'변경팀',position:'변경직급',version:2})))]);
    }
    return batch(statements);
  };
  const ids=members.map(value=>value.id).reverse();
  const response=await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:ids,version:0}});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).memberOrder,{memberIds:ids,version:1});
  const data=await (await f.call('/admin/data',{cookie:admin})).json();
  const changed=data.members.find(value=>value.id==='m000');
  assert.equal(changed.team,'변경팀');assert.equal(changed.position,'변경직급');assert.equal(changed.version,2);
});

test('department chart infers one leader and the first four existing teams in current member-number order without hiding overflow',async t=>{
  const members=[member('leader',{position:'가상과장',team:'과장실'}),member('a1',{team:'교육팀'}),member('a2',{team:'교육팀'}),member('b',{team:'운영팀'}),member('c',{team:'지원팀'}),member('d',{team:'시설팀'}),member('e',{team:'추가팀'}),member('none',{team:''}),member('left',{active:false,position:'과장'})];
  const f=await fixture(t,{courses:[],members}),admin=await f.login();
  const order=['b','a2','a1','leader','c','d','e','none'];
  assert.equal((await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:order,version:0}})).status,200);
  const data=await (await f.call('/admin/data',{cookie:admin})).json();
  const chart=data.departmentChart;
  assert.equal(chart.version,0);assert.equal(chart.leaderId,'leader');
  assert.deepEqual(chart.teams.map(team=>[team.id,team.name]),[['team-1','운영팀'],['team-2','교육팀'],['team-3','지원팀'],['team-4','시설팀']]);
  assert.deepEqual(chart.teams[1].memberIds,['a2','a1']);
  assert.deepEqual(chart.unassignedMemberIds,['e','none']);
  assert.deepEqual(chartPeople(chart).sort(),order.slice().sort());
  assert.deepEqual((await (await f.call('/bootstrap')).json()).departmentChart,chart);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection = 'settings' AND id = 'department-chart'").first()).count,0);
});

test('department chart keeps the leader empty when absent or ambiguous and always supplies four unique team slots',async t=>{
  const empty=await fixture(t,{courses:[],members:[member('m1',{team:''}),member('m2',{team:''})]});
  const chart=(await (await empty.call('/bootstrap')).json()).departmentChart;
  assert.equal(chart.leaderId,'');assert.deepEqual(chart.teams.map(team=>team.name),['1팀','2팀','3팀','4팀']);
  assert.deepEqual(chart.unassignedMemberIds,['m1','m2']);
  const ambiguous=await fixture(t,{courses:[],members:[member('m1',{position:'과장',team:'3팀'}),member('m2',{team:'과장실'})]});
  const other=(await (await ambiguous.call('/bootstrap')).json()).departmentChart;
  assert.equal(other.leaderId,'');assert.equal(new Set(other.teams.map(team=>team.name)).size,4);
  assert.deepEqual(chartPeople(other).sort(),['m1','m2']);
});

test('department chart allows an explicitly empty manual layout and a roster with no active employees',async t=>{
  const f=await fixture(t,{courses:[],members:[member('m1',{position:'과장'}),member('m2')]}),admin=await f.login();
  assert.equal((await (await f.call('/bootstrap')).json()).departmentChart.leaderId,'m1');
  const response=await f.call('/admin/department-chart',{method:'PUT',cookie:admin,body:chartInput({teamMembers:[[],[],[],[]]})});
  assert.equal(response.status,200);
  const chart=(await response.json()).departmentChart;
  assert.equal(chart.leaderId,'');assert.equal(chart.version,1);assert.deepEqual(chart.unassignedMemberIds,['m1','m2']);
  assert.ok(chart.teams.every(team=>team.memberIds.length===0));
  assert.deepEqual((await (await f.call('/bootstrap')).json()).departmentChart,chart,'an explicit empty leader is preserved rather than inferred again');
  const empty=await fixture(t,{courses:[],members:[member('left',{active:false})]}),emptyAdmin=await empty.login();
  const saved=await empty.call('/admin/department-chart',{method:'PUT',cookie:emptyAdmin,body:chartInput({teamMembers:[[],[],[],[]],activeMemberIds:[]})});
  assert.equal(saved.status,200);assert.deepEqual(chartPeople((await saved.json()).departmentChart),[]);
});

test('department chart requires admin authentication and same-origin requests and validates team/leader placement and current roster',async t=>{
  const f=await fixture(t,{courses:[],members:[member('m1'),member('m2'),member('left',{active:false})]}),admin=await f.login(),selected=await f.select();
  assert.equal((await f.call('/admin/department-chart',{method:'PUT',body:chartInput()})).status,401);
  assert.equal((await f.call('/admin/department-chart',{method:'PUT',cookie:selected,body:chartInput()})).status,401);
  assert.equal((await f.call('/admin/department-chart',{method:'PUT',cookie:admin,origin:'https://other.example',body:chartInput()})).status,403);
  const invalid=[];
  const add=(change,status=400)=>{const body=chartInput();change(body);invalid.push([body,status]);};
  add(body=>{delete body.leaderId;});add(body=>{body.leaderId='unknown';});add(body=>{body.leaderId='left';});
  add(body=>{body.leaderId='m1';});add(body=>{body.teams[1].memberIds=['m1'];});add(body=>{body.teams[0].memberIds=['m1','m1'];});
  add(body=>{body.teams[0].memberIds=['unknown'];});add(body=>{body.teams[0].memberIds=['left'];});
  add(body=>{body.teams.pop();});add(body=>{body.teams.push({id:'team-5',name:'5팀',memberIds:[]});});
  add(body=>{body.teams.reverse();});add(body=>{body.teams[1].id='team-1';});
  add(body=>{body.teams[0].name=' ';});add(body=>{body.teams[0].name='가'.repeat(101);});
  add(body=>{body.teams[1].name=' 1팀 ';});add(body=>{body.teams[0].name='Team';body.teams[1].name='team';});
  add(body=>{delete body.activeMemberIds;});add(body=>{body.activeMemberIds=['m1','m1'];});add(body=>{body.activeMemberIds=['m1','unknown'];});
  add(body=>{body.activeMemberIds=['m1'];},409);add(body=>{body.activeMemberIds.push('left');},409);
  add(body=>{delete body.version;});add(body=>{body.version=1;},409);
  for(const [body,status] of invalid)assert.equal((await f.call('/admin/department-chart',{method:'PUT',cookie:admin,body})).status,status);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection IN ('settings','audit')").first()).count,0);
});

test('department chart persists canonical placement and audit separately from number order, employees, completions and original files',async t=>{
  const f=await fixture(t,{courses:[course('c1')],members:[member('m1'),member('m2',{legacyCompletions:['c1']}),member('m3')]}),admin=await f.login(),selected=await f.select();
  assert.equal((await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:['m3','m2','m1'],version:0}})).status,200);
  const submitted=await f.call('/submissions',{method:'POST',cookie:selected,body:f.form({file:PNG,name:'가상수료증.png',type:'image/png'})});
  assert.equal(submitted.status,201);const submission=(await submitted.json()).submission;
  const snapshot=()=>f.env.DB.prepare("SELECT collection,id,data,version FROM records WHERE collection != 'audit' AND NOT (collection = 'settings' AND id = 'department-chart') ORDER BY collection,id").all();
  const before=(await snapshot()).results;
  const body=chartInput({leaderId:'m2',teamMembers:[['m1'],[],[],[]],names:[' 교육팀 ','운영팀','지원팀','시설팀'],activeMemberIds:['m1','m2','m3']});
  const response=await f.call('/admin/department-chart',{method:'PUT',cookie:admin,body});
  assert.equal(response.status,200);
  const chart=(await response.json()).departmentChart;
  assert.equal(chart.leaderId,'m2');assert.equal(chart.version,1);assert.equal(chart.teams[0].name,'교육팀');
  assert.deepEqual(chart.teams[0].memberIds,['m1']);assert.deepEqual(chart.unassignedMemberIds,['m3']);
  assert.deepEqual(chartPeople(chart).sort(),['m1','m2','m3']);
  assert.deepEqual((await snapshot()).results,before);
  const data=await (await f.call('/admin/data',{cookie:admin})).json();
  assert.deepEqual(data.departmentChart,chart);assert.deepEqual(data.memberOrder,{memberIds:['m3','m2','m1'],version:1});
  const audit=data.audit.filter(value=>value.action==='department_chart_updated');assert.equal(audit.length,1);assert.equal(audit[0].detail.leaderId,'m2');
  const original=await f.call(`/files/${submission.files[0].id}`,{cookie:selected});assert.deepEqual(Buffer.from(await original.arrayBuffer()),PNG);
});

test('saved department assignments follow later member-number changes and expose added and transferred employees without omissions',async t=>{
  const f=await fixture(t,{courses:[],members:[member('m1'),member('m2'),member('m3'),member('m4')]}),admin=await f.login();
  const body=chartInput({leaderId:'m3',teamMembers:[['m2','m1'],[],[],[]],activeMemberIds:['m1','m2','m3','m4']});
  const response=await f.call('/admin/department-chart',{method:'PUT',cookie:admin,body});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).departmentChart.teams[0].memberIds,['m1','m2']);
  const savedBefore=await f.env.DB.prepare("SELECT data FROM records WHERE collection = 'settings' AND id = 'department-chart'").first();
  assert.equal((await f.call('/admin/member-order',{method:'PUT',cookie:admin,body:{memberIds:['m4','m2','m1','m3'],version:0}})).status,200);
  const reordered=(await (await f.call('/bootstrap')).json()).departmentChart;
  assert.deepEqual(reordered.teams[0].memberIds,['m2','m1']);assert.deepEqual(reordered.unassignedMemberIds,['m4']);assert.equal(reordered.version,1);
  assert.deepEqual(await f.env.DB.prepare("SELECT data FROM records WHERE collection = 'settings' AND id = 'department-chart'").first(),savedBefore);
  const newResponse=await f.call('/admin/members',{method:'POST',cookie:admin,body:{name:'가상신규직원',active:true}});assert.equal(newResponse.status,201);
  const newcomer=(await newResponse.json()).member;
  let current=(await (await f.call('/bootstrap')).json()).departmentChart;
  assert.deepEqual(current.unassignedMemberIds,['m4',newcomer.id]);
  assert.equal((await f.call('/admin/members/m3',{method:'PUT',cookie:admin,body:{...member('m3'),active:false,leftOn:'2026-10-01'}})).status,200);
  assert.equal((await f.call('/admin/members/m2',{method:'PUT',cookie:admin,body:{...member('m2'),active:false,leftOn:'2026-10-01'}})).status,200);
  current=(await (await f.call('/bootstrap')).json()).departmentChart;
  assert.equal(current.leaderId,'');assert.deepEqual(current.teams[0].memberIds,['m1']);assert.equal(current.version,1);
  assert.deepEqual(chartPeople(current).sort(),['m1','m4',newcomer.id].sort());
  assert.equal((await f.call('/admin/department-chart',{method:'PUT',cookie:admin,body:{...body,version:1}})).status,409);
});

test('concurrent initial and subsequent department-chart saves accept one version and create one audit each',async t=>{
  const f=await fixture(t),admin=await f.login();
  for(const expectedVersion of [0,1]) {
    const batch=f.env.DB.batch.bind(f.env.DB);let calls=0,release;const barrier=new Promise(resolve=>{release=resolve;});
    f.env.DB.batch=async statements=>{if(++calls===2)release();await barrier;return batch(statements);};
    const responses=await Promise.all([
      f.call('/admin/department-chart',{method:'PUT',cookie:admin,body:chartInput({version:expectedVersion})}),
      f.call('/admin/department-chart',{method:'PUT',cookie:admin,body:chartInput({leaderId:'m2',teamMembers:[['m1'],[],[],[]],version:expectedVersion})}),
    ]);
    f.env.DB.batch=batch;assert.deepEqual(responses.map(value=>value.status).sort(),[200,409]);
    const winner=(await responses.find(value=>value.status===200).json()).departmentChart;
    const data=await (await f.call('/admin/data',{cookie:admin})).json();
    assert.deepEqual(data.departmentChart,winner);assert.equal(data.departmentChart.version,expectedVersion+1);
    assert.equal(data.audit.filter(value=>value.action==='department_chart_updated').length,expectedVersion+1);
    assert.equal(data.memberOrder.version,0);
  }
});

for(const rosterChange of ['addition','transfer','replacement']) test(`department-chart atomic guard rejects a concurrent roster ${rosterChange} without changing its placement or audit`,async t=>{
  const f=await fixture(t),admin=await f.login();
  assert.equal((await f.call('/admin/department-chart',{method:'PUT',cookie:admin,body:chartInput()})).status,200);
  const before=await f.env.DB.prepare("SELECT data FROM records WHERE collection = 'settings' AND id = 'department-chart'").first();
  const batch=f.env.DB.batch.bind(f.env.DB);let changed=false;
  f.env.DB.batch=async statements=>{
    if(!changed) {
      changed=true;const mutations=[];
      if(rosterChange!=='transfer')mutations.push(f.env.DB.prepare('INSERT INTO records(collection,id,data,version) VALUES(?,?,?,?)').bind('members','m3',JSON.stringify(member('m3')),1));
      if(rosterChange!=='addition')mutations.push(f.env.DB.prepare("UPDATE records SET data = ?, version = 2 WHERE collection = 'members' AND id = 'm2'").bind(JSON.stringify(member('m2',{active:false,version:2}))));
      await batch(mutations);
    }
    return batch(statements);
  };
  const response=await f.call('/admin/department-chart',{method:'PUT',cookie:admin,body:chartInput({version:1})});
  assert.equal(response.status,409);assert.equal((await response.json()).code,'VERSION_CONFLICT');
  assert.deepEqual(await f.env.DB.prepare("SELECT data FROM records WHERE collection = 'settings' AND id = 'department-chart'").first(),before);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection = 'audit' AND json_extract(data,'$.action') = 'department_chart_updated'").first()).count,1);
});

test('department-chart saving supports large active rosters with bounded SQL parameters and permits concurrent personnel-field edits',async t=>{
  const members=Array.from({length:125},(_,index)=>member(`m${String(index).padStart(3,'0')}`));
  const f=await fixture(t,{courses:[],members}),admin=await f.login();
  const prepare=f.env.DB.prepare.bind(f.env.DB),batch=f.env.DB.batch.bind(f.env.DB);let changed=false;
  f.env.DB.prepare=sql=>{const statement=prepare(sql),bind=statement.bind.bind(statement);statement.bind=(...values)=>{assert.ok(values.length<100);return bind(...values);};return statement;};
  f.env.DB.batch=async statements=>{
    if(!changed){changed=true;await batch([prepare("UPDATE records SET data = ?, version = 2 WHERE collection = 'members' AND id = 'm000'").bind(JSON.stringify(member('m000',{team:'변경팀',position:'변경직급',version:2})))]);}
    return batch(statements);
  };
  const ids=members.map(value=>value.id),body=chartInput({teamMembers:[ids.slice(0,30),ids.slice(30,60),ids.slice(60,90),ids.slice(90,120)],activeMemberIds:ids});
  const response=await f.call('/admin/department-chart',{method:'PUT',cookie:admin,body});assert.equal(response.status,200);
  const chart=(await response.json()).departmentChart;assert.equal(chartPeople(chart).length,125);assert.equal(new Set(chartPeople(chart)).size,125);assert.equal(chart.unassignedMemberIds.length,5);
  const data=await (await f.call('/admin/data',{cookie:admin})).json(),edited=data.members.find(value=>value.id==='m000');
  assert.equal(edited.team,'변경팀');assert.equal(edited.position,'변경직급');assert.equal(edited.version,2);
});

test('personnel history requires an administrator and distinguishes missing members from empty history',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/admin/members/m1/history')).status,401);
  const selected=await f.select();
  assert.equal((await f.call('/admin/members/m1/history',{cookie:selected})).status,401);
  const admin=await f.login();
  assert.equal((await f.call('/admin/members/missing/history',{cookie:admin})).status,404);
  const response=await f.call('/admin/members/m1/history',{cookie:admin});
  assert.equal(response.status,200);
  const data=await response.json();
  assert.deepEqual(data.history,[]);
  assert.ok(Number.isFinite(Date.parse(data.serverTime)));
});

test('personnel history retains creation and transfer changes made through the member API',async t=>{
  const f=await fixture(t),admin=await f.login();
  const createdResponse=await f.call('/admin/members',{method:'POST',cookie:admin,body:{name:'가상직원',position:'행정9급',team:'교육팀',active:true,joinedOn:'2026-01-01'}});
  assert.equal(createdResponse.status,201);
  const created=(await createdResponse.json()).member;
  const updatedResponse=await f.call(`/admin/members/${created.id}`,{method:'PUT',cookie:admin,body:{...created,team:'인사팀',active:false,leftOn:'2026-10-01'}});
  assert.equal(updatedResponse.status,200);
  assert.equal((await f.call('/admin/members/m2',{method:'PUT',cookie:admin,body:{...member('m2'),team:'다른팀'}})).status,200);
  const response=await f.call(`/admin/members/${created.id}/history`,{cookie:admin});
  assert.equal(response.status,200,'transferred members retain their history');
  const {history}=await response.json();
  assert.equal(history.length,2);
  assert.ok(history.every(entry=>entry.detail.memberId===created.id));
  assert.equal(history.find(entry=>entry.action==='member_created').detail.name,'가상직원');
  const change=history.find(entry=>entry.action==='member_updated');
  assert.equal(change.detail.before.team,'교육팀');
  assert.equal(change.detail.before.active,true);
  assert.equal(change.detail.after.team,'인사팀');
  assert.equal(change.detail.after.active,false);
  assert.equal(change.detail.after.leftOn,'2026-10-01');
});

test('personnel history selects only the requested member changes in newest order beyond the 500-entry dashboard limit',async t=>{
  const f=await fixture(t),admin=await f.login();
  const entry=(id,action,memberId,createdAt)=>({id,action,detail:{memberId,name:`가상${memberId}`},actor:'admin',createdAt,version:1});
  const older=[
    entry('old-created','member_created','m1','2024-01-01T00:00:00.000Z'),
    entry('update-a','member_updated','m1','2024-02-01T00:00:00.000Z'),
    entry('update-z','member_updated','m1','2024-02-01T00:00:00.000Z'),
    entry('wrong-action','submission_reviewed','m1','2024-03-01T00:00:00.000Z'),
    entry('other-member','member_updated','m2','2024-03-01T00:00:00.000Z'),
  ];
  const recent=Array.from({length:505},(_,index)=>entry(`recent-${index}`,'member_updated','m2','2025-01-01T00:00:00.000Z'));
  await f.env.DB.batch([...older,...recent].map(value=>f.env.DB.prepare('INSERT INTO records(collection,id,data,version) VALUES(?,?,?,?)').bind('audit',value.id,JSON.stringify(value),1)));
  const dashboard=await (await f.call('/admin/data',{cookie:admin})).json();
  assert.equal(dashboard.audit.length,500);
  assert.ok(dashboard.audit.every(value=>value.id.startsWith('recent-')),'older personnel entries have left the dashboard window');
  const response=await f.call('/admin/members/m1/history',{cookie:admin});
  assert.equal(response.status,200);
  const {history,serverTime}=await response.json();
  assert.deepEqual(history.map(value=>value.id),['update-z','update-a','old-created']);
  assert.ok(history.every(value=>value.detail.memberId==='m1' && ['member_created','member_updated'].includes(value.action)));
  assert.ok(Number.isFinite(Date.parse(serverTime)));
});

test('PDF upload persists original bytes and prevents another selected person reading it',async t=>{
  const f=await fixture(t);
  const cookie=await f.select();
  const response=await f.call('/submissions',{method:'POST',cookie,body:f.form()});
  assert.equal(response.status,201,await response.clone().text());
  const {submission}=await response.json();
  assert.equal(submission.status,'pending'); assert.equal(submission.revision,1);
  assert.equal('key' in submission.files[0],false);
  const mine=await f.call('/me',{cookie});
  assert.equal((await mine.json()).submissions.length,1);
  const file=await f.call(`/files/${submission.files[0].id}`,{cookie});
  assert.equal(file.status,200); assert.equal(file.headers.get('content-type'),'application/pdf');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()),PDF);
  assert.equal((await f.call(`/files/${submission.files[0].id}`)).status,401);
  const other=await f.select('m2');
  assert.equal((await f.call(`/files/${submission.files[0].id}`,{cookie:other})).status,403);
  assert.equal((await (await f.call('/me',{cookie:other})).json()).submissions.length,0);
  const admin=await f.login();
  assert.equal((await f.call(`/files/${submission.files[0].id}?download=1`,{cookie:admin})).status,200);
});

test('file access requests record server-derived roles without original names, contents or credentials',async t=>{
  const f=await fixture(t),cookie=await f.select(),admin=await f.login();
  const originalName='가상직원_1990-01-02_원본.png';
  const submitted=await f.call('/submissions',{method:'POST',cookie,body:f.form({file:PNG,name:originalName,type:'image/png'})});
  assert.equal(submitted.status,201);
  const submission=(await submitted.json()).submission,file=submission.files[0];
  const readAudits=async()=>((await f.env.DB.prepare("SELECT data FROM records WHERE collection='audit' AND json_extract(data,'$.action')='certificate_access_requested' ORDER BY rowid").all()).results).map(row=>JSON.parse(row.data));
  assert.equal((await f.call(`/files/${file.id}`)).status,401);
  assert.equal((await f.call(`/files/${file.id}`,{cookie:await f.select('m2')})).status,403);
  assert.equal((await readAudits()).length,0,'denied requests are not represented as accepted');
  const preview=await f.call(`/files/${file.id}`,{cookie});
  assert.equal(preview.status,200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()),PNG);
  const download=await f.call(`/files/${file.id}?download=1&actorRole=admin&requestId=client-forged`,{cookie});
  assert.equal(download.status,200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),PNG);
  const adminDownload=await f.call(`/files/${file.id}?download=1`,{cookie:admin});
  assert.equal(adminDownload.status,200);
  assert.deepEqual(Buffer.from(await adminDownload.arrayBuffer()),PNG);
  const entries=await readAudits();
  assert.equal(entries.length,3);
  assert.deepEqual(entries.map(entry=>entry.actor),['m1','m1','admin']);
  assert.deepEqual(entries.map(entry=>entry.detail.accessMode),['preview','download','download']);
  assert.deepEqual(entries.map(entry=>entry.detail.actorRole),['member','member','admin']);
  assert.deepEqual(entries.map(entry=>entry.detail.identityAssurance),['name_selection_unverified','name_selection_unverified','shared_admin_password']);
  assert.equal(new Set(entries.map(entry=>entry.detail.requestId)).size,3);
  for(const entry of entries) {
    assert.deepEqual(Object.keys(entry.detail).sort(),['fileId','courseId','memberId','submissionId','actorRole','identityAssurance','accessMode','requestAcceptedAt','requestId'].sort());
    assert.equal(entry.detail.fileId,file.id);assert.equal(entry.detail.courseId,'c1');
    assert.equal(entry.detail.memberId,'m1');assert.equal(entry.detail.submissionId,submission.id);
    assert.match(entry.detail.requestId,/^[a-f0-9-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(entry.detail.requestAcceptedAt)));
  }
  const serialized=JSON.stringify(entries);
  for(const excluded of [originalName,'1990-01-02','test-admin-password',cookie,admin,PNG.toString('base64'),'client-forged']) assert.equal(serialized.includes(excluded),false,excluded);
  const dashboard=await (await f.call('/admin/data',{cookie:admin})).json();
  assert.equal(dashboard.audit.filter(entry=>entry.action==='certificate_access_requested').length,3);
});

test('individual file delivery fails closed and cancels its opened stream when access auditing fails',async t=>{
  const f=await fixture(t),cookie=await f.select();
  const submitted=await f.call('/submissions',{method:'POST',cookie,body:f.form({file:PNG,name:'가상원본.png',type:'image/png'})});
  assert.equal(submitted.status,201);
  const file=(await submitted.json()).submission.files[0];
  await f.env.DB.exec("CREATE TRIGGER reject_access_audit BEFORE INSERT ON records WHEN NEW.collection='audit' AND json_extract(NEW.data,'$.action')='certificate_access_requested' BEGIN SELECT RAISE(ABORT,'synthetic audit unavailable'); END;");
  let cancelled=0;
  f.env.FILES.get=async()=>({size:PNG.length,body:new ReadableStream({cancel(){cancelled++;return Promise.reject(new Error('synthetic cancellation failure'));}})});
  const response=await f.call(`/files/${file.id}`,{cookie});
  assert.equal(response.status,503);assert.equal((await response.json()).code,'FILE_ACCESS_AUDIT_FAILED');
  assert.equal(cancelled,1,'best-effort cancellation does not mask the audit error or send the file');
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection='audit' AND json_extract(data,'$.action')='certificate_access_requested'").first()).count,0);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection='files'").first()).count,1);
});

test('ZIP records every included file under one request before transfer and preserves the legacy summary',async t=>{
  const f=await fixture(t),cookie=await f.select(),admin=await f.login();
  const body=f.form({file:PNG,name:'가상직원_1990-01-02_첫번째.png',type:'image/png'});
  body.append('files',new File([PNG],'가상직원_1990-01-02_두번째.png',{type:'image/png'}));
  const submitted=await f.call('/submissions',{method:'POST',cookie,body});
  assert.equal(submitted.status,201);
  const submission=(await submitted.json()).submission;
  const response=await f.call('/admin/courses/c1/download?scope=latest',{cookie:admin});
  assert.equal(response.status,200);
  const records=((await f.env.DB.prepare("SELECT data FROM records WHERE collection='audit'").all()).results).map(row=>JSON.parse(row.data));
  const accesses=records.filter(entry=>entry.action==='certificate_access_requested');
  const summaries=records.filter(entry=>entry.action==='certificates_downloaded');
  assert.equal(accesses.length,2);assert.equal(summaries.length,1);
  const summary=summaries[0];
  assert.equal(summary.detail.courseId,'c1');assert.equal(summary.detail.scope,'latest');
  assert.equal(summary.detail.fileCount,2);assert.equal(summary.detail.totalBytes,2*PNG.length);
  assert.deepEqual(new Set(accesses.map(entry=>entry.detail.fileId)),new Set(submission.files.map(file=>file.id)));
  for(const entry of accesses) {
    assert.equal(entry.actor,'admin');assert.equal(entry.detail.actorRole,'admin');
    assert.equal(entry.detail.identityAssurance,'shared_admin_password');assert.equal(entry.detail.accessMode,'zip');
    assert.equal(entry.detail.memberId,'m1');assert.equal(entry.detail.submissionId,submission.id);
    assert.equal(entry.detail.requestId,summary.detail.requestId);assert.equal(entry.detail.requestAcceptedAt,summary.detail.requestAcceptedAt);
  }
  assert.equal(JSON.stringify([...accesses,summary]).includes('1990-01-02'),false);
  await response.body.cancel();
  const count=await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection='audit' AND json_extract(data,'$.action')='certificate_access_requested'").first();
  assert.equal(count.count,2,'request acceptance remains recorded even if the recipient cancels the transfer');
});

test('a ZIP audit failure rolls back per-file records and blocks opening the ZIP file streams',async t=>{
  const f=await fixture(t),cookie=await f.select(),admin=await f.login();
  const body=f.form({file:PNG,name:'가상첫파일.png',type:'image/png'});
  body.append('files',new File([PNG],'가상둘째파일.png',{type:'image/png'}));
  assert.equal((await f.call('/submissions',{method:'POST',cookie,body})).status,201);
  await f.env.DB.exec("CREATE TRIGGER reject_zip_summary BEFORE INSERT ON records WHEN NEW.collection='audit' AND json_extract(NEW.data,'$.action')='certificates_downloaded' BEGIN SELECT RAISE(ABORT,'synthetic summary unavailable'); END;");
  let opened=0;
  const get=f.env.FILES.get.bind(f.env.FILES);
  f.env.FILES.get=async(...args)=>{opened++;return get(...args);};
  const response=await f.call('/admin/courses/c1/download?scope=latest',{cookie:admin});
  assert.equal(response.status,503);assert.equal((await response.json()).code,'FILE_ACCESS_AUDIT_FAILED');
  assert.equal(opened,0);
  const recorded=await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection='audit' AND json_extract(data,'$.action') IN ('certificate_access_requested','certificates_downloaded')").first();
  assert.equal(recorded.count,0,'all requested files and their summary are one atomic audit write');
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection='files'").first()).count,2);
});

test('file access history requires an administrator and validates its file, cursor and bounded page size',async t=>{
  const f=await fixture(t),admin=await f.login(),selected=await f.select();
  assert.equal((await f.call('/admin/file-access')).status,401);
  assert.equal((await f.call('/admin/file-access',{cookie:selected})).status,401);
  for(const query of ['limit=0','limit=101','limit=-1','limit=1.5','limit=abc','limit=','fileId=..%2Fother','cursor=not!base64']) {
    assert.equal((await f.call(`/admin/file-access?${query}`,{cookie:admin})).status,400,query);
  }
  for(const value of [[],{createdAt:'invalid',id:'entry'},{createdAt:'2026-02-30T00:00:00.000Z',id:'entry'},{createdAt:timestamp,id:'../entry'}]) {
    const cursor=Buffer.from(JSON.stringify(value)).toString('base64url');
    assert.equal((await f.call(`/admin/file-access?cursor=${cursor}`,{cookie:admin})).status,400);
  }
  const empty=await (await f.call('/admin/file-access?fileId=unknown',{cookie:admin})).json();
  assert.deepEqual(empty.entries,[]);assert.equal(empty.nextCursor,null);
  assert.ok(Number.isFinite(Date.parse(empty.serverTime)));
});

test('dedicated file access history finds old files beyond the dashboard limit and defaults to 50 with a maximum of 100',async t=>{
  const f=await fixture(t),admin=await f.login(),statements=[];
  for(let index=0;index<120;index++) {
    const entry={id:`access-${String(index).padStart(3,'0')}`,action:'certificate_access_requested',actor:'admin',createdAt:new Date(Date.UTC(2020,0,1,0,0,index)).toISOString(),version:1,detail:{fileId:index===0?'file-oldest':'file-other',actorRole:'admin',identityAssurance:'shared_admin_password',accessMode:'preview',requestId:`request-${index}`,requestAcceptedAt:timestamp}};
    statements.push(f.env.DB.prepare("INSERT INTO records(collection,id,data,version) VALUES('audit',?,?,1)").bind(entry.id,JSON.stringify(entry)));
  }
  for(let index=0;index<500;index++) {
    const entry={id:`newer-${String(index).padStart(3,'0')}`,action:'course_updated',actor:'admin',createdAt:timestamp,version:1,detail:{courseId:'c1'}};
    statements.push(f.env.DB.prepare("INSERT INTO records(collection,id,data,version) VALUES('audit',?,?,1)").bind(entry.id,JSON.stringify(entry)));
  }
  await f.env.DB.batch(statements);
  const dashboard=await (await f.call('/admin/data',{cookie:admin})).json();
  assert.equal(dashboard.audit.length,500);assert.equal(dashboard.audit.some(entry=>entry.action==='certificate_access_requested'),false);
  const first=await (await f.call('/admin/file-access',{cookie:admin})).json();
  assert.equal(first.entries.length,50);assert.equal(first.entries[0].id,'access-119');assert.ok(first.nextCursor);
  const large=await (await f.call('/admin/file-access?limit=100',{cookie:admin})).json();
  assert.equal(large.entries.length,100);assert.ok(large.nextCursor);
  const filtered=await (await f.call('/admin/file-access?fileId=file-oldest',{cookie:admin})).json();
  assert.deepEqual(filtered.entries.map(entry=>entry.id),['access-000']);assert.equal(filtered.nextCursor,null);
});

test('file access keyset paging keeps equal timestamps ordered and avoids duplicates when a newer request arrives',async t=>{
  const f=await fixture(t),admin=await f.login();
  const add=async(id,createdAt=timestamp,fileId='paged-file')=>{
    const entry={id,action:'certificate_access_requested',actor:'admin',createdAt,version:1,detail:{fileId,accessMode:'download',actorRole:'admin',identityAssurance:'shared_admin_password',requestId:`request-${id}`,requestAcceptedAt:createdAt}};
    await f.env.DB.prepare("INSERT INTO records(collection,id,data,version) VALUES('audit',?,?,1)").bind(id,JSON.stringify(entry)).run();
  };
  for(let index=0;index<9;index++) await add(`tied-${index}`);
  await add('older-1','2025-12-31T23:59:59.000Z');await add('older-2','2025-12-31T23:59:59.000Z');
  await add('unrelated-newest','2026-12-31T00:00:00.000Z','another-file');
  const collected=[],cursors=new Set();let cursor=null,pages=0;
  do {
    const query=new URLSearchParams({fileId:'paged-file',limit:'3'});
    if(cursor)query.set('cursor',cursor);
    const response=await f.call(`/admin/file-access?${query}`,{cookie:admin});
    assert.equal(response.status,200);
    const page=await response.json();
    collected.push(...page.entries.map(entry=>entry.id));
    assert.ok(page.entries.every(entry=>entry.detail.fileId==='paged-file'));
    cursor=page.nextCursor;
    if(cursor) {assert.equal(cursors.has(cursor),false);cursors.add(cursor);}
    if(++pages===1)await add('arrived-after-first-page','2026-01-02T00:00:00.000Z');
    assert.ok(pages<10);
  } while(cursor);
  assert.deepEqual(collected,['tied-8','tied-7','tied-6','tied-5','tied-4','tied-3','tied-2','tied-1','tied-0','older-2','older-1']);
  assert.equal(new Set(collected).size,collected.length);
  const refreshed=await (await f.call('/admin/file-access?fileId=paged-file',{cookie:admin})).json();
  assert.equal(refreshed.entries[0].id,'arrived-after-first-page');
});

test('signature spoofing, wrong extension, empty files and cross-tab identity changes are rejected',async t=>{
  const f=await fixture(t);
  const cookie=await f.select();
  assert.equal((await f.call('/submissions',{method:'POST',cookie,body:f.form({file:'this is not a pdf'})})).status,415);
  assert.equal((await f.call('/submissions',{method:'POST',cookie,body:f.form({file:PDF,name:'payload.exe'})})).status,415);
  assert.equal((await f.call('/submissions',{method:'POST',cookie,body:f.form({file:new Uint8Array()})})).status,413);
  const changed=await f.call('/submissions',{method:'POST',cookie,body:f.form({expectedMemberId:'m2'})});
  assert.equal(changed.status,409); assert.equal((await changed.json()).code,'MEMBER_CHANGED');
  const response=await f.call('/submissions',{method:'POST',cookie,body:f.form({file:PNG,name:'사진.png',type:'image/png'})});
  assert.equal(response.status,201,await response.clone().text());
  assert.equal((await response.json()).submission.files[0].type,'image/png');
});

test('review → correction → resubmit retains history and only the latest submission can be reviewed',async t=>{
  const f=await fixture(t);
  const memberCookie=await f.select(),adminCookie=await f.login();
  const first=(await (await f.call('/submissions',{method:'POST',cookie:memberCookie,body:f.form()})).json()).submission;
  const revision=await f.call(`/admin/submissions/${first.id}/review`,{method:'POST',cookie:adminCookie,body:{status:'needs_revision',reviewNote:'과정명을 확인해 주세요.',version:first.version}});
  assert.equal(revision.status,200);
  const second=(await (await f.call('/submissions',{method:'POST',cookie:memberCookie,body:f.form({name:'수료증_보완.pdf'})})).json()).submission;
  assert.equal(second.revision,2);
  assert.ok(second.submittedAt>first.submittedAt);
  const stale=await f.call(`/admin/submissions/${first.id}/review`,{method:'POST',cookie:adminCookie,body:{status:'approved',reviewNote:'',version:2}});
  assert.equal(stale.status,409);
  const approved=await f.call(`/admin/submissions/${second.id}/review`,{method:'POST',cookie:adminCookie,body:{status:'approved',reviewNote:'확인',version:second.version}});
  assert.equal(approved.status,200);
  const mine=await (await f.call('/me',{cookie:memberCookie})).json();
  assert.equal(mine.submissions.length,2);
  assert.equal(mine.submissions.find(value=>value.id===first.id).status,'needs_revision');
  assert.equal(mine.submissions.find(value=>value.id===second.id).status,'approved');
  assert.equal((await f.call('/submissions',{method:'POST',cookie:memberCookie,body:f.form()})).status,409);
});

test('manual override requires a reason, protects its version and clears on a new submission',async t=>{
  const f=await fixture(t,{courses:[course('c1')],members:[member('m1',{legacyCompletions:['c1']})]});
  const admin=await f.login(),memberCookie=await f.select();
  assert.equal((await f.call('/admin/overrides/m1/c1',{method:'PUT',cookie:admin,body:{status:'not_submitted',reason:'',version:0}})).status,400);
  const response=await f.call('/admin/overrides/m1/c1',{method:'PUT',cookie:admin,body:{status:'not_submitted',reason:'증빙 재확인',version:0}});
  assert.equal(response.status,200);
  assert.equal((await f.call('/admin/overrides/m1/c1',{method:'PUT',cookie:admin,body:{status:'exempt',reason:'뒤늦은 처리',version:0}})).status,409);
  const submitted=await f.call('/submissions',{method:'POST',cookie:memberCookie,body:f.form()});
  assert.equal(submitted.status,201,await submitted.clone().text());
  const mine=await (await f.call('/me',{cookie:memberCookie})).json();
  assert.equal(mine.overrides.length,0); assert.equal(mine.submissions[0].status,'pending');
});

test('target selection, exemptions, unpublished and archived courses reject uploads',async t=>{
  const f=await fixture(t,{courses:[course('selected',{targetMode:'selected',targetMemberIds:['m2']}),course('exempt',{exemptMemberIds:['m1']}),course('draft',{published:false}),course('archive',{archived:true})],members:[member('m1'),member('m2')]});
  const cookie=await f.select();
  for (const courseId of ['selected','exempt','draft','archive']) assert.equal((await f.call('/submissions',{method:'POST',cookie,body:f.form({courseId})})).status,403,courseId);
  const admin=await f.login();
  assert.equal((await f.call('/admin/members/m1',{method:'PUT',cookie:admin,body:{...member('m1'),active:false,leftOn:'2026-01-01'}})).status,200);
  assert.equal((await f.call('/me',{cookie})).status,403);
});

test('education ZIP includes approved latest originals and fails rather than skipping missing files',async t=>{
  const f=await fixture(t);
  const admin=await f.login(),cookie=await f.select();
  assert.equal((await f.call('/admin/courses/c1/download',{cookie:admin})).status,404);
  const first=(await (await f.call('/submissions',{method:'POST',cookie,body:f.form()})).json()).submission;
  assert.equal((await f.call('/admin/courses/c1/download?scope=approved',{cookie:admin})).status,404);
  const pendingZip=await f.call('/admin/courses/c1/download?scope=latest',{cookie:admin});
  assert.equal(pendingZip.status,200);
  const pendingBytes=Buffer.from(await pendingZip.arrayBuffer());
  assert.equal(pendingBytes.readUInt32LE(0),0x04034b50);
  assert.ok(pendingBytes.includes(Buffer.from(PDF)));
  assert.ok(pendingBytes.includes(Buffer.from('확인중')));
  assert.equal((await f.call(`/admin/submissions/${first.id}/review`,{method:'POST',cookie:admin,body:{status:'approved',reviewNote:'확인',version:1}})).status,200);
  const zip=await f.call('/admin/courses/c1/download?scope=approved',{cookie:admin});
  assert.equal(zip.status,200);
  const bytes=Buffer.from(await zip.arrayBuffer());
  assert.ok(bytes.includes(Buffer.from('승인')));
  assert.ok(bytes.includes(Buffer.from('직원m1')));
  const record=JSON.parse((await f.env.DB.prepare("SELECT data FROM records WHERE collection = 'files' AND id = ?").bind(first.files[0].id).first()).data);
  await f.env.FILES.delete(record.key);
  const missing=await f.call('/admin/courses/c1/download?scope=approved',{cookie:admin});
  assert.equal(missing.status,409);
  assert.match((await missing.json()).error,/누락/);
});

test('legacy import merges without replacing submissions and aborts conflicting names atomically',async t=>{
  const f=await fixture(t,{courses:[course('c1'),course('c2')],members:[member('m1'),member('m2')]});
  const admin=await f.login(),cookie=await f.select();
  assert.equal((await f.call('/submissions',{method:'POST',cookie,body:f.form()})).status,201);
  const imported=await f.call('/admin/import-legacy',{method:'POST',cookie:admin,body:{confirm:true,members:[{id:'m1',name:'직원m1',position:'행정9급',completions:['c1','c2']}]}});
  assert.equal(imported.status,200,await imported.clone().text());
  assert.equal((await imported.json()).addedCompletions,2);
  const mine=await (await f.call('/me',{cookie})).json();
  assert.equal(mine.submissions[0].status,'pending');
  assert.deepEqual(mine.member.legacyCompletions,['c1','c2']);
  const conflicting=await f.call('/admin/import-legacy',{method:'POST',cookie:admin,body:{confirm:true,members:[{id:'m2',name:'직원m2',completions:['c1']},{id:'m1',name:'다른사람',completions:[]}]}});
  assert.equal(conflicting.status,409);
  const data=await (await f.call('/admin/data',{cookie:admin})).json();
  assert.deepEqual(data.members.find(value=>value.id==='m2').legacyCompletions,[]);
});

test('cross-origin mutations and repeated incorrect logins are blocked',async t=>{
  const f=await fixture(t);
  const cross=await f.call('/member-session',{method:'POST',origin:'https://other.example',body:{memberId:'m1'}});
  assert.equal(cross.status,403);
  for(let count=0;count<8;count++) assert.equal((await f.call('/admin/login',{method:'POST',body:{password:'wrong'}})).status,401);
  assert.equal((await f.call('/admin/login',{method:'POST',body:{password:'test-admin-password'}})).status,429);
});

test('simultaneous submissions preserve the winning latest pointer and clean up the losing upload',async t=>{
  const f=await fixture(t);
  const cookie=await f.select();
  const put=f.env.FILES.put.bind(f.env.FILES);
  const keys=[];
  let release;
  const barrier=new Promise(resolve=>{release=resolve;});
  f.env.FILES.put=async(...args)=>{
    const result=await put(...args); keys.push(args[0]);
    if(keys.length===2)release();
    await barrier;
    return result;
  };
  const results=await Promise.all([
    f.call('/submissions',{method:'POST',cookie,body:f.form({name:'첫제출.pdf'})}),
    f.call('/submissions',{method:'POST',cookie,body:f.form({name:'두번째.pdf'})})
  ]);
  assert.deepEqual(results.map(response=>response.status).sort(),[201,409]);
  const mine=await (await f.call('/me',{cookie})).json();
  assert.equal(mine.submissions.length,1);
  const pointer=JSON.parse((await f.env.DB.prepare("SELECT data FROM records WHERE collection = 'enrollments' AND id = 'm1:c1'").first()).data);
  assert.equal(pointer.latestSubmissionId,mine.submissions[0].id);
  const metadata=await f.env.DB.prepare("SELECT data FROM records WHERE collection = 'files'").all();
  assert.equal(metadata.results.length,1);
  const remaining=await Promise.all(keys.map(key=>f.env.FILES.head(key)));
  assert.equal(remaining.filter(Boolean).length,1);
});

test('simultaneous reviews accept one result and reject the stale result',async t=>{
  const f=await fixture(t);
  const cookie=await f.select(),admin=await f.login();
  const submission=(await (await f.call('/submissions',{method:'POST',cookie,body:f.form()})).json()).submission;
  const batch=f.env.DB.batch.bind(f.env.DB);
  let calls=0,release;
  const barrier=new Promise(resolve=>{release=resolve;});
  f.env.DB.batch=async statements=>{
    if(++calls===2)release();
    await barrier;
    return batch(statements);
  };
  const results=await Promise.all([
    f.call(`/admin/submissions/${submission.id}/review`,{method:'POST',cookie:admin,body:{status:'approved',reviewNote:'확인',version:1}}),
    f.call(`/admin/submissions/${submission.id}/review`,{method:'POST',cookie:admin,body:{status:'needs_revision',reviewNote:'재확인',version:1}})
  ]);
  assert.deepEqual(results.map(response=>response.status).sort(),[200,409]);
  const mine=await (await f.call('/me',{cookie})).json();
  assert.equal(mine.submissions[0].version,2);
  assert.ok(['approved','needs_revision'].includes(mine.submissions[0].status));
  const audits=await f.env.DB.prepare("SELECT data FROM records WHERE collection = 'audit' AND json_extract(data,'$.action') = 'submission_reviewed'").all();
  assert.equal(audits.results.length,1);
});

test('file storage failures roll back the submission and remove already uploaded originals',async t=>{
  const f=await fixture(t);
  const cookie=await f.select();
  const put=f.env.FILES.put.bind(f.env.FILES);
  const keys=[];
  f.env.FILES.put=async(...args)=>{
    keys.push(args[0]);
    if(keys.length===2)throw Error('Deliberate storage failure');
    return put(...args);
  };
  const form=f.form();
  form.append('files',new File([PDF],'두번째.pdf',{type:'application/pdf'}));
  t.mock.method(console,'error',()=>{});
  const response=await f.call('/submissions',{method:'POST',cookie,body:form});
  assert.equal(response.status,500);
  const mine=await (await f.call('/me',{cookie})).json();
  assert.equal(mine.submissions.length,0);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection = 'files'").first()).count,0);
  assert.deepEqual(await Promise.all(keys.map(key=>f.env.FILES.head(key))),[null,null]);
});

for (const sizeSource of ['put','head']) test(`changed stored file size reported by ${sizeSource} rejects reception and rolls back new files without replacing earlier submissions`,async t=>{
  const f=await fixture(t),cookie=await f.select();
  const initialResponse=await f.call('/submissions',{method:'POST',cookie,body:f.form({file:PNG,name:'기존수료증.png',type:'image/png'})});
  assert.equal(initialResponse.status,201);
  const original=(await initialResponse.json()).submission;
  const put=f.env.FILES.put.bind(f.env.FILES),head=f.env.FILES.head.bind(f.env.FILES);
  const keys=[];
  f.env.FILES.put=async(...args)=>{
    const value=await put(...args); keys.push(args[0]);
    return sizeSource==='put' && keys.length===2 ? {...value,size:value.size+1024} : value;
  };
  if(sizeSource==='head')f.env.FILES.head=async key=>{
    const value=await head(key);
    return value && key===keys[1] ? {...value,size:value.size+1024} : value;
  };
  const body=f.form({file:PNG,name:'재제출첫파일.png',type:'image/png'});
  body.append('files',new File([PNG],'변경된두번째파일.png',{type:'image/png'}));
  const response=await f.call('/submissions',{method:'POST',cookie,body});
  assert.equal(response.status,503);
  const error=await response.json();
  assert.equal(error.code,'FILE_STORAGE_CHANGED');
  assert.match(error.error,/접수되지 않았습니다/);
  assert.equal(keys.length,2);
  assert.deepEqual(await Promise.all(keys.map(head)),[null,null],'all files from the rejected attempt are removed');
  const mine=await (await f.call('/me',{cookie})).json();
  assert.deepEqual(mine.submissions.map(value=>value.id),[original.id]);
  const pointer=JSON.parse((await f.env.DB.prepare("SELECT data FROM records WHERE collection = 'enrollments' AND id = 'm1:c1'").first()).data);
  assert.equal(pointer.latestSubmissionId,original.id);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection = 'files'").first()).count,1);
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection = 'audit' AND json_extract(data,'$.action') = 'certificate_submitted'").first()).count,1);
  const originalFile=await f.call(`/files/${original.files[0].id}`,{cookie});
  assert.equal(originalFile.status,200);
  assert.deepEqual(Buffer.from(await originalFile.arrayBuffer()),PNG);
});

test('approved ZIP respects manual approval of the latest attached submission',async t=>{
  const f=await fixture(t);
  const cookie=await f.select(),admin=await f.login();
  assert.equal((await f.call('/submissions',{method:'POST',cookie,body:f.form()})).status,201);
  const override=await f.call('/admin/overrides/m1/c1',{method:'PUT',cookie:admin,body:{status:'approved',reason:'담당자 증빙 확인',version:0}});
  assert.equal(override.status,200);
  const response=await f.call('/admin/courses/c1/download?scope=approved',{cookie:admin});
  assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.includes(Buffer.from(PDF)));
  assert.ok(bytes.includes(Buffer.from('승인')));
});

test('eventual storage accepts its write receipt and distinguishes propagation from missing or unauthorized files',async t=>{
  const f=await fixture(t),cookie=await f.select(),admin=await f.login();
  let visible=false,heads=0;
  const head=f.env.FILES.head.bind(f.env.FILES),get=f.env.FILES.get.bind(f.env.FILES);
  f.env.FILES.consistency='eventual';
  f.env.FILES.head=async key=>{heads++;return visible ? head(key):null;};
  f.env.FILES.get=async key=>visible ? get(key):null;
  const response=await f.call('/submissions',{method:'POST',cookie,body:f.form({file:PNG,name:'원본.png',type:'image/png'})});
  assert.equal(response.status,201);
  assert.equal(heads,0,'a successful KV write is not incorrectly rolled back by an immediate read');
  const submission=(await response.json()).submission,fileId=submission.files[0].id;
  const pending=await f.call(`/files/${fileId}`,{cookie});
  assert.equal(pending.status,503);assert.equal(pending.headers.get('Retry-After'),'5');
  assert.equal((await pending.json()).code,'FILE_PROPAGATING');
  assert.equal((await f.call(`/files/${fileId}`,{cookie:await f.select('m2')})).status,403);
  assert.equal((await f.call(`/admin/submissions/${submission.id}/review`,{method:'POST',cookie:admin,body:{status:'approved',reviewNote:'확인',version:1}})).status,200);
  const zipPending=await f.call('/admin/courses/c1/download?scope=approved',{cookie:admin});
  assert.equal(zipPending.status,503);assert.equal((await zipPending.json()).code,'FILE_PROPAGATING');
  assert.equal((await f.env.DB.prepare("SELECT COUNT(*) AS count FROM records WHERE collection='audit' AND json_extract(data,'$.action')='certificates_downloaded'").first()).count,0);
  visible=true;
  const original=await f.call(`/files/${fileId}`,{cookie});
  assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),PNG);
  const zip=await f.call('/admin/courses/c1/download?scope=approved',{cookie:admin});
  assert.equal(zip.status,200);assert.ok(Buffer.from(await zip.arrayBuffer()).includes(PNG));
  visible=false;
  const row=await f.env.DB.prepare("SELECT data FROM records WHERE collection='files' AND id=?").bind(fileId).first();
  const file={...JSON.parse(row.data),createdAt:'2020-01-01T00:00:00.000Z'};
  await f.env.DB.prepare("UPDATE records SET data=? WHERE collection='files' AND id=?").bind(JSON.stringify(file),fileId).run();
  const missing=await f.call(`/files/${fileId}`,{cookie});
  assert.equal(missing.status,404);assert.equal(missing.headers.has('Retry-After'),false);
  assert.equal((await f.call('/admin/courses/c1/download?scope=approved',{cookie:admin})).status,409);
  assert.equal((await (await f.call('/me',{cookie})).json()).submissions.length,1);
});

test('eventual storage without a counted write receipt rejects reception and cleans the attempted upload',async t=>{
  const f=await fixture(t),cookie=await f.select(),put=f.env.FILES.put.bind(f.env.FILES),head=f.env.FILES.head.bind(f.env.FILES),keys=[];
  f.env.FILES.consistency='eventual';
  f.env.FILES.put=async(...args)=>{await put(...args);keys.push(args[0]);return undefined;};
  const response=await f.call('/submissions',{method:'POST',cookie,body:f.form({file:PNG,name:'원본.png',type:'image/png'})});
  assert.equal(response.status,503);assert.equal((await response.json()).code,'FILE_STORAGE_CHANGED');
  assert.deepEqual(await Promise.all(keys.map(head)),[null]);
  assert.equal((await (await f.call('/me',{cookie})).json()).submissions.length,0);
});

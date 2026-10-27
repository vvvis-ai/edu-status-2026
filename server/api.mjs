import {getLatestSubmission, getStatus, isTarget, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_FILES} from '../edu-shared.mjs';
import {createZip} from './zip.mjs';

const encoder = new TextEncoder();
const SESSION_SECONDS = 12 * 60 * 60;
const JSON_LIMIT = 256 * 1024;
const ADMIN_COOKIE = 'edu_admin';
const MEMBER_COOKIE = 'edu_member';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new ApiError(status, message, code); };
const now = () => new Date().toISOString();
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const uuid = () => crypto.randomUUID();
const stringify = value => JSON.stringify(value);
const cleanId = value => typeof value === 'string' && /^[\w:-]{1,160}$/.test(value) ? value : fail(400, '식별번호가 올바르지 않습니다.');

function json(value, status = 200, extra = {}) {
  return new Response(stringify(value), {status, headers: {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...extra}});
}

function text(value, label, max = 200, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') fail(400, `${label}을(를) 확인해 주세요.`);
  const result = value.trim();
  if ((required && !result) || result.length > max) fail(400, `${label}은(는) ${required ? '1~' : ''}${max}자 이내로 입력해 주세요.`);
  return result;
}

function date(value, label, required = false) {
  const result = text(value, label, 10, required);
  if (!result) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`)) || new Date(`${result}T00:00:00Z`).toISOString().slice(0,10) !== result) fail(400, `${label}이(가) 올바르지 않습니다.`);
  return result;
}

function version(value, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) fail(400, '현재 자료의 버전 정보가 필요합니다. 화면을 새로고침해 주세요.');
  return value;
}

function boolean(value, fallback) { return typeof value === 'boolean' ? value : fallback; }
function idList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 2000) fail(400, `${label} 목록을 확인해 주세요.`);
  return [...new Set(value.map(cleanId))];
}

function boundedBody(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) fail(413, '업로드 가능한 전체 크기를 초과했습니다.');
  if (!request.body) return request;
  let size = 0;
  const body = request.body.pipeThrough(new TransformStream({transform(chunk, controller) {
    size += chunk.byteLength;
    if (size > limit) throw new ApiError(413, '업로드 가능한 전체 크기를 초과했습니다.');
    controller.enqueue(chunk);
  }}));
  return new Request(request, {body, duplex:'half'});
}

async function readJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) fail(415, 'JSON 형식으로 요청해 주세요.');
  try {
    const value = await boundedBody(request, JSON_LIMIT).json();
    if (!value || Array.isArray(value) || typeof value !== 'object') fail(400, '요청 내용을 확인해 주세요.');
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, '요청 내용을 읽지 못했습니다.');
  }
}

async function all(env, collection) {
  const result = await env.DB.prepare('SELECT data FROM records WHERE collection = ? ORDER BY id').bind(collection).all();
  return result.results.map(row => JSON.parse(row.data));
}

async function get(env, collection, id) {
  const row = await env.DB.prepare('SELECT data FROM records WHERE collection = ? AND id = ?').bind(collection, id).first();
  return row ? JSON.parse(row.data) : null;
}

async function required(env, collection, id, message = '자료를 찾을 수 없습니다.') {
  const item = await get(env, collection, cleanId(id));
  if (!item) fail(404, message);
  return item;
}

function insert(env, collection, item) {
  return env.DB.prepare('INSERT INTO records(collection,id,data,version) VALUES (?,?,?,?)').bind(collection, item.id, stringify(item), item.version);
}

function update(env, collection, item, expectedVersion) {
  return env.DB.prepare('UPDATE records SET data = ?, version = ? WHERE collection = ? AND id = ? AND version = ?').bind(stringify(item), item.version, collection, item.id, expectedVersion);
}

function changes(result) { return Number(result?.meta?.changes || 0); }
function conflict() { fail(409, '다른 작업으로 자료가 변경되었습니다. 새로고침 후 다시 시도해 주세요.', 'VERSION_CONFLICT'); }

function auditItem(action, detail, actor = 'admin') { return {id:uuid(), action, detail, actor, createdAt:now(), version:1}; }

function fileAccessAudit(file, actor, accessMode, requestId, requestAcceptedAt) {
  return auditItem('certificate_access_requested', {
    fileId:file.id, courseId:file.courseId, memberId:file.memberId, submissionId:file.submissionId,
    actorRole:actor.role, identityAssurance:actor.identityAssurance, accessMode, requestAcceptedAt, requestId,
  },actor.id);
}

async function recordFileAccess(env, entries) {
  try {
    // One statement keeps a ZIP's per-file requests and legacy summary atomic,
    // without consuming one D1 query or bound parameter per selected file.
    const result = await env.DB.prepare("INSERT INTO records(collection,id,data,version) SELECT 'audit',json_extract(value,'$.id'),value,1 FROM json_each(?)").bind(stringify(entries)).run();
    if (result?.success === false || changes(result) !== entries.length) throw new Error('Access audit count mismatch');
  } catch {
    fail(503,'파일 접근 요청 기록을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.','FILE_ACCESS_AUDIT_FAILED');
  }
}

function accessCursor(entry) {
  return btoa(stringify({createdAt:entry.createdAt,id:entry.id})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function readAccessCursor(value) {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error('Invalid cursor encoding');
    const cursor = JSON.parse(atob(value.replace(/-/g,'+').replace(/_/g,'/')));
    if (!cursor || Array.isArray(cursor) || typeof cursor.createdAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.createdAt)
        || new Date(cursor.createdAt).toISOString() !== cursor.createdAt) throw new Error('Invalid cursor date');
    return {createdAt:cursor.createdAt,id:cleanId(cursor.id)};
  } catch { fail(400,'파일 요청 기록의 조회 위치가 올바르지 않습니다. 처음부터 다시 조회해 주세요.'); }
}

async function listFileAccess(env, url) {
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit == null ? 50 : Number(rawLimit);
  if ((rawLimit != null && !/^\d{1,3}$/.test(rawLimit)) || !Number.isInteger(limit) || limit < 1 || limit > 100) fail(400,'파일 요청 기록은 한 번에 1~100건까지 조회할 수 있습니다.');
  const rawFileId = url.searchParams.get('fileId');
  const fileId = rawFileId ? cleanId(rawFileId) : '';
  const cursor = readAccessCursor(url.searchParams.get('cursor'));
  const conditions = ["collection = 'audit'","json_extract(data,'$.action') = 'certificate_access_requested'"];
  const values = [];
  if (fileId) { conditions.push("json_extract(data,'$.detail.fileId') = ?"); values.push(fileId); }
  if (cursor) {
    conditions.push("(json_extract(data,'$.createdAt') < ? OR (json_extract(data,'$.createdAt') = ? AND id < ?))");
    values.push(cursor.createdAt,cursor.createdAt,cursor.id);
  }
  const result = await env.DB.prepare(`SELECT data FROM records WHERE ${conditions.join(' AND ')} ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT ?`).bind(...values,limit+1).all();
  const entries = result.results.slice(0,limit).map(row => JSON.parse(row.data));
  return json({entries,nextCursor:result.results.length > limit ? accessCursor(entries.at(-1)) : null,serverTime:now()});
}

async function saveWithAudit(env, collection, item, expectedVersion, entry) {
  const nonce = uuid();
  const lock = {id:nonce,version:1};
  try {
    await env.DB.batch([
      insert(env,'mutation_guards',lock),
      // A duplicate key aborts and rolls back the entire D1 batch when the
      // expected version no longer exists, including the audit insertion.
      env.DB.prepare("INSERT INTO records(collection,id,data,version) SELECT 'mutation_guards',?, '{}',1 WHERE NOT EXISTS (SELECT 1 FROM records WHERE collection = ? AND id = ? AND version = ?)").bind(nonce,collection,item.id,expectedVersion),
      update(env,collection,item,expectedVersion),
      insert(env,'audit',entry),
      env.DB.prepare("DELETE FROM records WHERE collection = 'mutation_guards' AND id = ?").bind(nonce)
    ]);
  } catch(error) {
    if (/UNIQUE|constraint|primary key/i.test(String(error))) conflict();
    throw error;
  }
}

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function secretEquals(input, expected) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(expected), {name:'HMAC', hash:'SHA-256'}, false, ['sign','verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(input));
}

function cookies(request) {
  return Object.fromEntries((request.headers.get('Cookie') || '').split(';').map(value => value.trim().split('=')).filter(parts => parts.length === 2));
}

function requireSessionSecret(env) { if (!env.SESSION_SECRET) fail(503, '서버의 세션 설정이 필요합니다. 담당자에게 문의해 주세요.'); }
async function session(request, env, role) {
  const token = cookies(request)[role === 'admin' ? ADMIN_COOKIE : MEMBER_COOKIE];
  if (!token || !env.SESSION_SECRET || !/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await digest(`${env.SESSION_SECRET}:${token}`);
  return env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ? AND role = ? AND expires_at > ?').bind(hash, role, Date.now()).first();
}

async function requireAdmin(request, env) {
  const value = await session(request, env, 'admin');
  if (!value) fail(401, '관리자 로그인이 필요합니다.', 'ADMIN_AUTH_REQUIRED');
  return value;
}

async function requireMember(request, env) {
  const value = await session(request, env, 'member');
  if (!value) fail(401, '이름을 다시 선택해 주세요.', 'MEMBER_SESSION_REQUIRED');
  const member = await required(env, 'members', value.member_id, '선택한 부서원 정보를 찾을 수 없습니다.');
  if (!member.active) fail(403, '현재 재직 중인 부서원만 이용할 수 있습니다.');
  return member;
}

function cookieHeader(request, role, token, maxAge = SESSION_SECONDS) {
  return `${role === 'admin' ? ADMIN_COOKIE : MEMBER_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

async function clearSession(request, env, role) {
  const token = cookies(request)[role === 'admin' ? ADMIN_COOKIE : MEMBER_COOKIE];
  if (token && env.SESSION_SECRET) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(`${env.SESSION_SECRET}:${token}`)).run();
}

async function createSession(request, env, role, memberId = null) {
  requireSessionSecret(env);
  await clearSession(request, env, role);
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO sessions(token_hash,role,member_id,expires_at) VALUES (?,?,?,?)').bind(await digest(`${env.SESSION_SECRET}:${token}`), role, memberId, Date.now() + SESSION_SECONDS * 1000)
  ]);
  return cookieHeader(request, role, token);
}

async function login(request, env) {
  if (!env.ADMIN_PASSWORD) fail(503, '관리자 비밀번호 설정이 필요합니다.');
  requireSessionSecret(env);
  const body = await readJson(request);
  const password = text(body.password, '비밀번호', 512, true);
  const key = await digest(`${env.SESSION_SECRET}:login:${request.headers.get('CF-Connecting-IP') || 'local'}`);
  const current = await env.DB.prepare('SELECT count,reset_at FROM login_attempts WHERE key = ?').bind(key).first();
  if (current && current.reset_at > Date.now() && current.count >= 8) fail(429, '로그인 시도가 많습니다. 15분 후 다시 시도해 주세요.');
  if (!await secretEquals(password, env.ADMIN_PASSWORD)) {
    await env.DB.prepare('INSERT INTO login_attempts(key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN reset_at <= ? THEN 1 ELSE count+1 END, reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END').bind(key, Date.now()+15*60*1000, Date.now(), Date.now()).run();
    fail(401, '비밀번호가 올바르지 않습니다.');
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
  return json({authenticated:true}, 200, {'Set-Cookie':await createSession(request, env, 'admin')});
}

function publicMember(member) {
  const {legacyCompletions, note, ...value} = member;
  return value;
}
function publicFile(file) { return {id:file.id, name:file.name, type:file.type, size:file.size}; }
function visibleCourses(courses) { return courses.filter(course => course.published); }
function pairId(memberId, courseId) { return `${memberId}:${courseId}`; }

function memberOrdering(members, saved) {
  const active = new Map(members.filter(member => member.active).map(member => [member.id, member]));
  const memberIds = [], seen = new Set();
  for (const id of [...(Array.isArray(saved?.memberIds) ? saved.memberIds : []), ...active.keys()]) {
    if (active.has(id) && !seen.has(id)) { memberIds.push(id); seen.add(id); }
  }
  return {
    memberOrder: {memberIds, version:saved?.version || 0},
    members: [...memberIds.map(id => active.get(id)), ...members.filter(member => !member.active)],
  };
}

async function saveMemberOrder(request, env) {
  const body = await readJson(request), expectedVersion = version(body.version, true);
  if (!Array.isArray(body.memberIds) || body.memberIds.length > 2000) fail(400, '표시 순서에 포함할 부서원 목록을 확인해 주세요.');
  const memberIds = body.memberIds.map(cleanId), selectedIds = new Set(memberIds);
  if (selectedIds.size !== memberIds.length) fail(400, '표시 순서에 중복된 부서원이 있습니다.');
  const [members, saved] = await Promise.all([all(env,'members'),get(env,'settings','member-order')]);
  if ((saved?.version || 0) !== expectedVersion) conflict();
  const allIds = new Set(members.map(member => member.id));
  if (memberIds.some(id => !allIds.has(id))) fail(400, '명단에 없는 부서원이 포함되어 있습니다.');
  const activeIds = members.filter(member => member.active).map(member => member.id);
  if (activeIds.length !== memberIds.length || activeIds.some(id => !selectedIds.has(id))) conflict();
  const item = {id:'member-order',memberIds,version:expectedVersion+1,updatedAt:now(),nonce:uuid()};
  const serializedIds = stringify(memberIds);
  // Compare the complete active-ID set inside the same atomic batch as the
  // order and audit writes. JSON parameters avoid one SQL binding per member.
  const activeSetGuard = "(SELECT COUNT(*) FROM records WHERE collection = 'members' AND json_extract(data,'$.active') = 1) = json_array_length(?) AND NOT EXISTS (SELECT 1 FROM records AS member WHERE member.collection = 'members' AND json_extract(member.data,'$.active') = 1 AND member.id NOT IN (SELECT value FROM json_each(?)))";
  const versionGuard = "((? = 0 AND NOT EXISTS (SELECT 1 FROM records WHERE collection = 'settings' AND id = 'member-order')) OR EXISTS (SELECT 1 FROM records WHERE collection = 'settings' AND id = 'member-order' AND version = ?))";
  const lock = {sql:"EXISTS (SELECT 1 FROM records WHERE collection = 'settings' AND id = 'member-order' AND version = ? AND json_extract(data,'$.nonce') = ?)",values:[item.version,item.nonce]};
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO records(collection,id,data,version) SELECT 'settings','member-order',?,? WHERE ${activeSetGuard} AND ${versionGuard} ON CONFLICT(collection,id) DO UPDATE SET data = excluded.data, version = excluded.version`).bind(stringify(item),item.version,serializedIds,serializedIds,expectedVersion,expectedVersion),
    guardedInsert(env,'audit',auditItem('member_order_updated',{memberIds}),lock),
  ]);
  if (!changes(results[0])) conflict();
  return json({memberOrder:{memberIds,version:item.version}});
}

function departmentChart(members, saved) {
  const active = members.filter(member => member.active), activeIds = new Set(active.map(member => member.id));
  let leaderId, configuredTeams;
  if (saved) {
    leaderId = activeIds.has(saved.leaderId) ? saved.leaderId : '';
    configuredTeams = saved.teams;
  } else {
    const candidates = active.filter(member => [member.team,member.position].some(value => String(value || '').includes('과장')));
    leaderId = candidates.length === 1 ? candidates[0].id : '';
    const names = [...new Set(active.filter(member => member.id !== leaderId).map(member => String(member.team || '').trim()).filter(Boolean))].slice(0,4);
    configuredTeams = names.map(name => ({name,memberIds:active.filter(member => member.id !== leaderId && String(member.team || '').trim() === name).map(member => member.id)}));
  }
  const usedNames = new Set((configuredTeams || []).map(team => team.name));
  const assigned = new Set(leaderId ? [leaderId] : []);
  const teams = Array.from({length:4},(_,index) => {
    const configured = configuredTeams?.[index];
    let name = configured?.name;
    if (!name) {
      let number = index+1;
      while (usedNames.has(`${number}팀`)) number++;
      name = `${number}팀`; usedNames.add(name);
    }
    const selected = new Set(configured?.memberIds || []);
    // Assignment is independent of the separately editable number order.
    const memberIds = active.filter(member => selected.has(member.id) && !assigned.has(member.id)).map(member => member.id);
    memberIds.forEach(id => assigned.add(id));
    return {id:`team-${index+1}`,name,memberIds};
  });
  return {leaderId,teams,unassignedMemberIds:active.filter(member => !assigned.has(member.id)).map(member => member.id),version:saved?.version || 0};
}

async function saveDepartmentChart(request, env) {
  const body = await readJson(request), expectedVersion = version(body.version,true);
  if (typeof body.leaderId !== 'string') fail(400,'과장 배치 정보를 확인해 주세요.');
  const leaderId = body.leaderId ? cleanId(body.leaderId) : '';
  if (!Array.isArray(body.teams) || body.teams.length !== 4) fail(400,'팀은 네 개를 지정해 주세요.');
  const assignedIds = new Set(leaderId ? [leaderId] : []), names = new Set();
  const teams = body.teams.map((team,index) => {
    if (!team || typeof team !== 'object' || team.id !== `team-${index+1}` || !Array.isArray(team.memberIds) || team.memberIds.length > 2000) fail(400,'팀 식별번호와 부서원 배치를 확인해 주세요.');
    const name = text(team.name,'팀 이름',100,true), nameKey = name.normalize('NFC').toLocaleLowerCase('ko');
    if (names.has(nameKey)) fail(400,'팀 이름은 서로 다르게 입력해 주세요.');
    names.add(nameKey);
    const memberIds = team.memberIds.map(cleanId);
    for (const id of memberIds) {
      if (assignedIds.has(id)) fail(400,'한 부서원을 여러 위치에 중복 배치할 수 없습니다.');
      assignedIds.add(id);
    }
    return {id:team.id,name,memberIds};
  });
  if (!Array.isArray(body.activeMemberIds) || body.activeMemberIds.length > 2000) fail(400,'현재 재직 명단을 확인해 주세요.');
  const requestedActiveIds = body.activeMemberIds.map(cleanId), requestedSet = new Set(requestedActiveIds);
  if (requestedSet.size !== requestedActiveIds.length) fail(400,'현재 재직 명단에 중복된 부서원이 있습니다.');
  const [members,saved,savedOrder] = await Promise.all([all(env,'members'),get(env,'settings','department-chart'),get(env,'settings','member-order')]);
  if ((saved?.version || 0) !== expectedVersion) conflict();
  const allIds = new Set(members.map(member => member.id)), activeIds = members.filter(member => member.active).map(member => member.id), activeSet = new Set(activeIds);
  if ([...assignedIds,...requestedActiveIds].some(id => !allIds.has(id))) fail(400,'명단에 없는 부서원이 포함되어 있습니다.');
  if (requestedActiveIds.length !== activeIds.length || activeIds.some(id => !requestedSet.has(id))) conflict();
  if ([...assignedIds].some(id => !activeSet.has(id))) fail(400,'재직 중인 부서원만 배치할 수 있습니다.');
  const item = {id:'department-chart',leaderId,teams,version:expectedVersion+1,updatedAt:now(),nonce:uuid()};
  const serializedIds = stringify(requestedActiveIds);
  const activeSetGuard = "(SELECT COUNT(*) FROM records WHERE collection = 'members' AND json_extract(data,'$.active') = 1) = json_array_length(?) AND NOT EXISTS (SELECT 1 FROM records AS member WHERE member.collection = 'members' AND json_extract(member.data,'$.active') = 1 AND member.id NOT IN (SELECT value FROM json_each(?)))";
  const versionGuard = "((? = 0 AND NOT EXISTS (SELECT 1 FROM records WHERE collection = 'settings' AND id = 'department-chart')) OR EXISTS (SELECT 1 FROM records WHERE collection = 'settings' AND id = 'department-chart' AND version = ?))";
  const lock = {sql:"EXISTS (SELECT 1 FROM records WHERE collection = 'settings' AND id = 'department-chart' AND version = ? AND json_extract(data,'$.nonce') = ?)",values:[item.version,item.nonce]};
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO records(collection,id,data,version) SELECT 'settings','department-chart',?,? WHERE ${activeSetGuard} AND ${versionGuard} ON CONFLICT(collection,id) DO UPDATE SET data = excluded.data, version = excluded.version`).bind(stringify(item),item.version,serializedIds,serializedIds,expectedVersion,expectedVersion),
    guardedInsert(env,'audit',auditItem('department_chart_updated',{leaderId,teams}),lock),
  ]);
  if (!changes(results[0])) conflict();
  return json({departmentChart:departmentChart(memberOrdering(members,savedOrder).members,item)});
}

async function ensureEnrollment(env, memberId, courseId) {
  const id = pairId(memberId, courseId);
  const initial = {id, memberId, courseId, latestSubmissionId:'', revision:0, nonce:'', version:0};
  await env.DB.prepare('INSERT OR IGNORE INTO records(collection,id,data,version) VALUES (?,?,?,0)').bind('enrollments', id, stringify(initial)).run();
  return required(env, 'enrollments', id);
}

function guard(env, enrollment) {
  return {sql:"EXISTS (SELECT 1 FROM records WHERE collection = 'enrollments' AND id = ? AND version = ? AND json_extract(data, '$.nonce') = ?)", values:[enrollment.id, enrollment.version, enrollment.nonce]};
}

function guardedInsert(env, collection, item, lock) {
  return env.DB.prepare(`INSERT INTO records(collection,id,data,version) SELECT ?,?,?,? WHERE ${lock.sql}`).bind(collection, item.id, stringify(item), item.version, ...lock.values);
}

function guardedDelete(env, collection, id, lock) {
  return env.DB.prepare(`DELETE FROM records WHERE collection = ? AND id = ? AND ${lock.sql}`).bind(collection, id, ...lock.values);
}

function courseInput(body, existing) {
  const year = Number(body.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail(400, '교육 연도를 확인해 주세요.');
  const periodType = body.periodType || 'year';
  if (!['year','month','quarter'].includes(periodType)) fail(400, '교육 구분을 확인해 주세요.');
  const periodValue = periodType === 'year' ? 0 : Number(body.periodValue);
  if (periodType !== 'year' && (!Number.isInteger(periodValue) || periodValue < 1 || periodValue > (periodType === 'month' ? 12 : 4))) fail(400, '월 또는 분기를 확인해 주세요.');
  const url = text(body.url, '교육 링크', 2000, true);
  try { if (!['https:','http:'].includes(new URL(url).protocol)) throw Error(); } catch { fail(400, '교육 링크는 http 또는 https 주소로 입력해 주세요.'); }
  if (!Array.isArray(body.details) || body.details.length > 100 || !body.details.length) fail(400, '수강할 세부 과목을 한 개 이상 입력해 주세요.');
  const details = body.details.map(value => text(value, '세부 과목', 500, true));
  const requirement = body.requirement || 'all';
  if (!['all','one','custom'].includes(requirement)) fail(400, '이수 조건을 확인해 주세요.');
  const targetMode = body.targetMode || 'all';
  if (!['all','selected'].includes(targetMode)) fail(400, '교육 대상 설정을 확인해 주세요.');
  const targetMemberIds = idList(body.targetMemberIds, '대상자');
  if (targetMode === 'selected' && !targetMemberIds.length) fail(400, '교육 대상자를 한 명 이상 선택해 주세요.');
  const deadline = date(body.deadline, '수강기한', true);
  const timestamp = now();
  return {id:existing?.id || uuid(), name:text(body.name,'교육명',200,true), site:text(body.site,'교육 사이트명',200,true), url, deadline, submissionDeadline:date(body.submissionDeadline || deadline,'제출기한',true), year, periodType, periodValue, details, requirement, requirementNote:text(body.requirementNote,'이수 조건 안내',2000,requirement==='custom'), requestDepartment:text(body.requestDepartment,'요청부서',200), description:text(body.description,'교육 안내',5000), published:boolean(body.published,false), archived:boolean(body.archived,false), targetMode, targetMemberIds, exemptMemberIds:idList(body.exemptMemberIds,'면제자'), createdAt:existing?.createdAt || timestamp, updatedAt:timestamp, version:(existing?.version || 0)+1};
}

function memberInput(body, existing) {
  const joinedOn = date(body.joinedOn,'전입일');
  const leftOn = date(body.leftOn,'전출일');
  if (joinedOn && leftOn && joinedOn > leftOn) fail(400, '전출일은 전입일 이후여야 합니다.');
  const timestamp = now();
  return {id:existing?.id || uuid(), name:text(body.name,'이름',100,true), position:text(body.position,'직급',100), team:text(body.team,'팀',100), active:boolean(body.active,true), joinedOn, leftOn, note:text(body.note,'메모',2000), legacyCompletions:existing?.legacyCompletions || [], createdAt:existing?.createdAt || timestamp, updatedAt:timestamp, version:(existing?.version || 0)+1};
}

async function saveCourse(request, env, id) {
  const body = await readJson(request);
  const existing = id ? await required(env,'courses',id) : null;
  if (existing && version(body.version) !== existing.version) conflict();
  const course = courseInput(body,existing);
  const members = await all(env,'members');
  const ids = new Set(members.map(member => member.id));
  if ([...course.targetMemberIds,...course.exemptMemberIds].some(memberId => !ids.has(memberId))) fail(400,'대상자 또는 면제자 명단에 존재하지 않는 부서원이 있습니다.');
  const action = existing ? 'course_updated' : 'course_created';
  if (existing) {
    const entry = auditItem(action,{courseId:course.id,name:course.name});
    await saveWithAudit(env,'courses',course,existing.version,entry);
  } else {
    await env.DB.batch([insert(env,'courses',course),insert(env,'audit',auditItem(action,{courseId:course.id,name:course.name}))]);
  }
  return json({course},existing ? 200 : 201);
}

async function saveMember(request, env, id) {
  const body = await readJson(request);
  const existing = id ? await required(env,'members',id) : null;
  if (existing && version(body.version) !== existing.version) conflict();
  const member = memberInput(body,existing);
  const action = existing ? 'member_updated' : 'member_created';
  const detail = {memberId:member.id,name:member.name,...(existing ? {before:{name:existing.name,position:existing.position,team:existing.team,active:existing.active,joinedOn:existing.joinedOn,leftOn:existing.leftOn},after:{name:member.name,position:member.position,team:member.team,active:member.active,joinedOn:member.joinedOn,leftOn:member.leftOn}} : {})};
  if (existing) {
    const entry = auditItem(action,detail);
    await saveWithAudit(env,'members',member,existing.version,entry);
  } else await env.DB.batch([insert(env,'members',member),insert(env,'audit',auditItem(action,detail))]);
  return json({member},existing ? 200 : 201);
}

async function identifyFile(file) {
  const bytes = new Uint8Array(await file.slice(0,16).arrayBuffer());
  const starts = values => values.every((value,index) => bytes[index] === value);
  let type, ext;
  if (starts([0x25,0x50,0x44,0x46,0x2d])) { type='application/pdf'; ext='pdf'; }
  else if (starts([0xff,0xd8,0xff])) { type='image/jpeg'; ext='jpg'; }
  else if (starts([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) { type='image/png'; ext='png'; }
  else if (starts([0x52,0x49,0x46,0x46]) && bytes[8]===0x57 && bytes[9]===0x45 && bytes[10]===0x42 && bytes[11]===0x50) { type='image/webp'; ext='webp'; }
  else fail(415, `${file.name}: PDF 또는 JPG·PNG·WebP 사진 파일만 제출할 수 있습니다. DRM이 적용된 파일은 기관에서 허용하는 절차로 보안 해제 후 다시 제출해 주세요.`);
  const suppliedExt = file.name.split('.').at(-1)?.toLowerCase();
  if (!(ext === 'jpg' ? ['jpg','jpeg'] : [ext]).includes(suppliedExt)) fail(415,`${file.name}: 파일 확장자와 실제 형식이 일치하지 않습니다.`);
  return {type,ext};
}

async function submit(request, env) {
  const member = await requireMember(request,env);
  let form;
  try { form = await boundedBody(request,MAX_TOTAL_BYTES+2*1024*1024).formData(); }
  catch (error) { if (error instanceof ApiError) throw error; fail(400,'첨부파일을 읽지 못했습니다. 파일을 다시 선택해 주세요.'); }
  const expectedMemberId = form.get('expectedMemberId');
  if (expectedMemberId && expectedMemberId !== member.id) fail(409,'선택한 이름이 다른 탭에서 변경되었습니다. 이름을 다시 선택해 주세요.','MEMBER_CHANGED');
  const courseId = cleanId(form.get('courseId'));
  const course = await required(env,'courses',courseId);
  if (!course.published || course.archived) fail(403,'현재 제출을 받는 교육이 아닙니다.');
  if (!isTarget(course,member)) fail(403,'본인에게 지정된 교육만 제출할 수 있습니다.');
  const completedOn = date(form.get('completedOn'),'수료일',true);
  if (completedOn > today()) fail(400,'수료일은 오늘 또는 이전 날짜로 입력해 주세요.');
  const comment = text(form.get('comment'),'제출 메모',2000);
  const uploads = form.getAll('files');
  if (!uploads.length || uploads.length > MAX_FILES) fail(400,`수료증은 1~${MAX_FILES}개까지 첨부해 주세요.`);
  let total = 0;
  const formats = [];
  for (const file of uploads) {
    if (!file || typeof file.stream !== 'function' || !file.name) fail(400,'첨부파일을 확인해 주세요.');
    if (!file.size || file.size > MAX_FILE_BYTES) fail(413,`${file.name}: 파일은 0바이트를 초과하고 15MB 이하여야 합니다.`);
    total += file.size;
    if (total > MAX_TOTAL_BYTES) fail(413,'한 번에 제출하는 파일의 합계는 60MB 이하여야 합니다.');
    formats.push(await identifyFile(file));
  }
  const enrollment = await ensureEnrollment(env,member.id,course.id);
  const [submissions,overrides] = await Promise.all([all(env,'submissions'),all(env,'overrides')]);
  if (getStatus(course,member,submissions,overrides) === 'approved') fail(409,'이미 이수 승인된 교육입니다. 변경이 필요하면 담당자에게 문의해 주세요.');
  if (getStatus(course,member,submissions,overrides) === 'exempt') fail(403,'면제 처리된 교육입니다.');
  const latest = getLatestSubmission(submissions,member.id,course.id);
  const submittedAt = new Date(Math.max(Date.now(),latest ? Date.parse(latest.submittedAt)+1 : 0)).toISOString();
  const id = uuid();
  const storedFiles = uploads.map((file,index) => ({id:uuid(),name:text(file.name,'파일명',255,true),type:formats[index].type,size:file.size,ext:formats[index].ext,submissionId:id,courseId:course.id,memberId:member.id,createdAt:submittedAt,version:1}));
  storedFiles.forEach(file => { file.key = `certificates/${course.id}/${member.id}/${id}/${file.id}.${file.ext}`; });
  const submission = {id,courseId:course.id,memberId:member.id,status:'pending',completedOn,comment,submittedAt,reviewedAt:'',reviewNote:'',revision:(enrollment.revision || 0)+1,version:1,files:storedFiles.map(publicFile)};
  const next = {...enrollment,latestSubmissionId:id,revision:submission.revision,version:enrollment.version+1,nonce:uuid()};
  const lock = guard(env,next);
  const written = [];
  try {
    for (let index=0;index<uploads.length;index++) {
      written.push(storedFiles[index].key);
      const stored = await env.FILES.put(storedFiles[index].key,uploads[index].stream(),{httpMetadata:{contentType:storedFiles[index].type}});
      // KV acknowledges durable writes before every read location sees them.
      // Its adapter counts the stored input bytes; a read-back is not a receipt.
      const persisted = env.FILES.consistency === 'eventual' ? stored : await env.FILES.head(storedFiles[index].key);
      if (!persisted || Number(persisted.size)!==storedFiles[index].size || (stored?.size != null && Number(stored.size)!==storedFiles[index].size)) {
        fail(503,'저장 과정에서 수료증 원본이 변경되었습니다. 저장소와 기관 보안 프로그램 설정을 담당자에게 확인해 주세요. 접수되지 않았습니다.','FILE_STORAGE_CHANGED');
      }
    }
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE records SET data = ?, version = ? WHERE collection = 'enrollments' AND id = ? AND version = ? AND EXISTS (SELECT 1 FROM records WHERE collection = 'courses' AND id = ? AND version = ?) AND EXISTS (SELECT 1 FROM records WHERE collection = 'members' AND id = ? AND version = ?)").bind(stringify(next),next.version,enrollment.id,enrollment.version,course.id,course.version,member.id,member.version),
      guardedInsert(env,'submissions',submission,lock),
      ...storedFiles.map(file => guardedInsert(env,'files',file,lock)),
      guardedDelete(env,'overrides',pairId(member.id,course.id),lock),
      guardedInsert(env,'audit',auditItem('certificate_submitted',{submissionId:id,courseId:course.id,memberId:member.id,fileCount:storedFiles.length},member.id),lock)
    ]);
    if (!changes(results[0])) conflict();
  } catch (error) {
    await Promise.allSettled(written.map(key => env.FILES.delete(key)));
    throw error;
  }
  return json({submission},201);
}

async function review(request, env, id) {
  const body = await readJson(request);
  const submission = await required(env,'submissions',id);
  if (version(body.version) !== submission.version) conflict();
  if (!['approved','needs_revision'].includes(body.status)) fail(400,'검토 결과를 확인해 주세요.');
  const reviewNote = text(body.reviewNote,'검토 사유',2000,body.status==='needs_revision');
  const enrollment = await ensureEnrollment(env,submission.memberId,submission.courseId);
  if (enrollment.latestSubmissionId !== submission.id) fail(409,'재제출된 새 수료증이 있습니다. 최신 제출본을 검토해 주세요.');
  const updated = {...submission,status:body.status,reviewNote,reviewedAt:now(),version:submission.version+1};
  const next = {...enrollment,version:enrollment.version+1,nonce:uuid()};
  const lock = guard(env,next);
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE records SET data = ?, version = ? WHERE collection = 'enrollments' AND id = ? AND version = ? AND EXISTS (SELECT 1 FROM records WHERE collection = 'submissions' AND id = ? AND version = ?)").bind(stringify(next),next.version,enrollment.id,enrollment.version,submission.id,submission.version),
    env.DB.prepare(`UPDATE records SET data = ?, version = ? WHERE collection = 'submissions' AND id = ? AND version = ? AND ${lock.sql}`).bind(stringify(updated),updated.version,id,submission.version,...lock.values),
    guardedDelete(env,'overrides',pairId(submission.memberId,submission.courseId),lock),
    guardedInsert(env,'audit',auditItem('submission_reviewed',{submissionId:id,courseId:submission.courseId,memberId:submission.memberId,status:updated.status,reviewNote}),lock)
  ]);
  if (!changes(results[0]) || !changes(results[1])) conflict();
  return json({submission:updated});
}

async function override(request, env, memberId, courseId) {
  const body = await readJson(request);
  const member = await required(env,'members',memberId);
  const course = await required(env,'courses',courseId);
  if (!['approved','not_submitted','exempt','clear'].includes(body.status)) fail(400,'수동 처리 상태를 확인해 주세요.');
  const reason = text(body.reason,'수동 처리 사유',2000,true);
  const id = pairId(member.id,course.id);
  const current = await get(env,'overrides',id);
  if (version(body.version,true) !== (current?.version || 0)) conflict();
  const enrollment = await ensureEnrollment(env,member.id,course.id);
  const next = {...enrollment,version:enrollment.version+1,nonce:uuid()};
  const lock = guard(env,next);
  const value = {id,memberId:member.id,courseId:course.id,status:body.status,reason,updatedAt:now(),version:Math.max(current?.version || 0,enrollment.version)+1};
  const overrideGuard = current ? "EXISTS (SELECT 1 FROM records WHERE collection = 'overrides' AND id = ? AND version = ?)" : "NOT EXISTS (SELECT 1 FROM records WHERE collection = 'overrides' AND id = ?)";
  const overrideValues = current ? [id,current.version] : [id];
  const statements = [env.DB.prepare(`UPDATE records SET data = ?, version = ? WHERE collection = 'enrollments' AND id = ? AND version = ? AND ${overrideGuard}`).bind(stringify(next),next.version,enrollment.id,enrollment.version,...overrideValues),guardedDelete(env,'overrides',id,lock)];
  if (body.status !== 'clear') statements.push(guardedInsert(env,'overrides',value,lock));
  statements.push(guardedInsert(env,'audit',auditItem('completion_override',{memberId:member.id,courseId:course.id,status:body.status,reason}),lock));
  const results = await env.DB.batch(statements);
  if (!changes(results[0])) conflict();
  return json({override:body.status==='clear' ? null : value});
}

function safeName(value, max = 100) {
  return String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/\.\./g,'_').replace(/[. ]+$/g,'').slice(0,max) || '자료';
}

function disposition(type,name) { return `${type}; filename="certificate.${name.split('.').at(-1)}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g,ch=>`%${ch.charCodeAt(0).toString(16)}`)}`; }

function mayBePropagating(env,file) {
  const age = Date.now()-Date.parse(file.createdAt);
  return env.FILES.consistency === 'eventual' && Number.isFinite(age) && age >= -60000 && age < 10*60*1000;
}
function filePropagating() { fail(503,'파일을 저장소에 반영 중입니다. 잠시 후 다시 시도해 주세요.','FILE_PROPAGATING'); }

async function fileResponse(request, env, fileId, url) {
  const file = await required(env,'files',fileId,'첨부파일을 찾을 수 없습니다.');
  const adminSession = await session(request,env,'admin');
  let actor = {id:'admin',role:adminSession?.role,identityAssurance:'shared_admin_password'};
  if (!adminSession) {
    const member = await requireMember(request,env);
    if (file.memberId !== member.id) fail(403,'본인의 제출 파일만 열람할 수 있습니다.');
    actor = {id:member.id,role:'member',identityAssurance:'name_selection_unverified'};
  }
  const object = await env.FILES.get(file.key);
  if (!object && mayBePropagating(env,file)) filePropagating();
  if (!object) fail(404,'저장된 파일을 찾을 수 없습니다. 담당자에게 문의해 주세요.');
  if (Number(object.size)!==file.size) {
    await object.body?.cancel();
    fail(409,'저장된 파일의 크기가 다릅니다. 담당자에게 문의해 주세요.');
  }
  const download = url.searchParams.get('download') === '1';
  try {
    // This records server acceptance, not a completed transfer or a verified
    // individual: name selection and the shared admin password remain as-is.
    await recordFileAccess(env,[fileAccessAudit(file,actor,download ? 'download':'preview',uuid(),now())]);
    return new Response(object.body,{headers:{'Content-Type':file.type,'Content-Length':String(file.size),'Content-Disposition':disposition(download ? 'attachment':'inline',file.name),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
  } catch (error) {
    await object.body?.cancel().catch(() => {});
    throw error;
  }
}

async function zipResponse(request, env, courseId, url, adminSession) {
  const actor = {id:'admin',role:adminSession.role,identityAssurance:'shared_admin_password'};
  const course = await required(env,'courses',courseId);
  const scope = url.searchParams.get('scope') || 'approved';
  if (!['approved','latest'].includes(scope)) fail(400,'다운로드 범위를 확인해 주세요.');
  const [members,submissions,overrides,files] = await Promise.all(['members','submissions','overrides','files'].map(collection => all(env,collection)));
  const fileMap = new Map(files.map(file=>[file.id,file]));
  const entries = [], accessFiles = [];
  let total = 0;
  for (const member of members) {
    const latest = getLatestSubmission(submissions,member.id,course.id);
    const manual = overrides.find(value=>value.memberId===member.id && value.courseId===course.id);
    const effectiveStatus = manual?.status || latest?.status;
    if (!latest || (scope==='approved' && effectiveStatus!=='approved')) continue;
    for (const [index,file] of latest.files.entries()) {
      const stored = fileMap.get(file.id);
      if (!stored) fail(409,`${member.name} 님의 파일 정보가 누락되었습니다. 담당자 확인이 필요합니다.`);
      const head = await env.FILES.head(stored.key);
      if (!head && mayBePropagating(env,stored)) filePropagating();
      if (!head || Number(head.size)!==file.size) fail(409,`${member.name} 님의 수료증 파일이 누락되었거나 크기가 다릅니다. 일괄 다운로드를 중단했습니다.`);
      total += file.size;
      if (total > 2*1024*1024*1024) fail(413,'다운로드 파일 합계가 2GB를 초과했습니다. 파일을 개별 내려받아 주세요.');
      const state = {pending:'확인중',approved:'승인',needs_revision:'보완요청',not_submitted:'미제출처리',exempt:'면제'}[effectiveStatus] || '제출본';
      const name = `${safeName(course.name)}/${state}/${safeName(member.team || '부서')}_${safeName(member.name)}_${safeName(member.id,50)}_${latest.completedOn}_${index+1}.${stored.ext || file.name.split('.').at(-1).toLowerCase()}`;
      entries.push({name,open:async()=>{
        const object = await env.FILES.get(stored.key);
        if (!object) throw new Error('다운로드 중 파일이 사라졌습니다. 다시 시도해 주세요.');
        if (Number(object.size)!==file.size) { await object.body?.cancel(); throw new Error('다운로드 중 파일 크기가 변경되었습니다. 담당자에게 문의해 주세요.'); }
        return object.body;
      }});
      accessFiles.push(stored);
    }
  }
  if (!entries.length) fail(404,scope==='approved' ? '최신 제출본 중 승인된 수료증 파일이 없습니다.' : '제출된 수료증 파일이 없습니다.');
  const requestId = uuid(), requestAcceptedAt = now();
  await recordFileAccess(env,[
    ...accessFiles.map(file => fileAccessAudit(file,actor,'zip',requestId,requestAcceptedAt)),
    auditItem('certificates_downloaded',{courseId:course.id,scope,fileCount:entries.length,totalBytes:total,requestId,requestAcceptedAt,actorRole:actor.role,identityAssurance:actor.identityAssurance},actor.id),
  ]);
  return new Response(createZip(entries),{headers:{'Content-Type':'application/zip','Content-Disposition':disposition('attachment',`${safeName(course.name)}_${scope==='approved'?'승인본':'최신제출본'}_${today()}.zip`),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}

async function importLegacy(request, env) {
  const body = await readJson(request);
  if (body.confirm !== true || !Array.isArray(body.members) || !body.members.length || body.members.length>2000) fail(400,'기존 기록 병합을 확인해 주세요.');
  const [members,courses] = await Promise.all([all(env,'members'),all(env,'courses')]);
  const memberMap = new Map(members.map(member=>[member.id,member]));
  const courseIds = new Set(courses.map(course=>course.id));
  const statements = [];
  const nonce = uuid();
  let created = 0, updated = 0, addedCompletions = 0;
  const seen = new Set();
  for (const raw of body.members) {
    if (!raw || typeof raw!=='object' || raw.id==null) fail(400,'기존 명단의 식별번호를 확인해 주세요.');
    const id = cleanId(String(raw.id));
    if (seen.has(id)) fail(400,'중복된 부서원 식별번호가 있습니다.');
    seen.add(id);
    const name = text(raw.name,'이름',100,true);
    const existing = memberMap.get(id);
    if (existing && existing.name!==name) fail(409,`${id}번 부서원의 이름이 현재 명단과 다릅니다. 기존 기록을 확인해 주세요.`);
    if (!Array.isArray(raw.completions)) fail(400,'기존 이수 목록을 확인해 주세요.');
    const completionIds = [...new Set(raw.completions.map(value=>cleanId(String(value))))];
    if (completionIds.some(courseId=>!courseIds.has(courseId))) fail(400,'현재 교육 목록에 없는 이수 기록이 있습니다. 교육 목록을 먼저 확인해 주세요.');
    const merged = [...new Set([...(existing?.legacyCompletions||[]),...completionIds])];
    addedCompletions += merged.length-(existing?.legacyCompletions?.length||0);
    if (existing && merged.length===(existing.legacyCompletions || []).length) continue;
    const timestamp = now();
    const item = existing ? {...existing,legacyCompletions:merged,updatedAt:timestamp,version:existing.version+1} : {id,name,position:text(raw.position,'직급',100),team:'',active:true,joinedOn:'',leftOn:'',note:'',legacyCompletions:merged,createdAt:timestamp,updatedAt:timestamp,version:1};
    // A guard row makes the full import transactional if any member changed after validation.
    if (existing) {
      statements.push(env.DB.prepare("INSERT INTO records(collection,id,data,version) SELECT 'import_guards',?, 'invalid',1 WHERE NOT EXISTS (SELECT 1 FROM records WHERE collection = 'members' AND id = ? AND version = ?)").bind(nonce,id,existing.version));
      statements.push(update(env,'members',item,existing.version));
      updated++;
    } else { statements.push(insert(env,'members',item)); created++; }
  }
  // The duplicate guard key causes a failed condition to roll the whole batch back.
  const guardRow = {id:nonce,version:1};
  statements.unshift(insert(env,'import_guards',guardRow));
  statements.push(insert(env,'audit',auditItem('legacy_imported',{created,updated,addedCompletions})),env.DB.prepare("DELETE FROM records WHERE collection = 'import_guards' AND id = ?").bind(nonce));
  try { await env.DB.batch(statements); }
  catch(error) { if (/UNIQUE|constraint|primary key/i.test(String(error))) conflict(); throw error; }
  return json({created,updated,addedCompletions});
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/,'');
  if (path!=='/api' && !path.startsWith('/api/')) return null;
  if (!ALLOWED_METHODS.has(request.method)) fail(405,'지원하지 않는 요청입니다.');
  if (request.method!=='GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin!==url.origin) fail(403,'다른 사이트에서 보낸 요청은 처리할 수 없습니다.');
  }
  if (!env.DB || !env.FILES) fail(503,'서버 저장소 연결이 필요합니다.');
  if (path==='/api/bootstrap' && request.method==='GET') {
    const [courses,members,selected,savedOrder,savedChart] = await Promise.all([all(env,'courses'),all(env,'members'),session(request,env,'member'),get(env,'settings','member-order'),get(env,'settings','department-chart')]);
    const ordered = memberOrdering(members,savedOrder);
    return json({courses:visibleCourses(courses),members:ordered.members.filter(member=>member.active).map(publicMember),departmentChart:departmentChart(ordered.members,savedChart),selectedMemberId:members.some(member=>member.id===selected?.member_id && member.active) ? selected.member_id : null,serverTime:now()});
  }
  if (path==='/api/member-session' && request.method==='POST') {
    const body = await readJson(request);
    const member = await required(env,'members',cleanId(body.memberId),'이름을 찾을 수 없습니다.');
    if (!member.active) fail(403,'재직 중인 부서원만 선택할 수 있습니다.');
    return json({member},200,{'Set-Cookie':await createSession(request,env,'member',member.id)});
  }
  if (path==='/api/member-session' && request.method==='DELETE') {
    await clearSession(request,env,'member');
    return json({ok:true},200,{'Set-Cookie':cookieHeader(request,'member','',0)});
  }
  if (path==='/api/me' && request.method==='GET') {
    const member = await requireMember(request,env);
    const [courses,submissions,overrides] = await Promise.all(['courses','submissions','overrides'].map(collection=>all(env,collection)));
    return json({member,courses:visibleCourses(courses),submissions:submissions.filter(value=>value.memberId===member.id),overrides:overrides.filter(value=>value.memberId===member.id),serverTime:now()});
  }
  if (path==='/api/submissions' && request.method==='POST') return submit(request,env);
  let match = /^\/api\/files\/([\w:-]+)$/.exec(path);
  if (match && request.method==='GET') return fileResponse(request,env,match[1],url);
  if (path==='/api/admin/login' && request.method==='POST') return login(request,env);
  if (path==='/api/admin/session' && request.method==='GET') return json({authenticated:!!await session(request,env,'admin')});
  if (path==='/api/admin/logout' && request.method==='POST') {
    await clearSession(request,env,'admin');
    return json({ok:true},200,{'Set-Cookie':cookieHeader(request,'admin','',0)});
  }
  if (path.startsWith('/api/admin/')) {
    const adminSession = await requireAdmin(request,env);
    if (path==='/api/admin/file-access' && request.method==='GET') return listFileAccess(env,url);
    if (path==='/api/admin/data' && request.method==='GET') {
      const [courses,members,submissions,overrides,auditRows,savedOrder,savedChart] = await Promise.all([...['courses','members','submissions','overrides'].map(collection=>all(env,collection)),env.DB.prepare("SELECT data FROM records WHERE collection = 'audit' ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT 500").all(),get(env,'settings','member-order'),get(env,'settings','department-chart')]);
      const ordered = memberOrdering(members,savedOrder);
      return json({courses,members:ordered.members,memberOrder:ordered.memberOrder,departmentChart:departmentChart(ordered.members,savedChart),submissions,overrides,audit:auditRows.results.map(row=>JSON.parse(row.data)),serverTime:now()});
    }
    if (path==='/api/admin/member-order' && request.method==='PUT') return saveMemberOrder(request,env);
    if (path==='/api/admin/department-chart' && request.method==='PUT') return saveDepartmentChart(request,env);
    if (path==='/api/admin/courses' && request.method==='POST') return saveCourse(request,env);
    match = /^\/api\/admin\/courses\/([\w:-]+)$/.exec(path);
    if (match && request.method==='PUT') return saveCourse(request,env,match[1]);
    if (path==='/api/admin/members' && request.method==='POST') return saveMember(request,env);
    match = /^\/api\/admin\/members\/([\w:-]+)\/history$/.exec(path);
    if (match && request.method==='GET') {
      const member = await required(env,'members',match[1]);
      const entries = await all(env,'audit');
      const history = entries.filter(entry => ['member_created','member_updated'].includes(entry.action) && entry.detail?.memberId === member.id)
        .sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      return json({history,serverTime:now()});
    }
    match = /^\/api\/admin\/members\/([\w:-]+)$/.exec(path);
    if (match && request.method==='PUT') return saveMember(request,env,match[1]);
    match = /^\/api\/admin\/submissions\/([\w:-]+)\/review$/.exec(path);
    if (match && request.method==='POST') return review(request,env,match[1]);
    match = /^\/api\/admin\/overrides\/([\w-]+)\/([\w-]+)$/.exec(path);
    if (match && request.method==='PUT') return override(request,env,match[1],match[2]);
    match = /^\/api\/admin\/courses\/([\w:-]+)\/download$/.exec(path);
    if (match && request.method==='GET') return zipResponse(request,env,match[1],url,adminSession);
    if (path==='/api/admin/import-legacy' && request.method==='POST') return importLegacy(request,env);
  }
  fail(404,'요청한 기능을 찾을 수 없습니다.');
}

export async function handleApi(request, env) {
  try { return await route(request,env); }
  catch(error) {
    if (error instanceof ApiError) return json({error:error.message,...(error.code ? {code:error.code} : {})},error.status,error.code==='FILE_PROPAGATING'?{'Retry-After':'5'}:{});
    console.error(JSON.stringify({event:'edu_api_error',method:request.method,path:new URL(request.url).pathname,message:error?.message || String(error)}));
    return json({error:'요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'},500);
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startLocalServer } from '../server/local.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGkAAAAASUVORK5CYII=', 'base64');
const timestamp = '2026-01-01T00:00:00.000Z';
const course = { id: 'local-course', name: '가상 로컬 교육', site: '가상교육원', url: 'https://example.com', deadline: '2026-12-31', submissionDeadline: '2026-12-20', year: 2026, periodType: 'year', periodValue: 0, details: ['가상 필수 과정'], requirement: 'all', requirementNote: '', requestDepartment: '가상부서', description: '', published: true, archived: false, targetMode: 'all', targetMemberIds: [], exemptMemberIds: [], createdAt: timestamp, updatedAt: timestamp, version: 1 };
const member = { id: 'local-member', name: '가상직원', position: '가상직급', team: '가상팀', active: true, joinedOn: '', leftOn: '', note: '공개하지 않는 가상 메모', legacyCompletions: [], createdAt: timestamp, updatedAt: timestamp, version: 1 };

async function fixture(t) {
  const base = path.resolve('.verification');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'local-test-'));
  const options = { port: 0, host: '127.0.0.1', dataDirectory: directory, adminPassword: 'synthetic-local-password', sessionSecret: 'synthetic-local-session-secret-more-than-32-bytes', seed: { courses: [course], members: [member] } };
  let instance;
  t.after(async () => {
    if (instance) await instance.close();
    if (!path.resolve(directory).startsWith(base + path.sep)) throw new Error('Unsafe local test cleanup path');
    await fs.rm(directory, { recursive: true, force: true });
  });
  instance = await startLocalServer(options);
  async function request(route, { method = 'GET', body, cookie, ...rest } = {}) {
    const headers = new Headers(rest.headers);
    if (cookie) headers.set('Cookie', cookie);
    if (!['GET', 'HEAD'].includes(method)) headers.set('Origin', instance.url);
    if (body && !(body instanceof FormData)) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(body); }
    return fetch(`${instance.url}${route}`, { ...rest, method, headers, ...(body ? { body } : {}) });
  }
  async function session(route, body) {
    const response = await request(route, { method: 'POST', body });
    assert.equal(response.status, 200, await response.clone().text());
    const headers = response.headers.getSetCookie();
    assert.equal(headers.length, 1);
    assert.match(headers[0], /HttpOnly/);
    assert.match(headers[0], /SameSite=Strict/);
    const data = await response.json();
    return { cookie: headers[0].split(';')[0], data };
  }
  async function upload(cookie) {
    const body = new FormData();
    body.set('courseId', course.id); body.set('completedOn', '2026-10-01');
    body.set('expectedMemberId', member.id); body.set('comment', '가상 HTTP 검증');
    body.append('files', new File([PNG], '가상 수료증.png', { type: 'image/png' }));
    const response = await request('/api/submissions', { method: 'POST', cookie, body });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).submission;
  }
  return {
    request, session, upload,
    async restart() {
      await instance.close(); instance = null;
      // Existing records must win over a replacement seed after a restart.
      instance = await startLocalServer({ ...options, seed: { courses: [{ ...course, name: '사용하면 안 되는 대체 시드' }], members: [] } });
    },
  };
}

test('local HTTP serves only public assets, redirects the root and blocks private files and encoded traversal', async t => {
  const f = await fixture(t);
  const redirect = await f.request('/', { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get('location'), /^http:\/\/127\.0\.0\.1:\d+\/edustatus_all\.html$/);
  await redirect.text();
  for (const [route, type] of [['/edustatus_all.html', /text\/html/], ['/edu-shared.mjs', /text\/javascript/], ['/edu-style.css', /text\/css/]]) {
    const response = await f.request(route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), type);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(await response.text(), await fs.readFile(new URL(`..${route}`, import.meta.url), 'utf8'));
  }
  const head = await f.request('/edustatus_admin.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /text\/html/);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const route of ['/server/seed.json', '/server/api.mjs', '/.dev.vars', '/.edu-data/education.sqlite', '/package.json', '/%2e%2e%2fserver%2fseed.json', '/%2e%2e%5c.dev.vars', '/edu-shared.mjs%2f..%2f.dev.vars']) {
    const response = await f.request(route);
    assert.equal(response.status, 404, route);
    assert.equal(await response.text(), '페이지를 찾을 수 없습니다.');
  }
  const write = await f.request('/edu-shared.mjs', { method: 'POST', body: { ignored: true } });
  assert.equal(write.status, 404);
  await write.text();
});

test('local HTTP forwards session cookies and preserves file API CSP, content type and original image bytes', async t => {
  const f = await fixture(t);
  const selected = await f.session('/api/member-session', { memberId: member.id });
  assert.equal(selected.data.member.id, member.id);
  const me = await f.request('/api/me', { cookie: selected.cookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).member.id, member.id);
  const submission = await f.upload(selected.cookie);
  const fileId = submission.files[0].id;
  for (const suffix of ['', '?download=1']) {
    const file = await f.request(`/api/files/${fileId}${suffix}`, { cookie: selected.cookie });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-security-policy'), "default-src 'none'; sandbox", 'the HTTP wrapper must preserve the file-specific sandbox');
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal(file.headers.get('content-length'), String(PNG.length));
    assert.match(file.headers.get('content-disposition'), suffix ? /^attachment;/ : /^inline;/);
    assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  }
  const denied = await f.request(`/api/files/${fileId}`);
  assert.equal(denied.status, 401);
  assert.ok((await denied.json()).error);
  const admin = await f.session('/api/admin/login', { password: 'synthetic-local-password' });
  const adminSession = await f.request('/api/admin/session', { cookie: admin.cookie });
  assert.deepEqual(await adminSession.json(), { authenticated: true });
});

test('local HTTP restart preserves database records, selected sessions and uploaded file bytes', async t => {
  const f = await fixture(t);
  const selected = await f.session('/api/member-session', { memberId: member.id });
  const admin = await f.session('/api/admin/login', { password: 'synthetic-local-password' });
  const submission = await f.upload(selected.cookie);
  const edited = await f.request(`/api/admin/courses/${course.id}`, { method: 'PUT', cookie: admin.cookie, body: { ...course, name: '재시작 후에도 보존할 교육명' } });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).course.version, 2);
  await f.restart();
  const me = await f.request('/api/me', { cookie: selected.cookie });
  assert.equal(me.status, 200);
  const data = await me.json();
  assert.equal(data.member.id, member.id);
  assert.equal(data.courses[0].name, '재시작 후에도 보존할 교육명');
  assert.equal(data.courses[0].version, 2);
  assert.equal(data.submissions[0].id, submission.id);
  const file = await f.request(`/api/files/${submission.files[0].id}`, { cookie: selected.cookie });
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  const adminSession = await f.request('/api/admin/session', { cookie: admin.cookie });
  assert.deepEqual(await adminSession.json(), { authenticated: true });
});

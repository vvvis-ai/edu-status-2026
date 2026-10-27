import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDisposalPlan, koreaDate} from '../scripts/prepare-certificate-disposal.mjs';

const course = (id, year) => ({id, year, name: '출력하면 안 되는 교육명'});
const file = (id, courseId, extra = {}) => ({id, courseId, memberId: 'm1', storageKey: `certificates/${courseId}/m1/s-${id}/${id}.pdf`, size: 100, name: '이름_생년월일.pdf', ...extra});

test('disposal eligibility starts on January 1 in Korea after the education year', () => {
  const metadata = {courses: [course('c26', 2026)], files: [file('f1', 'c26')]};
  assert.equal(buildDisposalPlan(metadata, {asOf: '2026-12-31'}).candidateCount, 0);
  const plan = buildDisposalPlan(metadata, {asOf: '2027-01-01'});
  assert.equal(plan.candidateCount, 1);
  assert.equal(plan.candidates[0].expiry, '2026-12-31');
  assert.equal(plan.status, 'pending_approval');
  assert.equal(koreaDate('2026-12-31T14:59:59.999Z'), '2026-12-31');
  assert.equal(koreaDate('2026-12-31T15:00:00.000Z'), '2027-01-01');
});

test('all revisions and late uploads use the education year, not file timestamps or approval', () => {
  const metadata = {courses: [course('c25', 2025), course('c26', 2026)], files: [
    file('old', 'c25', {createdAt: '2026-05-01', status: 'needs_revision'}),
    file('new', 'c25', {createdAt: '2027-02-01', status: 'approved'}),
    file('current', 'c26'),
  ]};
  const plan = buildDisposalPlan(metadata, {asOf: '2026-12-31'});
  assert.deepEqual(plan.candidates.map(item => item.id), ['new', 'old']);
  assert.equal(plan.filesExamined, 3);
  assert.equal(plan.totalBytes, 200);
});

test('export contains only allowed file identifiers, storage key, size, year and expiry', () => {
  const plan = buildDisposalPlan({courses: [course('c26', 2026)], files: [file('f1', 'c26', {birthDate: '1900-01-01', content: 'private PDF contents', cookie: 'secret'})]}, {asOf: '2027-01-01'});
  assert.deepEqual(Object.keys(plan.candidates[0]).sort(), ['id', 'courseId', 'memberId', 'storageKey', 'size', 'courseYear', 'expiry'].sort());
  const json = JSON.stringify(plan);
  for (const forbidden of ['생년월일', '1900-01-01', 'private PDF contents', '출력하면 안 되는 교육명', 'cookie']) assert.ok(!json.includes(forbidden));
});

test('invalid dates, unknown years, duplicate IDs and unsafe storage metadata fail closed', () => {
  const valid = {courses: [course('c26', 2026)], files: [file('f1', 'c26')]};
  assert.throws(() => buildDisposalPlan(valid, {asOf: '2027-02-30'}));
  assert.throws(() => buildDisposalPlan({courses: [], files: valid.files}));
  assert.throws(() => buildDisposalPlan({courses: [course('c26', '2026')], files: valid.files}));
  assert.throws(() => buildDisposalPlan({...valid, files: [valid.files[0], valid.files[0]]}));
  assert.throws(() => buildDisposalPlan({...valid, files: [file('f1', 'c26', {storageKey: '이름_생년월일.pdf'})]}));
  assert.throws(() => buildDisposalPlan({...valid, files: [file('f1', 'c26', {size: -1})]}));
});

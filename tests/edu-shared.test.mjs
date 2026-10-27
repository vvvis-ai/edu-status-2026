import test from 'node:test';
import assert from 'node:assert/strict';
import { getLatestSubmission, isTarget, getStatus, getProgress, matchesPeriod, isNewCourse } from '../edu-shared.mjs';

const course = (id = 'c1', extra = {}) => ({ id, year: 2026, periodType: 'year', periodValue: 0, published: true, targetMode: 'all', targetMemberIds: [], exemptMemberIds: [], ...extra });
const member = (extra = {}) => ({ id: 'm1', active: true, legacyCompletions: [], ...extra });
const submission = (extra = {}) => ({ id: 's1', memberId: 'm1', courseId: 'c1', status: 'pending', revision: 1, submittedAt: '2026-10-01T00:00:00.000Z', ...extra });

test('latest submission uses revision before timestamps and leaves historical input in place', () => {
  const history = [
    submission({ id: 'old', status: 'approved', submittedAt: '2026-10-20T00:00:00Z' }),
    submission({ id: 'new', revision: 2, status: 'needs_revision' }),
    submission({ id: 'other-person', memberId: 'm2', revision: 50 }),
    submission({ id: 'other-course', courseId: 'c2', revision: 50 }),
  ];
  const before = structuredClone(history);
  assert.equal(getLatestSubmission(history, 'm1', 'c1').id, 'new');
  assert.equal(getLatestSubmission(history, 'missing', 'c1'), null);
  assert.deepEqual(history, before);
  assert.equal(getLatestSubmission([submission({ memberId: 1, courseId: 2 })], '1', '2').id, 's1');
  assert.equal(getLatestSubmission([
    submission({ id: 'a', submittedAt: '2026-10-02T00:00:00Z' }),
    submission({ id: 'z', submittedAt: '2026-10-01T00:00:00Z' }),
  ], 'm1', 'c1').id, 'a');
});

test('target membership and exemptions use stable IDs and preserve other people as non-targets', () => {
  assert.equal(isTarget(null, member()), false);
  assert.equal(isTarget(course(), null), false);
  assert.equal(isTarget(course(), member()), true);
  const selected = course('c1', { targetMode: 'selected', targetMemberIds: [1, 'm2'], exemptMemberIds: ['m2'] });
  assert.equal(isTarget(selected, member({ id: '1' })), true);
  assert.equal(isTarget(selected, member({ id: 'm2' })), false);
  assert.equal(isTarget(selected, member()), false);
});

test('display status honors manual decisions, exemptions, latest review and imported completions in order', () => {
  const person = member({ legacyCompletions: ['c1'] });
  assert.equal(getStatus(course(), person), 'approved');
  assert.equal(getStatus(course(), member()), 'not_submitted');
  assert.equal(getStatus(course(), person, [submission()]), 'pending');
  const history = [submission({ status: 'approved' }), submission({ id: 'retry', revision: 2, status: 'needs_revision' })];
  assert.equal(getStatus(course(), person, history), 'needs_revision');
  const exempt = course('c1', { exemptMemberIds: ['m1'] });
  assert.equal(getStatus(exempt, person, history), 'exempt');
  assert.equal(getStatus(course('c1', { targetMode: 'selected' }), person, history), 'not_target');
  const overrides = [
    { memberId: 'm2', courseId: 'c1', status: 'approved' },
    { memberId: 'm1', courseId: 'c2', status: 'approved' },
    { memberId: 'm1', courseId: 'c1', status: 'not_submitted' },
  ];
  assert.equal(getStatus(exempt, person, history, overrides), 'not_submitted');
});

test('progress excludes drafts, archived courses, exemptions and non-targets and counts pending/revision as remaining', () => {
  const courses = [course('legacy'), course('manual'), course('pending'), course('revision'), course('missing'),
    course('exempt', { exemptMemberIds: ['m1'] }), course('other', { targetMode: 'selected', targetMemberIds: ['m2'] }),
    course('draft', { published: false }), course('archived-complete', { archived: true }), course('archived-missing', { archived: true })];
  const submissions = [submission({ courseId: 'pending' }), submission({ courseId: 'revision', status: 'needs_revision' })];
  const overrides = [{ memberId: 'm1', courseId: 'manual', status: 'approved' }];
  assert.deepEqual(getProgress(courses, member({ legacyCompletions: ['legacy', 'draft', 'archived-complete'] }), submissions, overrides),
    { total: 5, approved: 2, pending: 1, needsRevision: 1, remaining: 3, percent: 40 });
  assert.deepEqual(getProgress([], member()), { total: 0, approved: 0, pending: 0, needsRevision: 0, remaining: 0, percent: 0 });
});

test('period filters include annual courses and overlap monthly/quarterly courses across all calendar boundaries', () => {
  for (let month = 1; month <= 12; month++) {
    const quarter = Math.ceil(month / 3);
    assert.equal(matchesPeriod(course(), { year: '2026', month: String(month) }), true);
    assert.equal(matchesPeriod(course(), { year: 2026, quarter }), true);
    for (let value = 1; value <= 12; value++) {
      const monthly = course('m', { periodType: 'month', periodValue: value });
      assert.equal(matchesPeriod(monthly, { year: 2026, month }), value === month);
      assert.equal(matchesPeriod(monthly, { year: 2026, quarter }), Math.ceil(value / 3) === quarter);
    }
    for (let value = 1; value <= 4; value++) {
      const quarterly = course('q', { periodType: 'quarter', periodValue: String(value) });
      assert.equal(matchesPeriod(quarterly, { year: 2026, month }), value === quarter);
      assert.equal(matchesPeriod(quarterly, { year: 2026, quarter }), value === quarter);
    }
  }
  assert.equal(matchesPeriod(course(), { year: 2025, month: 1 }), false);
  assert.equal(matchesPeriod(course('c', { periodType: 'month', periodValue: 12 }), { year: 2026 }), true);
  assert.equal(matchesPeriod(course(), {}), true);
});

test('new-course badge is limited to the first fourteen elapsed days and excludes future or invalid dates', () => {
  const item = course('c1', { createdAt: '2026-10-01T00:00:00.000Z' });
  assert.equal(isNewCourse(item, item.createdAt), true);
  assert.equal(isNewCourse(item, '2026-10-14T23:59:59.999Z'), true);
  assert.equal(isNewCourse(item, '2026-10-15T00:00:00.000Z'), false);
  assert.equal(isNewCourse(item, '2026-09-30T23:59:59.999Z'), false);
  assert.equal(isNewCourse({ ...item, createdAt: 'invalid' }, item.createdAt), false);
});

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
export const MAX_FILES = 10;
export const FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp';
export const UPLOAD_NOTICE = 'PDF 또는 사진 파일(JPG·PNG·WebP)을 끌어다 놓거나 선택해 주세요. DRM이 적용된 파일은 기관에서 허용하는 절차로 보안 해제 후 업로드해 주세요.';
export const STATUS_LABELS = Object.freeze({
  not_target: '대상 아님', not_submitted: '미제출', pending: '확인 중',
  approved: '이수 완료', needs_revision: '보완 요청', exempt: '면제',
});

export function getLatestSubmission(submissions = [], memberId, courseId) {
  return submissions.filter(s => String(s.memberId) === String(memberId) && String(s.courseId) === String(courseId))
    .sort((a, b) => (b.revision || 0) - (a.revision || 0) || String(b.submittedAt).localeCompare(String(a.submittedAt)) || String(b.id).localeCompare(String(a.id)))[0] || null;
}

export function isTarget(course, member) {
  if (!course || !member) return false;
  const id = String(member.id);
  if ((course.exemptMemberIds || []).map(String).includes(id)) return false;
  return course.targetMode !== 'selected' || (course.targetMemberIds || []).map(String).includes(id);
}

export function getStatus(course, member, submissions = [], overrides = []) {
  const override = overrides.find(o => String(o.memberId) === String(member.id) && String(o.courseId) === String(course.id));
  if (override) return override.status;
  if ((course.exemptMemberIds || []).map(String).includes(String(member.id))) return 'exempt';
  if (!isTarget(course, member)) return 'not_target';
  const latest = getLatestSubmission(submissions, member.id, course.id);
  if (latest) return latest.status;
  if ((member.legacyCompletions || []).map(String).includes(String(course.id))) return 'approved';
  return 'not_submitted';
}

export function getProgress(courses, member, submissions = [], overrides = []) {
  const statuses = courses.filter(c => c.published && !c.archived).map(c => getStatus(c, member, submissions, overrides))
    .filter(s => !['exempt', 'not_target'].includes(s));
  const approved = statuses.filter(s => s === 'approved').length;
  return {total: statuses.length, approved, pending: statuses.filter(s => s === 'pending').length,
    needsRevision: statuses.filter(s => s === 'needs_revision').length,
    remaining: statuses.length - approved, percent: statuses.length ? Math.round(approved / statuses.length * 100) : 0};
}

export function matchesPeriod(course, filter = {}) {
  const {year, month, quarter} = filter;
  if (year && Number(course.year) !== Number(year)) return false;
  if (!month && !quarter) return true;
  // 연간 교육은 모든 월·분기에서 확인할 수 있습니다.
  if (course.periodType === 'year') return true;
  const value = Number(course.periodValue);
  if (month) return course.periodType === 'month' ? value === Number(month) : value === Math.ceil(Number(month) / 3);
  return course.periodType === 'quarter' ? value === Number(quarter) : Math.ceil(value / 3) === Number(quarter);
}

export function isNewCourse(course, now = new Date()) {
  const age = new Date(now).getTime() - new Date(course.createdAt).getTime();
  return age >= 0 && age < 14 * 86400000;
}

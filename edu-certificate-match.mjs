const normalizeName = value => (value || '').normalize('NFKC').replace(/\s/g, '').toLowerCase();

function courseTitle(value) {
  return (value || '').normalize('NFKC').toLowerCase().trim()
    .replace(/^\d+[.)]\s+|^제\s*\d+\s*기\s*/g, '')
    .replace(/\[(?:\d{4}\s*[-년]\s*)?\d+\s*기\]$/g, '')
    .replace(/\(\s*(?:\d+\s*시간\s*)?(?:\d+\s*분\s*)?\)$/g, '')
    .replace(/[\s\p{P}]/gu, '');
}

export function findCertificateMatch(fields, {courses, members}) {
  const name = normalizeName(fields.name);
  const people = name ? members.filter(member => normalizeName(member.name) === name) : [];
  const member = people.length === 1 && people[0].active ? people[0] : null;
  const title = courseTitle(fields.course);
  const parts = (fields.course || '').split(' / ').map(courseTitle);
  const year = Number(fields.date?.slice(0, 4));
  const seats = courses.filter(course => course.published && !course.archived && (!year || Number(course.year) === year));
  const matches = [];
  if (title) {
    for (const course of seats) {
      const details = (course.details || []).map(courseTitle).filter(Boolean);
      const exact = courseTitle(course.name) === title;
      const matched = details.filter(detail => parts.includes(detail));
      if (exact || matched.length) {
        const complete = course.requirement !== 'one' && details.length > 1 ? matched.length === details.length || (exact && course.requirement === 'custom') : true;
        matches.push({course, complete});
      }
    }
  }
  const match = matches.length === 1 ? matches[0] : null;
  return {memberId:member?.id || '', courseId:match?.course.id || '', confirmed:!!(member && match?.complete && fields.date && !fields.ocrFailed),
    hint:people.length > 1 ? '동명이인입니다. 부서원과 팀을 확인해 주세요.'
      : matches.length > 1 ? '일치하는 교육이 여러 개입니다. 교육 기간을 확인해 주세요.'
      : match && !match.complete ? '관련 세부 과정입니다. 교육의 전체 이수 요건을 확인해 주세요.' : ''};
}

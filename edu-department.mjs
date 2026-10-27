import {escapeHtml as esc} from './edu-client.mjs';

export function departmentMarkup(members, chart, {search = '', selectable = true} = {}) {
  const active = members.filter(member => member.active !== false);
  const byId = new Map(active.map(member => [member.id, member]));
  const seen = new Set();
  const term = search.trim().toLocaleLowerCase('ko');
  let matchCount = 0;
  const matches = (member, group) => [member.name, member.team, member.position, group]
    .some(value => String(value || '').toLocaleLowerCase('ko').includes(term));
  const card = (member, group) => {
    if (!matches(member, group)) return '';
    matchCount++;
    const content = `<strong>${esc(member.name)}</strong><small>${esc(member.position || group || '부서원')}</small>`;
    return selectable
      ? `<button type="button" class="name-card" data-select-member="${esc(member.id)}">${content}</button>`
      : `<div class="name-card chart-person">${content}</div>`;
  };
  const leader = byId.get(chart?.leaderId);
  if (leader) seen.add(leader.id);
  const root = `<div class="department-root"><span class="department-role">과장</span>${leader ? card(leader, '과장') || '<p class="department-placeholder">검색 결과 없음</p>' : '<p class="department-placeholder">과장 미지정</p>'}</div>`;
  const teams = Array.from({length:4}, (_, index) => chart?.teams?.[index] || {id:`team-${index + 1}`,name:`${index + 1}팀`,memberIds:[]});
  const teamMarkup = teams.map(team => {
    const ids = new Set(team.memberIds || []);
    const people = active.filter(member => ids.has(member.id) && !seen.has(member.id));
    people.forEach(member => seen.add(member.id));
    const cards = people.map(member => card(member, team.name)).join('');
    return `<section class="department-team" aria-label="${esc(team.name)}"><div class="department-team-head"><h3>${esc(team.name)}</h3><span>${people.length}명</span></div><div class="department-team-members">${cards || `<p class="department-placeholder">${term ? '검색 결과 없음' : '배치된 부서원이 없습니다.'}</p>`}</div></section>`;
  }).join('');
  const waiting = active.filter(member => !seen.has(member.id));
  const waitingCards = waiting.map(member => card(member, '팀 배치 대기')).join('');
  const unassigned = waiting.length && (!term || waitingCards)
    ? `<section class="department-unassigned" aria-label="팀 배치 대기"><h3>팀 배치 대기 <span>${waiting.length}명</span></h3><p class="muted">관리자가 조직도에서 팀을 배치할 수 있습니다.</p><div class="department-waiting-members">${waitingCards}</div></section>` : '';
  return {html:`${root}<div class="department-teams">${teamMarkup}</div>${unassigned}`, matchCount, unassignedCount:waiting.length};
}

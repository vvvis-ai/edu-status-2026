import {
  api, escapeHtml as e, formatDate, formatTime, formatBytes, showToast,
  openDialog, closeDialog, downloadFile, downloadXlsx, statusBadge, fetchStoredFile,
} from './edu-client.mjs';
import {
  getLatestSubmission, getStatus, getProgress, matchesPeriod,
  isNewCourse, STATUS_LABELS,
} from './edu-shared.mjs';

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
let data = {courses: [], members: [], submissions: [], overrides: [], audit: []};
let currentTab = 'review';
let editingCourse = null;
let editingMember = null;
let downloadCourseId = null;
let reviewSubmissionId = null;
let previewController = null;
let previewUrl = '';
let memberOrderDraft = [];
let memberOrderVersion = 0;
let memberOrderBusy = false;
let memberOrderDraggingId = null;
let memberOrderRendering = false;
let loading = false;

function setError(element, message) { element.textContent = message || ''; element.hidden = !message; }
function busy(button, active, label) {
  if (active) { button.dataset.originalLabel = button.textContent; button.textContent = label || '처리 중…'; }
  else button.textContent = button.dataset.originalLabel || button.textContent;
  button.disabled = active;
}
function periodOptions() {
  const [kind, value] = $('#periodFilter').value.split(':');
  return {year: Number($('#yearFilter').value), month: kind === 'm' ? Number(value) : undefined, quarter: kind === 'q' ? Number(value) : undefined};
}
function includesQuery(...values) { const term = $('#adminSearch').value.trim().toLocaleLowerCase(); return !term || values.some(value => String(value || '').toLocaleLowerCase().includes(term)); }
function periodCourses() { return data.courses.filter(course => matchesPeriod(course, periodOptions())).sort((a, b) => a.deadline.localeCompare(b.deadline) || a.name.localeCompare(b.name, 'ko')); }
function publishedCourses() { return periodCourses().filter(course => course.published && !course.archived); }
function courseName(courseId) { return data.courses.find(course => course.id === courseId)?.name || '교육 미상'; }
function latestSubmissions() { return data.submissions.filter(submission => getLatestSubmission(data.submissions, submission.memberId, submission.courseId)?.id === submission.id); }
function statusLabel(status) { return STATUS_LABELS[status] || status; }
function periodLabel(course) {
  if (course.periodType === 'month') return `${course.year}년 ${course.periodValue}월`;
  if (course.periodType === 'quarter') return `${course.year}년 ${course.periodValue}분기`;
  return `${course.year}년 연간`;
}
function visibilityBadge(course) {
  if (course.archived) return '<span class="badge muted">보관</span>';
  return course.published ? '<span class="badge success">공개</span>' : '<span class="badge muted">임시저장</span>';
}
function updateYearOptions() {
  const previous = Number($('#yearFilter').value) || new Date().getFullYear();
  const years = [...new Set([new Date().getFullYear(), previous, ...data.courses.map(course => course.year)])].sort((a, b) => b - a);
  $('#yearFilter').innerHTML = years.map(year => `<option value="${year}">${year}년</option>`).join('');
  $('#yearFilter').value = String(previous);
}

async function loadData({toast = false} = {}) {
  if (loading) return;
  loading = true;
  $('#refreshButton').disabled = true;
  setError($('#connectionError'), '');
  try {
    const response = await api('/admin/data');
    for (const key of ['courses', 'members', 'submissions', 'overrides', 'audit']) {
      if (!Array.isArray(response[key])) throw new Error('서버 응답을 확인할 수 없습니다. 새로고침 후 다시 시도해 주세요.');
    }
    data = response;
    updateYearOptions(); render();
    $('#updatedAt').textContent = `마지막 확인: ${formatTime(response.serverTime || new Date().toISOString())}`;
    $('#loadingState').hidden = true;
    $('#adminContent').hidden = false;
    if (toast) showToast('최신 현황을 불러왔습니다.');
  } catch (error) {
    setError($('#connectionError'), `현황을 불러오지 못했습니다. ${error.message}`);
    $('#loadingState').hidden = true;
    if (error.status === 401) showLogin();
    throw error;
  } finally { loading = false; $('#refreshButton').disabled = false; }
}
function showLogin() { $('#dashboard').hidden = true; $('#loginScreen').hidden = false; $('#passwordInput').value = ''; }
async function enterDashboard() { $('#loginScreen').hidden = true; $('#dashboard').hidden = false; await loadData(); }

function renderStats() {
  const courses = publishedCourses();
  const members = data.members.filter(member => member.active);
  let total = 0, approved = 0;
  members.forEach(member => { const progress = getProgress(courses, member, data.submissions, data.overrides); total += progress.total; approved += progress.approved; });
  const ids = new Set(periodCourses().map(course => course.id));
  const pending = latestSubmissions().filter(submission => ids.has(submission.courseId) && submission.status === 'pending').length;
  $('#pendingCount').textContent = String(pending);
  const stats = [
    {label: '확인 대기 수료증', value: pending, unit: '건', note: '각 부서원의 최신 제출 기준', color: '#b47712'},
    {label: '공개된 교육', value: courses.length, unit: '개', note: '선택한 기간의 진행 교육', color: '#6250c8'},
    {label: '전체 이수율', value: total ? Math.round(approved / total * 100) : 0, unit: '%', note: `대상 ${total}건 중 ${approved}건 승인`, color: '#1d8c70'},
    {label: '재직 부서원', value: members.length, unit: '명', note: '전출 기록은 별도로 보관', color: '#516179'},
  ];
  $('#statsGrid').innerHTML = stats.map(stat => `<div class="admin-stat"><span class="muted">${stat.label}</span><strong class="stat-value" style="color:${stat.color}">${stat.value}<span style="font-size:16px;margin-left:4px">${stat.unit}</span></strong><p>${stat.note}</p></div>`).join('');
}
function renderReview() {
  const ids = new Set(periodCourses().map(course => course.id));
  const selectedStatus = $('#reviewStatusFilter').value;
  const rows = latestSubmissions().filter(submission => {
    const member = data.members.find(item => item.id === submission.memberId);
    const course = data.courses.find(item => item.id === submission.courseId);
    return ids.has(submission.courseId) && (selectedStatus === 'all' || submission.status === selectedStatus) && includesQuery(member?.name, member?.team, course?.name, course?.requestDepartment);
  }).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  $('#reviewTableBody').innerHTML = rows.map(submission => {
    const member = data.members.find(item => item.id === submission.memberId);
    return `<tr><td><strong>${e(member?.name || '이름 미상')}</strong><span class="subline">${e([member?.team, member?.position].filter(Boolean).join(' · ') || '팀·직급 미등록')}</span></td><td class="course-title"><strong>${e(courseName(submission.courseId))}</strong><span class="subline">수료일 ${formatDate(submission.completedOn)}</span></td><td>${formatTime(submission.submittedAt)}</td><td>${submission.files.length}개</td><td>${statusBadge(submission.status)}</td><td><button type="button" class="button secondary" data-review="${e(submission.id)}">${submission.status === 'pending' ? '검토하기' : '내역 보기'}</button></td></tr>`;
  }).join('');
  $('#reviewEmpty').hidden = rows.length > 0;
}
function renderCourses() {
  const visibility = $('#courseVisibilityFilter').value;
  const rows = periodCourses().filter(course => {
    if (visibility === 'active' && course.archived) return false;
    if (visibility === 'published' && (!course.published || course.archived)) return false;
    if (visibility === 'draft' && (course.published || course.archived)) return false;
    if (visibility === 'archived' && !course.archived) return false;
    return includesQuery(course.name, course.site, course.requestDepartment);
  });
  $('#courseTableBody').innerHTML = rows.map(course => {
    const targets = data.members.filter(member => member.active && !['exempt', 'not_target'].includes(getStatus(course, member, data.submissions, data.overrides)));
    const approved = targets.filter(member => getStatus(course, member, data.submissions, data.overrides) === 'approved').length;
    return `<tr><td class="course-title"><strong>${e(course.name)} ${isNewCourse(course) ? '<span class="badge info">NEW</span>' : ''}</strong><span class="subline">${e(course.requestDepartment || '요청부서 미등록')} · ${e(course.site || '사이트명 미등록')}</span></td><td>${e(periodLabel(course))}</td><td>${formatDate(course.deadline)}<span class="subline">제출 ${formatDate(course.submissionDeadline)}</span></td><td>${visibilityBadge(course)}</td><td>${approved} / ${targets.length}명</td><td><div class="actions-cell"><button type="button" class="button secondary" data-course-edit="${e(course.id)}">수정</button><button type="button" class="button ghost" data-course-copy="${e(course.id)}">복제</button><button type="button" class="button ghost" data-course-download="${e(course.id)}">ZIP</button></div></td></tr>`;
  }).join('');
  $('#courseEmpty').hidden = rows.length > 0;
}
function renderMembers() {
  const active = $('#memberActiveFilter').value;
  const rows = data.members.filter(member => (active === 'all' || member.active === (active === 'active')) && includesQuery(member.name, member.team, member.position));
  $('#memberTableBody').innerHTML = rows.map(member => `<tr><td><strong>${e(member.name)}</strong></td><td>${e(member.team || '—')}</td><td>${e(member.position || '—')}</td><td>${formatDate(member.joinedOn)}<span class="subline">전출 ${formatDate(member.leftOn)}</span></td><td><span class="badge ${member.active ? 'success' : 'muted'}">${member.active ? '재직' : '전출·비활성'}</span></td><td><button type="button" class="button secondary" data-member-edit="${e(member.id)}">수정</button></td></tr>`).join('');
  $('#memberEmpty').hidden = rows.length > 0;
  $('#editMemberOrderButton').disabled = data.members.filter(member => member.active).length < 2;
}

function resetMemberOrderDraft() {
  memberOrderDraft = data.members.filter(member => member.active).map(member => member.id);
  memberOrderVersion = data.memberOrder?.version || 0;
}
function renderMemberOrder() {
  const members = new Map(data.members.map(member => [member.id, member]));
  $('#memberOrderCount').textContent = `재직 부서원 ${memberOrderDraft.length}명`;
  memberOrderRendering = true;
  try { $('#memberOrderList').innerHTML = memberOrderDraft.map((id, index) => {
    const member = members.get(id);
    return `<li class="member-order-row" data-order-member="${e(id)}" draggable="${!memberOrderBusy}" tabindex="-1"><label class="member-order-number"><span>순서</span><input type="number" inputmode="numeric" min="1" max="${memberOrderDraft.length}" step="1" required value="${index + 1}" data-order-position="${e(id)}" aria-label="${e(member.name)} 순서 번호" ${memberOrderBusy ? 'disabled' : ''}></label><div class="member-order-name"><strong>${e(member.name)}</strong><small>${e([member.team, member.position].filter(Boolean).join(' · '))}</small></div></li>`;
  }).join(''); } finally { memberOrderRendering = false; }
  $('#saveMemberOrderButton').disabled = memberOrderBusy || memberOrderDraft.length < 2;
  $('#reloadMemberOrderButton').disabled = memberOrderBusy;
  for (const button of $$('[data-close="memberOrderDialog"]')) button.disabled = memberOrderBusy;
}
function openMemberOrder() {
  if (loading) { showToast('최신 명단을 불러오는 중입니다. 잠시 후 다시 선택해 주세요.', 'info'); return; }
  resetMemberOrderDraft(); memberOrderDraggingId = null;
  setError($('#memberOrderError'), ''); $('#memberOrderAnnouncement').textContent = '';
  renderMemberOrder(); openDialog($('#memberOrderDialog'));
}
function moveMemberOrder(id, destination, focusId) {
  if (memberOrderBusy) return;
  const source = memberOrderDraft.indexOf(id);
  if (source < 0 || destination < 0 || destination >= memberOrderDraft.length || source === destination) return;
  memberOrderDraft.splice(source, 1); memberOrderDraft.splice(destination, 0, id);
  renderMemberOrder();
  const member = data.members.find(item => item.id === id);
  $('#memberOrderAnnouncement').textContent = `${member.name} 님을 ${destination + 1}번째로 옮겼습니다.`;
  if (focusId === null) return;
  const row = $$('#memberOrderList [data-order-member]').find(item => item.dataset.orderMember === (focusId || id));
  const input = focusId ? $('[data-order-position]', row) : null;
  (input || row)?.focus();
  input?.select();
}
function applyMemberOrderPositions(focusId = null, report = false) {
  if (memberOrderBusy || memberOrderRendering) return false;
  const inputs = $$('#memberOrderList [data-order-position]');
  const invalid = inputs.find(input => !input.validity.valid || !Number.isInteger(input.valueAsNumber));
  if (invalid) {
    setError($('#memberOrderError'), `순서 번호는 1부터 ${memberOrderDraft.length} 사이의 정수로 입력해 주세요.`);
    if (report) { invalid.focus(); invalid.reportValidity(); }
    return false;
  }
  setError($('#memberOrderError'), '');
  // Read pending values before moving rows, since each move replaces the inputs.
  const changes = inputs.map(input => ({id:input.dataset.orderPosition, destination:input.valueAsNumber - 1}))
    .filter(change => memberOrderDraft.indexOf(change.id) !== change.destination);
  for (const change of changes) moveMemberOrder(change.id, change.destination, null);
  // Let the browser finish focusing the clicked (now replaced) input first.
  if (changes.length && focusId) setTimeout(() => {
    if (!$('#memberOrderDialog').open || memberOrderBusy) return;
    const input = $$('#memberOrderList [data-order-position]').find(item => item.dataset.orderPosition === focusId);
    input?.focus(); input?.select();
  }, 0);
  return true;
}
async function reloadMemberOrder() {
  if (memberOrderBusy || loading) return;
  memberOrderBusy = true; renderMemberOrder(); setError($('#memberOrderError'), '');
  try {
    await loadData(); resetMemberOrderDraft();
    $('#memberOrderAnnouncement').textContent = '저장된 최신 순서와 명단을 불러왔습니다.';
  } catch (error) { setError($('#memberOrderError'), error.message); }
  finally { memberOrderBusy = false; renderMemberOrder(); }
}
async function saveMemberOrder(event) {
  event.preventDefault(); if (memberOrderBusy) return;
  if (!applyMemberOrderPositions(null, true)) return;
  memberOrderBusy = true; renderMemberOrder(); setError($('#memberOrderError'), '');
  busy($('#saveMemberOrderButton'), true, '순서를 저장하고 있습니다…');
  try {
    await api('/admin/member-order', {method:'PUT', body:{memberIds:[...memberOrderDraft],version:memberOrderVersion}});
    closeDialog($('#memberOrderDialog')); showToast('이름 표시 순서를 저장했습니다. 교육 안내 페이지를 새로고침하면 반영됩니다.');
    try { await loadData(); } catch { showToast('순서는 저장됐습니다. 최신 명단을 보려면 새로고침해 주세요.', 'info'); }
  } catch (error) {
    setError($('#memberOrderError'), error.status === 409 ? `${error.message} ‘최신 순서 불러오기’를 누른 뒤 다시 편집해 주세요.` : error.message);
  } finally { memberOrderBusy = false; busy($('#saveMemberOrderButton'), false); renderMemberOrder(); }
}
function statusRows() {
  return {courses: publishedCourses(), members: data.members.filter(member => member.active && includesQuery(member.name, member.team, member.position))};
}
function renderStatus() {
  const {courses, members} = statusRows();
  $('#statusTableHead').innerHTML = `<tr><th>부서원</th>${courses.map(course => `<th class="course-head">${e(course.name)}</th>`).join('')}<th>이수율</th></tr>`;
  $('#statusTableBody').innerHTML = members.map(member => {
    const progress = getProgress(courses, member, data.submissions, data.overrides);
    return `<tr><td><strong>${e(member.name)}</strong><span class="subline">${e(member.team || member.position || '')}</span></td>${courses.map(course => {
      const status = getStatus(course, member, data.submissions, data.overrides);
      return `<td><button type="button" class="cell-button" data-record-member="${e(member.id)}" data-record-course="${e(course.id)}" aria-label="${e(`${member.name} ${course.name} ${statusLabel(status)} 기록 보기`)}">${statusBadge(status)}</button></td>`;
    }).join('')}<td class="status-summary"><strong>${progress.percent}%</strong><span class="subline">${progress.approved} / ${progress.total}개</span><div class="mini-progress"><span style="width:${Math.min(100, Math.max(0, progress.percent))}%"></span></div></td></tr>`;
  }).join('');
  $('#statusEmpty').hidden = courses.length > 0 && members.length > 0;
  $('#exportExcelButton').disabled = !courses.length || !members.length;
}
function render() { renderStats(); renderReview(); renderCourses(); renderMembers(); renderStatus(); }
function switchTab(tab, focus = false) {
  currentTab = tab;
  $$('[data-tab]').forEach(button => {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  });
  ['review', 'courses', 'members', 'status'].forEach(name => { $(`#view-${name}`).hidden = name !== tab; });
}

function checkboxes(name, selected = []) {
  const chosen = new Set(selected);
  return data.members.map(member => `<label class="check-label"><input type="checkbox" name="${name}" value="${e(member.id)}" ${chosen.has(member.id) ? 'checked' : ''}><span>${e(member.name)} <small>${e(member.team || member.position || '')}${member.active ? '' : ' · 전출'}</small></span></label>`).join('');
}
function updateCoursePeriod(value) {
  const type = $('#coursePeriodType').value;
  $('#coursePeriodValueField').hidden = type === 'year';
  const count = type === 'quarter' ? 4 : 12;
  $('#coursePeriodValue').innerHTML = Array.from({length: count}, (_, i) => `<option value="${i + 1}">${i + 1}${type === 'quarter' ? '분기' : '월'}</option>`).join('');
  $('#coursePeriodValue').value = String(value || (type === 'quarter' ? Math.ceil((new Date().getMonth() + 1) / 3) : new Date().getMonth() + 1));
}
function openCourse(id = null, copy = false) {
  const source = data.courses.find(course => course.id === id);
  editingCourse = copy ? null : source || null;
  const course = source ? {...source} : {
    name: '', site: '', url: '', requestDepartment: '', year: Number($('#yearFilter').value), periodType: 'year', periodValue: 0,
    deadline: '', submissionDeadline: '', details: [], requirement: 'all', requirementNote: '', description: '',
    targetMode: 'all', targetMemberIds: [], exemptMemberIds: [], published: false, archived: false,
  };
  if (copy) { course.name = `${course.name} (복사)`; course.published = false; course.archived = false; }
  $('#courseForm').reset();
  $('#courseDialogTitle').textContent = copy ? '교육 복제' : editingCourse ? '교육 수정' : '새 교육 등록';
  for (const name of ['name', 'site', 'url', 'requestDepartment', 'year', 'periodType', 'deadline', 'submissionDeadline', 'requirement', 'requirementNote', 'description', 'targetMode']) $('#courseForm').elements.namedItem(name).value = course[name] ?? '';
  $('#courseDetails').value = (course.details || []).join('\n');
  $('#coursePublished').checked = Boolean(course.published); $('#courseArchived').checked = Boolean(course.archived);
  $('#targetMemberChecks').innerHTML = checkboxes('targetMemberIds', course.targetMemberIds);
  $('#exemptMemberChecks').innerHTML = checkboxes('exemptMemberIds', course.exemptMemberIds);
  $('#targetMembersField').hidden = course.targetMode !== 'selected';
  updateCoursePeriod(course.periodValue); setError($('#courseError'), ''); openDialog($('#courseDialog'));
}
async function saveCourse(event) {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  const course = {
    name: fields.get('name').trim(), site: fields.get('site').trim(), url: fields.get('url').trim(), requestDepartment: fields.get('requestDepartment').trim(),
    year: Number(fields.get('year')), periodType: fields.get('periodType'), periodValue: fields.get('periodType') === 'year' ? 0 : Number(fields.get('periodValue')),
    deadline: fields.get('deadline'), submissionDeadline: fields.get('submissionDeadline'),
    details: fields.get('details').split(/\r?\n/).map(value => value.trim()).filter(Boolean),
    requirement: fields.get('requirement'), requirementNote: fields.get('requirementNote').trim(), description: fields.get('description').trim(),
    published: fields.has('published'), archived: fields.has('archived'), targetMode: fields.get('targetMode'),
    targetMemberIds: fields.getAll('targetMemberIds'), exemptMemberIds: fields.getAll('exemptMemberIds'),
  };
  setError($('#courseError'), '');
  if (course.targetMode === 'selected' && !course.targetMemberIds.length) { setError($('#courseError'), '교육 대상 부서원을 한 명 이상 선택해 주세요.'); return; }
  if (course.requirement === 'custom' && !course.requirementNote) { setError($('#courseError'), '별도 이수 조건을 입력해 주세요.'); return; }
  if (!/^https?:\/\//i.test(course.url)) { setError($('#courseError'), '수강 링크는 http:// 또는 https://로 시작해야 합니다.'); return; }
  busy($('#saveCourseButton'), true, '교육을 저장하고 있습니다…');
  try {
    await api(editingCourse ? `/admin/courses/${encodeURIComponent(editingCourse.id)}` : '/admin/courses', {method: editingCourse ? 'PUT' : 'POST', body: {...course, ...(editingCourse ? {version: editingCourse.version} : {})}});
    closeDialog($('#courseDialog')); await loadData();
    showToast(course.archived ? '교육을 보관했습니다.' : course.published ? '교육을 저장하고 공개했습니다.' : '교육을 임시저장했습니다.');
  } catch (error) { setError($('#courseError'), error.message); }
  finally { busy($('#saveCourseButton'), false); }
}
function openMember(id = null) {
  editingMember = data.members.find(member => member.id === id) || null;
  const member = editingMember || {name: '', team: '', position: '', active: true, joinedOn: '', leftOn: '', note: ''};
  $('#memberForm').reset(); $('#memberDialogTitle').textContent = editingMember ? '부서원 정보 수정' : '새 부서원 등록';
  for (const name of ['name', 'team', 'position', 'joinedOn', 'leftOn', 'note']) $('#memberForm').elements.namedItem(name).value = member[name] || '';
  $('#memberActive').value = String(member.active); setError($('#memberError'), ''); openDialog($('#memberDialog'));
  $('#memberHistoryField').hidden = !editingMember;
  if (editingMember) void loadMemberHistory(member);
}
function memberHistoryMarkup(member, history) {
  const fields = [
    ['name', '이름'], ['team', '팀'], ['position', '직급'],
    ['active', '재직 상태'], ['joinedOn', '전입일'], ['leftOn', '전출일'],
  ];
  const valueLabel = (key, value) => key === 'active'
    ? value === true ? '재직' : value === false ? '전출·비활성' : '미등록'
    : ['joinedOn', 'leftOn'].includes(key) ? formatDate(value) : value || '미등록';
  const entries = history.filter(entry => entry.action === 'member_updated').map(entry => {
    const {before = {}, after = {}} = entry.detail || {};
    const changes = fields.filter(([key]) => before[key] !== after[key]).map(([key, label]) =>
      `${e(label)}: ${e(valueLabel(key, before[key]))} → ${e(valueLabel(key, after[key]))}`);
    return changes.length ? `<li><strong>${e(formatTime(entry.createdAt))}</strong><p>${changes.join('<br>')}</p></li>` : '';
  }).filter(Boolean);
  return `<p class="form-help">등록 시각: ${e(formatTime(member.createdAt))}</p>${entries.length
    ? `<ul class="history-list">${entries.join('')}</ul>`
    : '<p class="muted">등록 후 인사 정보 변경 이력이 없습니다.</p>'}`;
}
async function loadMemberHistory(member) {
  const container = $('#memberHistoryContent');
  container.innerHTML = '<p class="muted" role="status">인사 변경 이력을 불러오고 있습니다.</p>';
  try {
    const result = await api(`/admin/members/${encodeURIComponent(member.id)}/history`);
    if (!Array.isArray(result.history)) throw new Error('인사 변경 이력 응답을 확인할 수 없습니다.');
    if (editingMember?.id !== member.id || !$('#memberDialog').open) return;
    container.innerHTML = memberHistoryMarkup(member, result.history);
  } catch (error) {
    if (editingMember?.id !== member.id || !$('#memberDialog').open) return;
    container.innerHTML = `<p class="field-error" role="alert">인사 변경 이력을 불러오지 못했습니다. ${e(error.message)}</p>`;
  }
}
async function saveMember(event) {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  const member = Object.fromEntries(['name', 'team', 'position', 'joinedOn', 'leftOn', 'note'].map(name => [name, fields.get(name).trim()]));
  member.active = fields.get('active') === 'true'; setError($('#memberError'), '');
  if (member.joinedOn && member.leftOn && member.leftOn < member.joinedOn) { setError($('#memberError'), '전출일은 전입일 이후로 입력해 주세요.'); return; }
  if (editingMember && member.name !== editingMember.name && !confirm('이름을 변경합니다. 같은 부서원의 개명·오타 수정이 맞습니까?\n전입자는 새 부서원으로 등록해야 합니다.')) return;
  busy($('#saveMemberButton'), true, '부서원을 저장하고 있습니다…');
  try {
    await api(editingMember ? `/admin/members/${encodeURIComponent(editingMember.id)}` : '/admin/members', {method: editingMember ? 'PUT' : 'POST', body: {...member, ...(editingMember ? {version: editingMember.version} : {})}});
    closeDialog($('#memberDialog')); await loadData(); showToast(editingMember ? '부서원 정보를 수정했습니다.' : '새 부서원을 등록했습니다.');
  } catch (error) { setError($('#memberError'), error.message); }
  finally { busy($('#saveMemberButton'), false); }
}

function submissionHistory(memberId, courseId, selectedId = null) {
  const history = data.submissions.filter(submission => submission.memberId === memberId && submission.courseId === courseId).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  if (!history.length) return '<p class="muted">제출 이력이 없습니다.</p>';
  return `<ul class="history-list">${history.map(submission => `<li><button type="button" data-review="${e(submission.id)}">${formatTime(submission.submittedAt)} · 첨부 ${submission.files.length}개${submission.id === selectedId ? ' · 현재 보는 제출' : ''}</button> ${statusBadge(submission.status)}${submission.reviewNote ? `<p>검토: ${e(submission.reviewNote)}</p>` : ''}</li>`).join('')}</ul>`;
}
function openReview(id) {
  const submission = data.submissions.find(item => item.id === id);
  if (!submission) return;
  reviewSubmissionId = id;
  const member = data.members.find(item => item.id === submission.memberId);
  const course = data.courses.find(item => item.id === submission.courseId);
  const latest = getLatestSubmission(data.submissions, submission.memberId, submission.courseId)?.id === id;
  $('#reviewDialogTitle').textContent = `${member?.name || '이름 미상'} · 수료증 검토`;
  $('#reviewDialogBody').innerHTML = `
    <div class="review-meta">${statusBadge(submission.status)}<span>${e(course?.name || '교육 미상')}</span><span>접수 ${formatTime(submission.submittedAt)}</span></div>
    ${!latest ? '<p class="soft-note">이전 제출본입니다. 최신 제출본에서 검토 결과를 변경할 수 있습니다.</p>' : ''}
    <div class="review-grid"><div>
      <div class="file-tabs">${submission.files.map((file, index) => `<button type="button" class="file-tab ${index ? '' : 'active'}" data-preview-file="${e(file.id)}" title="${e(file.name)}">${e(file.name)} · ${formatBytes(file.size)}</button>`).join('')}</div>
      <div id="filePreview" class="file-preview"><div class="empty-state">첨부 파일이 없습니다.</div></div>
      <div id="fileDownloadActions" class="file-download"></div><p class="preview-note">미리보기가 표시되지 않으면 파일을 내려받아 확인하세요. DRM 파일은 제출자에게 기관에서 허용하는 절차로 보안 해제 후 재제출하도록 요청할 수 있습니다.</p>
    </div><div class="review-sidebar">
      <h3>제출 내용</h3><div class="review-comment">수료일: ${formatDate(submission.completedOn)}\n${e(submission.comment || '추가 메모가 없습니다.')}</div>
      ${latest ? `<form id="reviewForm"><div class="field"><label for="reviewDecision">검토 결과</label><select id="reviewDecision" name="status"><option value="approved">승인 · 이수 완료</option><option value="needs_revision" ${submission.status === 'needs_revision' ? 'selected' : ''}>보완 요청</option></select></div><div class="field"><label for="reviewNote">검토 메모 / 보완 사유</label><textarea id="reviewNote" name="reviewNote" rows="4" maxlength="2000" placeholder="보완 요청 시 필요한 내용을 입력하세요.">${e(submission.reviewNote || '')}</textarea></div><p id="reviewError" class="field-error" role="alert" hidden></p><button id="saveReviewButton" class="button primary" type="submit" style="width:100%;margin-top:10px">검토 결과 저장</button></form>` : ''}
      <h3 style="margin-top:24px">제출·재제출 이력</h3>${submissionHistory(submission.memberId, submission.courseId, submission.id)}
    </div></div>`;
  if (latest) $('#reviewForm').addEventListener('submit', saveReview);
  if (!$('#reviewDialog').open) openDialog($('#reviewDialog'));
  if (submission.files.length) previewFile(submission.files[0].id);
}
function filePath(fileId) { return `/api/files/${encodeURIComponent(fileId)}`; }
function releasePreview() {
  previewController?.abort(); previewController = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
}
async function previewFile(id) {
  const submission = data.submissions.find(item => item.id === reviewSubmissionId);
  const file = submission?.files.find(item => item.id === id);
  if (!file) return;
  releasePreview();
  const controller = new AbortController(); previewController = controller;
  $$('.file-tab', $('#reviewDialog')).forEach(button => button.classList.toggle('active', button.dataset.previewFile === id));
  const preview = $('#filePreview'); preview.innerHTML = '<div class="empty-state" role="status">수료증 파일을 불러오고 있습니다.</div>';
  $('#fileDownloadActions').innerHTML = `<button type="button" class="button secondary" data-file-download="${e(id)}">파일 내려받기</button>`;
  try {
    const response = await fetchStoredFile(filePath(id), {signal: controller.signal, onRetry: () => {
      if (previewController === controller && $('#reviewDialog').open) preview.innerHTML = '<div class="empty-state" role="status">파일을 저장소에 반영 중입니다. 잠시 후 다시 확인합니다.</div>';
    }});
    const blob = await response.blob();
    if (previewController !== controller || !$('#reviewDialog').open) return;
    previewUrl = URL.createObjectURL(blob); preview.replaceChildren();
    if (file.type === 'application/pdf') {
      const frame = document.createElement('iframe'); frame.title = `수료증 미리보기: ${file.name}`; frame.src = previewUrl; preview.append(frame);
    } else if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      const image = document.createElement('img'); image.alt = `수료증: ${file.name}`;
      image.addEventListener('error', () => { preview.innerHTML = '<div class="empty-state" role="alert">미리보기를 불러오지 못했습니다. 파일을 내려받아 확인해 주세요.</div>'; });
      image.src = previewUrl; preview.append(image);
    } else preview.innerHTML = '<div class="empty-state">이 파일은 내려받아 확인해 주세요.</div>';
  } catch (error) {
    if (error.name !== 'AbortError' && previewController === controller) preview.innerHTML = `<div class="empty-state" role="alert">${e(error.message)} 파일을 내려받아 확인해 주세요.</div>`;
  } finally { if (previewController === controller) previewController = null; }
}
$('#reviewDialog').addEventListener('close', () => { releasePreview(); $('#filePreview')?.replaceChildren(); });
async function saveReview(event) {
  event.preventDefault();
  const submission = data.submissions.find(item => item.id === reviewSubmissionId);
  if (!submission) return;
  const fields = new FormData(event.currentTarget);
  const status = fields.get('status'), reviewNote = fields.get('reviewNote').trim();
  setError($('#reviewError'), '');
  if (status === 'needs_revision' && !reviewNote) { setError($('#reviewError'), '부서원이 확인할 보완 사유를 입력해 주세요.'); return; }
  busy($('#saveReviewButton'), true, '검토 결과를 저장하고 있습니다…');
  try {
    await api(`/admin/submissions/${encodeURIComponent(submission.id)}/review`, {method: 'POST', body: {status, reviewNote, version: submission.version}});
    closeDialog($('#reviewDialog')); await loadData(); showToast(status === 'approved' ? '수료증을 승인하고 이수 현황에 반영했습니다.' : '보완 요청을 저장했습니다.');
  } catch (error) { setError($('#reviewError'), error.message); }
  finally { const button = $('#saveReviewButton'); if (button) busy(button, false); }
}
function openRecord(memberId, courseId) {
  const member = data.members.find(item => item.id === memberId), course = data.courses.find(item => item.id === courseId);
  if (!member || !course) return;
  const override = data.overrides.find(item => item.memberId === memberId && item.courseId === courseId);
  const status = getStatus(course, member, data.submissions, data.overrides), latest = getLatestSubmission(data.submissions, memberId, courseId);
  const legacy = member.legacyCompletions?.includes(courseId);
  $('#recordDialogTitle').textContent = `${member.name} · 이수 기록`;
  $('#recordDialogBody').innerHTML = `<p style="margin-top:0"><strong>${e(course.name)}</strong></p><div class="review-meta">${statusBadge(status)}<span>${e(member.team || member.position || '')}</span></div>
    ${legacy ? '<p class="soft-note">이전 대시보드에서 확인한 이수 기록이 보존되어 있습니다. 수료증 첨부는 없는 기존 기록입니다.</p>' : ''}
    ${override ? `<p class="soft-note">담당자 수동 처리: ${e(statusLabel(override.status))}<br>사유: ${e(override.reason)}<br>${formatTime(override.updatedAt)}</p>` : ''}
    ${latest ? `<button type="button" class="button secondary" data-review="${e(latest.id)}">최신 수료증 ${latest.files.length}개 확인</button>` : '<p class="muted">첨부된 수료증이 없습니다.</p>'}
    <details style="margin-top:22px"><summary><strong>담당자 수동 처리</strong></summary><p class="form-help">별도로 확인한 이수 내역이나 예외를 사유와 함께 기록합니다. 수료증을 새로 제출하거나 검토하면 해당 제출 결과가 반영됩니다.</p>
      <form id="overrideForm" class="stack" style="margin-top:14px"><div class="field"><label for="overrideStatus">처리 구분</label><select id="overrideStatus" name="status"><option value="approved">이수 완료로 처리</option><option value="not_submitted">미제출 상태로 처리</option><option value="exempt">이 교육 면제</option>${override ? '<option value="clear">수동 처리 해제 · 원래 기록 적용</option>' : ''}</select></div><div class="field"><label for="overrideReason">처리 사유 *</label><textarea id="overrideReason" name="reason" rows="3" required maxlength="2000" placeholder="확인 경위나 예외 사유를 기록하세요."></textarea></div><p id="overrideError" class="field-error" role="alert" hidden></p><button id="saveOverrideButton" type="submit" class="button primary">수동 처리 저장</button></form>
    </details><h3 style="font-size:14px;margin-top:25px">제출 이력</h3>${submissionHistory(memberId, courseId)}`;
  if (override) $('#overrideStatus').value = override.status;
  $('#overrideForm').addEventListener('submit', async event => {
    event.preventDefault(); const fields = new FormData(event.currentTarget), reason = fields.get('reason').trim();
    if (!reason) { setError($('#overrideError'), '처리 사유를 입력해 주세요.'); return; }
    busy($('#saveOverrideButton'), true, '저장하고 있습니다…');
    try {
      await api(`/admin/overrides/${encodeURIComponent(memberId)}/${encodeURIComponent(courseId)}`, {method: 'PUT', body: {status: fields.get('status'), reason, version: override?.version || 0}});
      closeDialog($('#recordDialog')); await loadData(); showToast('수동 처리 내역을 저장했습니다.');
    } catch (error) { setError($('#overrideError'), error.message); }
    finally { const button = $('#saveOverrideButton'); if (button) busy(button, false); }
  });
  openDialog($('#recordDialog'));
}
function openDownload(id) { downloadCourseId = id; $('#downloadCourseName').textContent = courseName(id); $('#downloadForm').reset(); setError($('#downloadError'), ''); openDialog($('#downloadDialog')); }
async function downloadZip(event) {
  event.preventDefault(); if (!downloadCourseId) return;
  const scope = new FormData(event.currentTarget).get('downloadScope'); setError($('#downloadError'), ''); busy($('#downloadZipButton'), true, '수료증을 묶고 있습니다…');
  try {
    await downloadFile(`/admin/courses/${encodeURIComponent(downloadCourseId)}/download?scope=${scope}`, `${courseName(downloadCourseId)}_수료증.zip`);
    closeDialog($('#downloadDialog')); showToast('수료증 ZIP 내려받기를 시작했습니다.');
  } catch (error) { setError($('#downloadError'), error.message); }
  finally { busy($('#downloadZipButton'), false); }
}
async function exportExcel() {
  const {courses, members} = statusRows();
  const rows = [['부서원', '팀', '직급', ...courses.map(course => course.name), '승인 교육 수', '대상 교육 수', '이수율'], ...members.map(member => {
    const progress = getProgress(courses, member, data.submissions, data.overrides);
    return [member.name, member.team || '', member.position || '', ...courses.map(course => statusLabel(getStatus(course, member, data.submissions, data.overrides))), progress.approved, progress.total, `${progress.percent}%`];
  })];
  busy($('#exportExcelButton'), true, '엑셀을 만들고 있습니다…');
  try { await downloadXlsx(rows, `${$('#yearFilter').value}년_교육이수현황.xlsx`); showToast('엑셀 현황을 내려받았습니다.'); }
  catch (error) { showToast(error.message, 'error'); }
  finally { busy($('#exportExcelButton'), false); }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); setError($('#loginError'), ''); busy($('#loginButton'), true, '로그인 중…');
  try { await api('/admin/login', {method: 'POST', body: {password: $('#passwordInput').value}}); $('#passwordInput').value = ''; await enterDashboard(); }
  catch (error) { setError($('#loginError'), error.message); }
  finally { busy($('#loginButton'), false); }
});
$('#logoutButton').addEventListener('click', async () => {
  try { await api('/admin/logout', {method: 'POST'}); $$('dialog[open]').forEach(closeDialog); data = {courses: [], members: [], submissions: [], overrides: [], audit: []}; showLogin(); }
  catch (error) { showToast(error.message, 'error'); }
});
$('#refreshButton').addEventListener('click', () => { void loadData({toast: true}).catch(() => {}); });
for (const id of ['yearFilter', 'periodFilter', 'reviewStatusFilter', 'courseVisibilityFilter', 'memberActiveFilter']) $(`#${id}`).addEventListener('change', render);
$('#adminSearch').addEventListener('input', render);
$('#newCourseButton').addEventListener('click', () => openCourse());
$('#newMemberButton').addEventListener('click', () => openMember());
$('#editMemberOrderButton').addEventListener('click', openMemberOrder);
$('#reloadMemberOrderButton').addEventListener('click', reloadMemberOrder);
$('#memberOrderForm').addEventListener('submit', saveMemberOrder);
$('#memberOrderDialog').addEventListener('cancel', event => { if (memberOrderBusy) event.preventDefault(); });
$('#memberOrderList').addEventListener('keydown', event => {
  const input = event.target.closest('[data-order-position]');
  if (!input || event.key !== 'Enter') return;
  event.preventDefault(); applyMemberOrderPositions(input.dataset.orderPosition, true);
});
$('#memberOrderList').addEventListener('focusout', event => {
  if (!event.target.matches('[data-order-position]') || !event.target.isConnected || memberOrderBusy || memberOrderRendering) return;
  if (event.relatedTarget?.closest('[data-close="memberOrderDialog"], #reloadMemberOrderButton')) return;
  applyMemberOrderPositions(event.relatedTarget?.dataset.orderPosition || null);
});
$('#memberOrderList').addEventListener('dragstart', event => {
  const row = event.target.closest('[data-order-member]');
  if (memberOrderBusy || event.target.closest('input, button') || !row || !memberOrderDraft.includes(row.dataset.orderMember)) { event.preventDefault(); return; }
  if (!$('#memberOrderForm').checkValidity()) { event.preventDefault(); return; }
  memberOrderDraggingId = row.dataset.orderMember;
  event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', memberOrderDraggingId);
});
$('#memberOrderList').addEventListener('dragover', event => {
  event.preventDefault(); if (memberOrderBusy || !memberOrderDraggingId) return;
  event.dataTransfer.dropEffect = 'move';
  const row = event.target.closest('[data-order-member]');
  $$('#memberOrderList .is-drag-target').forEach(item => item.classList.remove('is-drag-target'));
  if (row && row.dataset.orderMember !== memberOrderDraggingId) row.classList.add('is-drag-target');
});
$('#memberOrderList').addEventListener('drop', event => {
  event.preventDefault(); if (memberOrderBusy || !memberOrderDraggingId) return;
  const row = event.target.closest('[data-order-member]');
  if (row) moveMemberOrder(memberOrderDraggingId, memberOrderDraft.indexOf(row.dataset.orderMember));
  memberOrderDraggingId = null;
});
$('#memberOrderList').addEventListener('dragend', () => {
  memberOrderDraggingId = null;
  $$('#memberOrderList .is-drag-target').forEach(item => item.classList.remove('is-drag-target'));
});
$('#courseForm').addEventListener('submit', saveCourse);
$('#memberForm').addEventListener('submit', saveMember);
$('#downloadForm').addEventListener('submit', downloadZip);
$('#exportExcelButton').addEventListener('click', exportExcel);
$('#coursePeriodType').addEventListener('change', () => updateCoursePeriod());
$('#courseTargetMode').addEventListener('change', () => { $('#targetMembersField').hidden = $('#courseTargetMode').value !== 'selected'; });
$('#courseDeadline').addEventListener('change', () => { if (!$('#courseSubmissionDeadline').value) $('#courseSubmissionDeadline').value = $('#courseDeadline').value; });

document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.tab) switchTab(button.dataset.tab);
  if (button.dataset.close) closeDialog($(`#${button.dataset.close}`));
  if (button.dataset.courseEdit) openCourse(button.dataset.courseEdit);
  if (button.dataset.courseCopy) openCourse(button.dataset.courseCopy, true);
  if (button.dataset.courseDownload) openDownload(button.dataset.courseDownload);
  if (button.dataset.memberEdit) openMember(button.dataset.memberEdit);
  if (button.dataset.recordMember) openRecord(button.dataset.recordMember, button.dataset.recordCourse);
  if (button.dataset.review) { if ($('#recordDialog').open) closeDialog($('#recordDialog')); openReview(button.dataset.review); }
  if (button.dataset.previewFile) previewFile(button.dataset.previewFile);
  if (button.dataset.fileDownload) {
    const file = data.submissions.find(item => item.id === reviewSubmissionId)?.files.find(item => item.id === button.dataset.fileDownload);
    if (file) { busy(button, true, '내려받는 중…'); try { await downloadFile(`/files/${encodeURIComponent(file.id)}?download=1`, file.name); } catch (error) { showToast(error.message, 'error'); } finally { busy(button, false); } }
  }
});
$('.admin-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const tabs = ['review', 'courses', 'members', 'status'], current = tabs.indexOf(currentTab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  switchTab(tabs[next], true);
});
async function boot() {
  try { const session = await api('/admin/session'); if (session.authenticated) await enterDashboard(); }
  catch (error) { setError($('#loginError'), `서버에 연결하지 못했습니다. ${error.message}`); }
}
void boot();

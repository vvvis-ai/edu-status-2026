import {
  api, escapeHtml as esc, formatDate, formatTime, formatBytes, showToast,
  openDialog, closeDialog, statusBadge, fetchStoredFile,
} from './edu-client.mjs';
import {
  getLatestSubmission, getStatus, getProgress, matchesPeriod, isNewCourse,
  MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_FILES, FILE_ACCEPT,
} from './edu-shared.mjs';
import {departmentMarkup} from './edu-department.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  bootstrap: null, me: null, year: '', quarter: '', month: '', status: '', search: '',
  uploadCourse: null, files: [], saving: false, loading: false, localPreviews: new Map(), savedPreviewUrl: '', previewController: null,
};
const allowedExtensions = /\.(pdf|jpe?g|png|webp)$/i;
const typeLabels = { all: '아래 과목 모두 이수', one: '아래 과목 중 하나 이수', custom: '아래 이수 조건을 확인하세요' };

function showPage(view) {
  for (const id of ['loadingState', 'errorState', 'memberSelection', 'personalDashboard']) $(id).hidden = id !== view;
  $('changeMemberButton').hidden = view !== 'personalDashboard';
}

function setHeader() {
  const member = state.me?.member;
  $('pageTitle').textContent = member ? `${member.name} 님의 교육 현황` : '교육 안내 · 수료증 제출';
  $('pageSubtitle').textContent = member
    ? [member.team, member.position].filter(Boolean).join(' · ') || '교육 안내를 확인하고 수료증을 제출하세요.'
    : '나에게 필요한 교육을 확인하고 수료증을 제출하세요.';
}

async function loadPage({ restore = true } = {}) {
  if (state.loading) return;
  state.loading = true;
  $('refreshButton').disabled = true;
  showPage('loadingState');
  try {
    state.bootstrap = await api('/bootstrap');
    if (restore && state.bootstrap.selectedMemberId) {
      try { state.me = await api('/me'); }
      catch (error) {
        if ([401, 403, 404].includes(error.status)) state.me = null;
        else throw error;
      }
    } else state.me = null;
    renderPage();
  } catch (error) {
    $('pageError').textContent = error.message;
    showPage('errorState');
  } finally {
    state.loading = false;
    $('refreshButton').disabled = false;
  }
}

function renderPage() {
  setHeader();
  if (state.me) { configureFilters(); renderPersonal(); showPage('personalDashboard'); }
  else { renderNames(); showPage('memberSelection'); }
  const serverTime = state.me?.serverTime || state.bootstrap?.serverTime;
  $('lastUpdated').textContent = serverTime ? `불러온 시각 ${formatTime(serverTime)}` : '';
}

function renderNames() {
  const members = (state.bootstrap?.members || []).filter((member) => member.active !== false);
  const tree = departmentMarkup(members, state.bootstrap?.departmentChart, {search:state.search});
  $('memberCount').textContent = `총 ${members.length}명`;
  $('memberGrid').innerHTML = tree.html;
  $('memberEmpty').hidden = tree.matchCount > 0;
}

async function selectMember(memberId, button) {
  if (state.loading) return;
  state.loading = true;
  button.disabled = true;
  try {
    await api('/member-session', { method: 'POST', body: { memberId } });
    state.me = await api('/me');
    state.status = ''; state.quarter = ''; state.month = '';
    renderPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) { showToast(error.message, 'error'); }
  finally { state.loading = false; button.disabled = false; }
}

function configureFilters() {
  const years = [...new Set((state.me?.courses || []).map((course) => Number(course.year)))].filter(Number.isFinite).sort((a, b) => b - a);
  if (!state.year || !years.includes(Number(state.year))) {
    const currentYear = new Date().getFullYear();
    state.year = String(years.includes(currentYear) ? currentYear : years[0] || currentYear);
  }
  $('yearFilter').innerHTML = (years.length ? years : [Number(state.year)]).map((year) => `<option value="${year}">${year}년</option>`).join('');
  $('yearFilter').value = state.year;
  $('quarterFilter').value = state.quarter;
  $('monthFilter').value = state.month;
  $('statusFilter').value = state.status;
}

function personalStatus(course) { return getStatus(course, state.me.member, state.me.submissions || [], state.me.overrides || []); }

function deadlineBadge(course) {
  const deadline = course.submissionDeadline || course.deadline;
  if (!deadline) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(`${deadline}T00:00:00`) - today) / 86400000);
  if (!Number.isFinite(days) || course.archived || ['approved', 'exempt'].includes(personalStatus(course))) return '';
  if (days < 0) return '<span class="badge danger">제출기한 경과</span>';
  if (days === 0) return '<span class="badge danger">오늘 제출 마감</span>';
  return days <= 30 ? `<span class="badge warning">제출 D-${days}</span>` : '';
}

function periodLabel(course) {
  if (course.periodType === 'month') return `${course.year}년 ${course.periodValue}월`;
  if (course.periodType === 'quarter') return `${course.year}년 ${course.periodValue}분기`;
  return `${course.year}년 연간`;
}

function safeLink(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}

function renderPersonal() {
  if (!state.me) return;
  const member = state.me.member;
  const periodCourses = (state.me.courses || [])
    .filter((course) => course.published && matchesPeriod(course, state))
    .filter((course) => personalStatus(course) !== 'not_target');
  const progress = getProgress(periodCourses, member, state.me.submissions || [], state.me.overrides || []);
  $('summaryGrid').innerHTML = [
    { label: '대상 교육', value: `${progress.total}개`, cls: '' },
    { label: '이수 완료', value: `${progress.approved}개`, cls: 'success' },
    { label: '확인 중', value: `${progress.pending}개`, cls: 'warning' },
    { label: '보완 요청', value: `${progress.needsRevision}개`, cls: 'danger' },
    { label: '이수율', value: `${progress.percent}%`, cls: '' },
  ].map((item) => `<div class="summary-item ${item.cls}"><span>${item.label}</span><strong>${item.value}</strong></div>`).join('');
  $('completionNotice').hidden = !(progress.total > 0 && progress.approved === progress.total);
  $('completionNotice').textContent = '선택한 기간의 대상 교육을 모두 이수했습니다. 수고하셨습니다!';
  const courses = periodCourses.filter((course) => !state.status || personalStatus(course) === state.status);
  const order = { needs_revision: 0, not_submitted: 1, pending: 2, approved: 3, exempt: 4 };
  courses.sort((a, b) => (order[personalStatus(a)] ?? 9) - (order[personalStatus(b)] ?? 9) || String(a.submissionDeadline || a.deadline || '9999').localeCompare(String(b.submissionDeadline || b.deadline || '9999')) || a.name.localeCompare(b.name, 'ko'));
  $('courseCount').textContent = `${courses.length}개 교육`;
  $('courseList').innerHTML = courses.map(renderCourse).join('');
  $('courseEmpty').hidden = courses.length > 0;
}

function renderCourse(course) {
  const status = personalStatus(course);
  const latest = getLatestSubmission(state.me.submissions || [], state.me.member.id, course.id);
  const link = safeLink(course.url);
  const canSubmit = !course.archived && ['not_submitted', 'pending', 'needs_revision'].includes(status);
  const submitLabel = status === 'needs_revision' ? '보완하여 다시 제출' : status === 'pending' ? '수료증 다시 제출' : '수료증 제출';
  const details = Array.isArray(course.details) ? course.details : [];
  return `<article class="course-card" data-course-id="${esc(course.id)}">
    <div class="course-badges">${statusBadge(status)}<span class="badge muted">${esc(periodLabel(course))}</span>${course.archived ? '<span class="badge muted">보관된 교육</span>' : isNewCourse(course) ? '<span class="badge info">신규 교육</span>' : ''}${deadlineBadge(course)}</div>
    <h3>${esc(course.name)}</h3><div class="muted">${esc(course.site || '교육 사이트 안내를 확인하세요')}${course.requestDepartment ? ` · 요청부서 ${esc(course.requestDepartment)}` : ''}</div>
    <div class="course-meta"><span>수강기한 <strong>${esc(formatDate(course.deadline))}</strong></span><span>제출기한 <strong>${esc(formatDate(course.submissionDeadline || course.deadline))}</strong></span></div>
    ${details.length || course.requirementNote ? `<div class="course-details"><strong>${esc(typeLabels[course.requirement] || typeLabels.custom)}</strong>${details.length ? `<ul>${details.map((detail) => `<li>${esc(detail)}</li>`).join('')}</ul>` : ''}${course.requirementNote ? `<p class="description-text">${esc(course.requirementNote)}</p>` : ''}</div>` : ''}
    ${course.description ? `<p class="description-text">${esc(course.description)}</p>` : ''}
    ${status === 'needs_revision' && latest?.reviewNote ? `<div class="revision-note"><strong>담당자 보완 요청</strong><br>${esc(latest.reviewNote)}</div>` : ''}
    ${status === 'exempt' ? '<p class="notice">이 교육은 면제 처리되어 제출하지 않아도 됩니다.</p>' : ''}
    ${course.archived ? '<p class="notice">보관된 교육입니다. 교육 안내와 제출·검토 이력을 확인할 수 있습니다.</p>' : ''}
    <div class="course-actions">${link ? `<a class="button secondary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">수강하러 가기 ↗</a>` : ''}${canSubmit ? `<button type="button" class="button primary" data-upload-course="${esc(course.id)}">${submitLabel}</button>` : ''}<button type="button" class="button ghost" data-history-course="${esc(course.id)}">제출·검토 이력</button></div>
    ${latest ? `<div class="submission-receipt">최근 접수 ${esc(formatTime(latest.submittedAt))} · 수료일 ${esc(formatDate(latest.completedOn))} · 파일 ${latest.files?.length || 0}개${latest.reviewedAt ? `<br>검토 ${esc(formatTime(latest.reviewedAt))}` : ''}</div>` : status === 'approved' ? '<div class="submission-receipt">담당자가 확인한 기존 이수 내역입니다.</div>' : ''}
  </article>`;
}

function releaseFiles() {
  for (const value of state.localPreviews.values()) URL.revokeObjectURL(value);
  state.localPreviews.clear(); state.files = [];
}

function showUploadError(message) { $('uploadError').textContent = message; $('uploadError').hidden = !message; }

function openUpload(courseId) {
  const course = state.me?.courses.find((item) => item.id === courseId);
  if (!course || course.archived || !['not_submitted', 'pending', 'needs_revision'].includes(personalStatus(course))) return;
  releaseFiles(); state.uploadCourse = course;
  $('uploadForm').reset(); showUploadError(''); $('uploadProgress').hidden = true;
  $('uploadCourseName').textContent = `${state.me.member.name} · ${course.name}`;
  const latest = getLatestSubmission(state.me.submissions || [], state.me.member.id, course.id);
  $('uploadTitle').textContent = latest ? '수료증 다시 제출' : '수료증 제출';
  $('completedOn').value = latest?.completedOn || ''; $('completedOn').max = localToday();
  $('resubmitNotice').hidden = !latest;
  $('resubmitNotice').textContent = latest?.status === 'needs_revision'
    ? `보완 요청: ${latest.reviewNote || '제출 내용을 확인해 주세요.'} 새로 제출할 파일을 모두 선택해 주세요. 이전 제출본은 이력으로 보관됩니다.`
    : '새로 제출할 파일을 모두 선택해 주세요. 새 제출본이 검토 대상이 되며 이전 제출본은 이력으로 보관됩니다.';
  $('certificateFiles').accept = typeof FILE_ACCEPT === 'string' ? FILE_ACCEPT : 'application/pdf,image/jpeg,image/png,image/webp';
  renderUploadFiles(); openDialog($('uploadDialog'));
}

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function addFiles(incoming) {
  if (state.saving) return;
  const additions = []; const errors = [];
  const existingKeys = new Set(state.files.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  let total = state.files.reduce((sum, file) => sum + file.size, 0);
  for (const file of [...incoming]) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (existingKeys.has(key)) continue;
    if (!allowedExtensions.test(file.name) || (file.type && !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type))) { errors.push(`${file.name}: PDF·JPG·PNG·WebP 파일만 제출할 수 있습니다.`); continue; }
    if (!file.size) { errors.push(`${file.name}: 비어 있는 파일입니다.`); continue; }
    if (file.size > MAX_FILE_BYTES) { errors.push(`${file.name}: 파일당 ${formatBytes(MAX_FILE_BYTES)} 이하여야 합니다.`); continue; }
    if (state.files.length + additions.length >= MAX_FILES) { errors.push(`한 번에 최대 ${MAX_FILES}개 파일을 제출할 수 있습니다.`); break; }
    if (total + file.size > MAX_TOTAL_BYTES) { errors.push(`전체 파일 합계는 ${formatBytes(MAX_TOTAL_BYTES)} 이하여야 합니다.`); continue; }
    additions.push(file); existingKeys.add(key); total += file.size;
  }
  state.files.push(...additions); showUploadError([...new Set(errors)].join('\n')); renderUploadFiles();
}

function renderUploadFiles() {
  $('uploadFileList').innerHTML = state.files.map((file, index) => `<div class="upload-file"><div class="file-name">${esc(file.name)}<small>${esc(formatBytes(file.size))}</small></div><div class="file-tools"><button type="button" class="button secondary" data-preview-local="${index}" ${state.saving ? 'disabled' : ''}>미리보기</button><button type="button" class="button ghost" data-remove-file="${index}" aria-label="${esc(file.name)} 선택 해제" ${state.saving ? 'disabled' : ''}>삭제</button></div></div>`).join('');
  $('uploadTotal').textContent = state.files.length ? `${state.files.length}개 선택 · 합계 ${formatBytes(state.files.reduce((sum, file) => sum + file.size, 0))}` : '선택한 파일이 없습니다.';
}

function fileUrl(fileId) { return `/api/files/${encodeURIComponent(fileId)}`; }

function previewFile(file, url) {
  $('previewFileName').textContent = file.name;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  $('previewContent').innerHTML = isPdf
    ? `<iframe class="preview-frame" title="${esc(file.name)} PDF 미리보기" src="${esc(url)}"></iframe>`
    : `<img class="preview-frame" alt="${esc(file.name)} 미리보기" src="${esc(url)}">`;
  if (!isPdf) $('previewContent').querySelector('img').addEventListener('error', (event) => {
    const message = document.createElement('p'); message.className = 'inline-error'; message.setAttribute('role', 'alert');
    message.textContent = '미리보기를 불러오지 못했습니다. 파일을 내려받아 확인해 주세요.';
    event.target.replaceWith(message);
  });
  const actions = document.createElement('p');
  const download = document.createElement('a'); download.className = 'button secondary'; download.href = url; download.download = file.name; download.textContent = '파일 내려받기';
  actions.append(download); $('previewContent').append(actions);
  if (isPdf) {
    const message = document.createElement('p'); message.className = 'muted';
    message.textContent = 'PDF가 표시되지 않으면 파일을 내려받아 확인해 주세요.'; $('previewContent').append(message);
  }
  openDialog($('previewDialog'));
}

function closeUpload() {
  if (state.saving) return;
  closeDialog($('uploadDialog')); releaseFiles(); state.uploadCourse = null;
}

async function submitUpload(event) {
  event.preventDefault();
  if (state.saving || !state.uploadCourse) return;
  showUploadError('');
  if (!$('uploadForm').reportValidity()) return;
  if (!state.files.length) { showUploadError('제출할 수료증 파일을 선택해 주세요.'); $('dropArea').focus(); return; }
  if ($('completedOn').value > localToday()) { showUploadError('수료일은 오늘 이후 날짜로 입력할 수 없습니다.'); return; }
  const body = new FormData();
  body.set('courseId', state.uploadCourse.id); body.set('expectedMemberId', state.me.member.id); body.set('completedOn', $('completedOn').value); body.set('comment', $('submissionComment').value.trim());
  for (const file of state.files) body.append('files', file, file.name);
  state.saving = true;
  for (const id of ['submitCertificate', 'cancelUpload', 'closeUpload', 'completedOn', 'submissionComment']) $(id).disabled = true;
  $('uploadProgress').hidden = false; renderUploadFiles();
  try {
    const result = await api('/submissions', { method: 'POST', body });
    if (!result.submission?.id) throw new Error('서버 접수 결과를 확인하지 못했습니다. 새로고침하여 제출 이력을 확인해 주세요.');
    state.me.submissions = [...(state.me.submissions || []), result.submission];
    state.me.overrides = (state.me.overrides || []).filter((item) => item.courseId !== result.submission.courseId || item.memberId !== result.submission.memberId);
    state.me.serverTime = result.submission.submittedAt;
    state.saving = false; closeUpload(); renderPage();
    showToast(`수료증이 접수되었습니다. 담당자 확인 후 이수 내역에 반영됩니다. (${formatTime(result.submission.submittedAt)})`);
    try { state.me = await api('/me'); renderPage(); }
    catch { showToast('접수는 완료되었습니다. 최신 현황을 확인하려면 새로고침해 주세요.', 'info'); }
  } catch (error) { showUploadError(error.status ? error.message : `${error.message}\n연결이 끊겼다면 새로고침하여 제출 이력을 확인한 후 다시 시도해 주세요.`); }
  finally {
    state.saving = false;
    for (const id of ['submitCertificate', 'cancelUpload', 'closeUpload', 'completedOn', 'submissionComment']) $(id).disabled = false;
    $('uploadProgress').hidden = true; renderUploadFiles();
  }
}

function openHistory(courseId) {
  const course = state.me.courses.find((item) => item.id === courseId);
  if (!course) return;
  $('historyCourseName').textContent = course.name;
  const entries = (state.me.submissions || []).filter((item) => item.courseId === courseId && item.memberId === state.me.member.id).sort((a, b) => (b.revision || 0) - (a.revision || 0) || String(b.submittedAt).localeCompare(String(a.submittedAt)) || b.id.localeCompare(a.id));
  const override = (state.me.overrides || []).find((item) => item.courseId === courseId && item.memberId === state.me.member.id);
  let html = override ? `<div class="notice"><strong>담당자 처리</strong> ${statusBadge(override.status)}<p>${esc(override.reason)}</p><small>${esc(formatTime(override.updatedAt))}</small></div>` : '';
  if (!entries.length) html += `<div class="empty-state">${personalStatus(course) === 'approved' ? '담당자가 확인한 기존 이수 내역입니다. 등록된 수료증 파일은 없습니다.' : '아직 제출한 수료증이 없습니다.'}</div>`;
  else html += entries.map((entry, index) => `<article class="history-entry"><div class="row">${statusBadge(entry.status)}${index === 0 ? '<span class="badge info">최근 제출</span>' : ''}</div><p><strong>접수</strong> ${esc(formatTime(entry.submittedAt))}<br><strong>수료일</strong> ${esc(formatDate(entry.completedOn))}</p>${entry.comment ? `<p class="description-text"><strong>전달 내용</strong><br>${esc(entry.comment)}</p>` : ''}${entry.reviewedAt ? `<p class="muted">검토 ${esc(formatTime(entry.reviewedAt))}</p>` : ''}${entry.reviewNote ? `<div class="${entry.status === 'needs_revision' ? 'revision-note' : 'notice'}"><strong>담당자 검토 의견</strong><br>${esc(entry.reviewNote)}</div>` : ''}<div class="history-files">${(entry.files || []).map((file) => `<button type="button" class="button secondary" data-preview-saved="${esc(file.id)}">${esc(file.name)} · ${esc(formatBytes(file.size))}</button>`).join('')}</div></article>`).join('');
  $('historyContent').innerHTML = html; openDialog($('historyDialog'));
}

function selectedSavedFile(fileId) {
  for (const entry of state.me?.submissions || []) { const file = entry.files?.find((item) => item.id === fileId); if (file) return file; }
  return null;
}

$('refreshButton').addEventListener('click', () => loadPage());
$('retryButton').addEventListener('click', () => loadPage());
$('changeMemberButton').addEventListener('click', async () => {
  if (state.loading || state.saving) return;
  try { await api('/member-session', { method: 'DELETE' }); state.me = null; renderPage(); }
  catch (error) { showToast(error.message, 'error'); }
});
$('memberSearch').addEventListener('input', (event) => { state.search = event.target.value; renderNames(); });
$('memberGrid').addEventListener('click', (event) => { const button = event.target.closest('[data-select-member]'); if (button) void selectMember(button.dataset.selectMember, button); });
for (const [id, key] of [['yearFilter', 'year'], ['quarterFilter', 'quarter'], ['monthFilter', 'month'], ['statusFilter', 'status']]) {
  $(id).addEventListener('change', (event) => {
    state[key] = event.target.value;
    if (key === 'quarter') { state.month = ''; $('monthFilter').value = ''; }
    if (key === 'month') { state.quarter = ''; $('quarterFilter').value = ''; }
    renderPersonal();
  });
}
$('monthFilter').insertAdjacentHTML('beforeend', Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}월</option>`).join(''));
$('courseList').addEventListener('click', (event) => {
  const upload = event.target.closest('[data-upload-course]'); const history = event.target.closest('[data-history-course]');
  if (upload) openUpload(upload.dataset.uploadCourse); else if (history) openHistory(history.dataset.historyCourse);
});
$('dropArea').addEventListener('click', () => { if (!state.saving) $('certificateFiles').click(); });
$('dropArea').addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (!state.saving) $('certificateFiles').click(); } });
let dragDepth = 0;
for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  $('dropArea').addEventListener(type, (event) => {
    event.preventDefault(); event.stopPropagation(); if (state.saving) return;
    if (type === 'dragenter') dragDepth += 1;
    if (type === 'dragleave') dragDepth = Math.max(0, dragDepth - 1);
    if (type === 'drop') { dragDepth = 0; addFiles(event.dataTransfer?.files || []); }
    $('dropArea').classList.toggle('dragging', type === 'dragover' || dragDepth > 0);
  });
}
$('uploadDialog').addEventListener('dragover', (event) => event.preventDefault());
$('uploadDialog').addEventListener('drop', (event) => event.preventDefault());
$('certificateFiles').addEventListener('change', (event) => { addFiles(event.target.files); event.target.value = ''; });
$('uploadFileList').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-file]'); const preview = event.target.closest('[data-preview-local]');
  if (remove && !state.saving) {
    const file = state.files[Number(remove.dataset.removeFile)]; const url = state.localPreviews.get(file);
    if (url) URL.revokeObjectURL(url);
    state.localPreviews.delete(file); state.files.splice(Number(remove.dataset.removeFile), 1); renderUploadFiles();
  } else if (preview && !state.saving) {
    const file = state.files[Number(preview.dataset.previewLocal)];
    if (!state.localPreviews.has(file)) state.localPreviews.set(file, URL.createObjectURL(file));
    previewFile(file, state.localPreviews.get(file));
  }
});
$('uploadForm').addEventListener('submit', submitUpload);
$('closeUpload').addEventListener('click', closeUpload); $('cancelUpload').addEventListener('click', closeUpload);
$('uploadDialog').addEventListener('cancel', (event) => { event.preventDefault(); closeUpload(); });
$('closeHistory').addEventListener('click', () => closeDialog($('historyDialog')));
$('closePreview').addEventListener('click', () => closeDialog($('previewDialog')));
$('previewDialog').addEventListener('close', () => {
  $('previewContent').innerHTML = '';
  state.previewController?.abort();
  state.previewController = null;
  if (state.savedPreviewUrl) URL.revokeObjectURL(state.savedPreviewUrl);
  state.savedPreviewUrl = '';
});
$('historyContent').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-preview-saved]'); if (!button) return;
  const file = selectedSavedFile(button.dataset.previewSaved); if (!file) return;
  button.disabled = true;
  state.previewController?.abort();
  const controller = new AbortController();
  state.previewController = controller;
  $('previewFileName').textContent = file.name;
  $('previewContent').innerHTML = '<p class="empty-state" role="status">수료증 파일을 불러오고 있습니다.</p>';
  openDialog($('previewDialog'));
  try {
    const response = await fetchStoredFile(fileUrl(file.id), {signal: controller.signal, onRetry: () => {
      if (state.previewController === controller && $('previewDialog').open) $('previewContent').innerHTML = '<p class="empty-state" role="status">파일을 저장소에 반영 중입니다. 잠시 후 다시 확인합니다.</p>';
    }});
    const blob = await response.blob();
    if (!($('previewDialog').open) || state.previewController !== controller) return;
    if (state.savedPreviewUrl) URL.revokeObjectURL(state.savedPreviewUrl);
    state.savedPreviewUrl = URL.createObjectURL(blob);
    previewFile(file, state.savedPreviewUrl);
  } catch (error) {
    if (error.name !== 'AbortError' && state.previewController === controller && $('previewDialog').open) $('previewContent').innerHTML = `<p class="inline-error" role="alert">${esc(error.message)}</p>`;
  } finally {
    if (state.previewController === controller) state.previewController = null;
    button.disabled = false;
  }
});
window.addEventListener('beforeunload', (event) => { if (state.saving) { event.preventDefault(); event.returnValue = ''; } });

void loadPage();

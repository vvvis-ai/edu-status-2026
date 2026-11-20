import {api, closeDialog, escapeHtml as e, openDialog, showToast} from './edu-client.mjs';
import {FILE_ACCEPT, getLatestSubmission, isTarget, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES} from './edu-shared.mjs';
import {findCertificateMatch} from './edu-certificate-match.mjs';

const fileTypes = {'.pdf':'application/pdf','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

export function initCertificateImport({getData, reloadData, viewStatus}) {
  const byId = id => document.getElementById(id);
  const dialog = byId('certificateImportDialog');
  const drop = byId('certificateDrop');
  const input = byId('certificateFiles');
  const pickButton = byId('certificatePick');
  const statusButton = byId('certificateStatus');
  const saveButton = byId('certificateSave');
  const batch = byId('certificateBatch');
  const batchCourse = byId('certificateBatchCourse');
  const applyCourse = byId('certificateApplyCourse');
  const replaceCourse = byId('certificateReplaceCourse');
  const selectAll = byId('certificateSelectAll');
  const batchNotice = byId('certificateBatchNotice');
  const rowList = byId('certificateRows');
  const progress = byId('certificateProgress');
  const error = byId('certificateError');
  const previewDialog = byId('certificatePreviewDialog');
  const preview = byId('certificatePreview');
  let previewUrl = '';
  let rows = [];
  let nextId = 0;
  let reading = null;
  let saving = false;
  let data;

  input.accept = FILE_ACCEPT;

  function rowState(row) {
    if (row.saved || row.blocked) return null;
    const member = data.members.find(item => item.id === row.memberId && item.active);
    const course = data.courses.find(item => item.id === row.courseId && item.published && !item.archived);
    if (!member || !course || !row.date || row.date > today()) return {message:'부서원, 교육, 수료일(오늘까지)을 확인해 주세요.'};
    if (!isTarget(course, member)) return {message:'해당 부서원은 이 교육의 대상이 아니거나 면제되었습니다.'};
    const latest = getLatestSubmission(data.submissions, member.id, course.id);
    if (latest?.status === 'approved') return {message:'이미 승인된 수료증이 있습니다.'};
    if (data.overrides.some(item => item.memberId === member.id && item.courseId === course.id)) return {message:'이수 현황에서 기존 수동 처리 기록을 확인해 주세요.'};
    return {member, course, latest};
  }

  function showError(message = '') { error.hidden = !message; error.textContent = message; }
  function showBatchNotice(message = '') { batchNotice.hidden = !message; batchNotice.textContent = message; }

  function canEdit(row) { return !row.saved && !row.blocked; }

  function canApplyCourse(row) {
    return canEdit(row) && row.courseId !== batchCourse.value && (!row.courseId || replaceCourse.checked);
  }

  function updateAssignment(row, field, value) {
    row[field] = value;
    row.selected = false;
    row.failure = '';
  }

  function putRows() {
    const memberOptions = data.members.filter(member => member.active)
      .map(member => `<option value="${e(member.id)}">${e([member.name, member.team, member.position].filter(Boolean).join(' · '))}</option>`).join('');
    const courseOptions = data.courses.filter(course => course.published && !course.archived)
      .map(course => `<option value="${e(course.id)}">${e(course.name)} · ${e(course.year)}년${course.periodType === 'year' ? '' : ` ${e(course.periodValue)}${course.periodType === 'month' ? '월' : '분기'}`}</option>`).join('');
    const previousBatchCourse = batchCourse.value;
    batchCourse.innerHTML = `<option value="">교육 선택</option>${courseOptions}`;
    if ([...batchCourse.options].some(option => option.value === previousBatchCourse)) batchCourse.value = previousBatchCourse;
    rowList.innerHTML = rows.map(row => {
      const detected = [row.detected?.name, row.detected?.course, row.detected?.date].filter(Boolean);
      const source = detected.length ? `${row.detected.source} · ${detected.join(' · ')}` : '';
      return `<li class="certificate-row" data-certificate-row="${row.id}">
        <div class="certificate-row-head"><strong class="certificate-filename">${e(row.file.name)}</strong><div class="row">
          ${row.type && !row.unreadable ? '<button type="button" class="button ghost" data-certificate-action="preview">원본 보기</button>' : ''}
          ${row.saved ? '' : '<button type="button" class="button ghost" data-certificate-action="remove">제외</button>'}
        </div></div>
        ${source ? `<p class="form-help certificate-detected">${e(source)}</p>` : ''}
        ${row.hint ? `<p class="form-help certificate-detected">${e(row.hint)}</p>` : ''}
        ${canEdit(row) ? `<div class="certificate-fields">
          <label class="field">부서원<select data-field="memberId"><option value="">부서원 선택</option>${memberOptions}</select></label>
          <label class="field">교육<select data-field="courseId"><option value="">교육 선택</option>${courseOptions}</select></label>
          <label class="field">수료일<input type="date" data-field="date" max="${today()}"></label>
        </div><label class="checkbox-line certificate-confirm"><input type="checkbox" data-field="selected"> 승인·등록 대상에 포함</label>` : ''}
        <p class="form-help certificate-row-message" data-certificate-message></p>
      </li>`;
    }).join('');
    for (const row of rows) {
      const item = rowList.querySelector(`[data-certificate-row="${row.id}"]`);
      for (const field of item.querySelectorAll('select,input[type=date]')) field.value = row[field.dataset.field];
    }
    updateControls();
  }

  function updateControls() {
    const busy = !!reading || saving;
    let included = 0;
    let saved = 0;
    let eligibleCount = 0;
    const elements = rowList.children;
    rows.forEach((row, index) => {
      const item = elements[index];
      const state = rowState(row);
      const eligible = !!state?.member;
      const selected = item.querySelector('[data-field="selected"]');
      if (!eligible) row.selected = false;
      if (eligible) eligibleCount++;
      if (selected) {
        selected.checked = row.selected;
        selected.disabled = busy || !eligible;
      }
      if (row.selected) included++;
      if (row.saved) saved++;
      for (const field of item.querySelectorAll('select,input[type=date],[data-certificate-action="remove"]')) field.disabled = busy;
      const message = item.querySelector('[data-certificate-message]');
      message.textContent = row.saved ? `이수 완료 · ${row.saved.completedOn}`
        : row.failure || row.blocked || state?.message || (state?.latest ? '기존 제출 이력과 함께 보관됩니다.' : '');
      message.hidden = !message.textContent;
      message.classList.toggle('field-error', !!(row.failure || row.blocked));
      item.classList.toggle('certificate-saved', !!row.saved);
    });
    pickButton.disabled = busy;
    batch.hidden = !rows.some(canEdit);
    batchCourse.disabled = replaceCourse.disabled = busy || batchCourse.options.length <= 1;
    applyCourse.disabled = busy || !batchCourse.value || !rows.some(canApplyCourse);
    selectAll.disabled = busy || !eligibleCount;
    selectAll.checked = eligibleCount > 0 && included === eligibleCount;
    selectAll.indeterminate = included > 0 && included < eligibleCount;
    for (const button of dialog.querySelectorAll('[data-close]')) button.disabled = saving;
    statusButton.hidden = !saved;
    statusButton.disabled = busy;
    saveButton.disabled = busy || !included;
    saveButton.textContent = saving ? '등록 중…' : included ? `선택한 ${included}개 승인·등록` : '선택한 수료증 승인·등록';
    if (!busy) {
      const review = rows.length - included - saved;
      progress.textContent = rows.length ? `전체 ${rows.length}개 · 등록 선택 ${included}개 · 확인 필요 또는 제외 ${review}개 · 등록 완료 ${saved}개` : '';
    }
  }

  async function analyze(files) {
    if (reading || saving || !files.length) return;
    const controller = new AbortController();
    reading = controller;
    let reader;
    showError();
    showBatchNotice();
    updateControls();
    try {
      for (const [index, file] of files.entries()) {
        controller.signal.throwIfAborted();
        progress.textContent = `판독 중 ${index + 1}/${files.length} · ${file.name}`;
        const type = fileTypes[/\.[^.]+$/.exec(file.name)?.[0].toLowerCase()];
        const row = {id:++nextId, file, type, memberId:'',courseId:'',date:'',selected:false};
        if (!type || !file.size || file.size > MAX_FILE_BYTES) {
          row.blocked = 'PDF·JPG·PNG·WebP 형식과 파일 크기(15MB 이하)를 확인해 주세요.';
          row.unreadable = true;
        } else {
          try {
            if (!reader) {
              const {createCertificateReader} = await import('./edu-certificate-reader.mjs');
              reader = createCertificateReader(controller.signal);
            }
            row.detected = await reader.read(file);
            if (row.detected.blocked) {
              row.blocked = '서로 다른 성명 또는 과정이 여러 페이지에서 읽혔습니다. 수료증을 분리한 후 다시 올려 주세요.';
            } else {
              const match = findCertificateMatch(row.detected, data);
              Object.assign(row, {memberId:match.memberId, courseId:match.courseId, date:row.detected.date, selected:match.confirmed,
                hint:row.detected.ocrFailed ? 'OCR로 읽지 못했습니다. 원본을 보고 필요한 항목을 입력해 주세요.' : match.hint});
            }
          } catch {
            controller.signal.throwIfAborted();
            row.blocked = '파일을 열 수 없습니다. 손상 여부와 DRM 설정을 확인해 주세요.';
            row.unreadable = true;
          }
        }
        controller.signal.throwIfAborted();
        rows.push(row);
      }
    } catch (err) {
      if (!controller.signal.aborted) showError(err.message);
    } finally {
      reader?.close();
      if (reading === controller) { reading = null; putRows(); }
    }
  }

  async function save() {
    if (saving || reading) return;
    const groups = new Map();
    for (const row of rows.filter(item => item.selected)) {
      const state = rowState(row);
      if (!state?.member) continue;
      const key = JSON.stringify([row.memberId, row.courseId]);
      if (!groups.has(key)) groups.set(key, {...state, rows:[]});
      groups.get(key).rows.push(row);
    }
    if (!groups.size) return;
    saving = true;
    showError();
    showBatchNotice();
    updateControls();
    let saved = 0;
    let index = 0;
    let refresh = false;
    try {
      for (const group of groups.values()) {
        const {member, course, latest} = group;
        progress.textContent = `등록 중 ${++index}/${groups.size} · ${member.name}`;
        const total = group.rows.reduce((sum, row) => sum + row.file.size, 0);
        if (group.rows.length > MAX_FILES || total > MAX_TOTAL_BYTES) {
          for (const row of group.rows) row.failure = '같은 부서원·교육에는 최대 10개, 합계 60MB까지 등록할 수 있습니다. 첨부 선택을 조정해 주세요.';
          continue;
        }
        const form = new FormData();
        form.set('memberId', member.id);
        form.set('courseId', course.id);
        form.set('memberVersion', member.version);
        form.set('courseVersion', course.version);
        form.set('expectedSubmission', latest ? `${latest.id}|${latest.version}` : '');
        form.set('completedOn', group.rows.map(row => row.date).sort().at(-1));
        for (const row of group.rows) form.append('files', row.file);
        try {
          const {submission} = await api('/admin/certificate-import', {method:'POST',body:form});
          for (const row of group.rows) Object.assign(row, {saved:submission,selected:false,failure:''});
          saved += group.rows.length;
        } catch (err) {
          for (const row of group.rows) row.failure = err.message;
          if (err.code === 'VERSION_CONFLICT' || !err.status) {
            refresh = true;
            for (const row of group.rows) row.selected = false;
          }
        }
      }
      if (saved) showToast(`수료증 ${saved}개를 등록하고 이수 현황에 반영했습니다.`);
      if (saved || refresh) {
        try { await reloadData(); data = getData(); }
        catch { showError('최신 이수 현황을 불러오지 못했습니다. 새로고침해 주세요.'); }
      }
    } finally { saving = false; putRows(); }
  }

  document.querySelectorAll('[data-certificate-import]').forEach(button => button.addEventListener('click', () => {
    data = getData();
    putRows();
    openDialog(dialog);
  }));
  pickButton.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    void analyze(files);
  });
  drop.addEventListener('dragover', event => {
    event.preventDefault();
    event.dataTransfer.dropEffect = reading || saving ? 'none' : 'copy';
    drop.classList.toggle('is-dragover', !reading && !saving);
  });
  drop.addEventListener('dragleave', event => { if (!drop.contains(event.relatedTarget)) drop.classList.remove('is-dragover'); });
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('is-dragover');
    void analyze([...event.dataTransfer.files]);
  });
  dialog.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  dialog.addEventListener('drop', event => { if (event.dataTransfer.files.length) event.preventDefault(); });
  for (const control of [batchCourse, replaceCourse]) {
    control.addEventListener('change', () => { showBatchNotice(); updateControls(); });
  }
  applyCourse.addEventListener('click', () => {
    if (applyCourse.disabled) return;
    let count = 0;
    rows.forEach((row, index) => {
      if (!canApplyCourse(row)) return;
      updateAssignment(row, 'courseId', batchCourse.value);
      rowList.children[index].querySelector('[data-field="courseId"]').value = row.courseId;
      count++;
    });
    showBatchNotice(`${count}개 파일에 교육을 지정했습니다.`);
    updateControls();
  });
  selectAll.addEventListener('change', () => {
    if (selectAll.disabled) return;
    for (const row of rows) {
      const selected = selectAll.checked && !!rowState(row)?.member;
      if (row.selected !== selected) { row.selected = selected; row.failure = ''; }
    }
    updateControls();
  });
  rowList.addEventListener('change', event => {
    const field = event.target.dataset.field;
    const row = rows.find(item => item.id === Number(event.target.closest('[data-certificate-row]')?.dataset.certificateRow));
    if (!field || !row) return;
    if (field === 'selected') { row.selected = event.target.checked; row.failure = ''; }
    else updateAssignment(row, field, event.target.value);
    updateControls();
  });
  rowList.addEventListener('click', event => {
    const button = event.target.closest('[data-certificate-action]');
    if (!button) return;
    const id = Number(button.closest('[data-certificate-row]').dataset.certificateRow);
    const row = rows.find(item => item.id === id);
    if (button.dataset.certificateAction === 'remove') {
      rows = rows.filter(item => item !== row);
      putRows();
      pickButton.focus();
    } else {
      const file = new Blob([row.file], {type:row.type});
      previewUrl = URL.createObjectURL(file);
      const isPdf = row.type === 'application/pdf';
      const element = document.createElement(isPdf ? 'iframe' : 'img');
      if (isPdf) element.title = row.file.name;
      else element.alt = row.file.name;
      element.src = previewUrl;
      preview.replaceChildren(element);
      byId('certificatePreviewName').textContent = row.file.name;
      openDialog(previewDialog);
    }
  });
  saveButton.addEventListener('click', save);
  statusButton.addEventListener('click', () => {
    const years = new Set(rows.filter(row => row.saved).map(row => data.courses.find(course => course.id === row.courseId)?.year));
    closeDialog(dialog);
    viewStatus(years.size === 1 ? [...years][0] : null);
  });
  previewDialog.addEventListener('close', () => { URL.revokeObjectURL(previewUrl); preview.replaceChildren(); });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    reading?.abort();
    reading = null;
    rows = [];
    rowList.replaceChildren();
    batchCourse.value = '';
    replaceCourse.checked = false;
    showBatchNotice();
    showError();
  });
}

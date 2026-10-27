import {STATUS_LABELS} from './edu-shared.mjs';
import {createWorkbook} from './edu-workbook.mjs';
export async function api(path, options = {}) {
  const init = {...options, credentials:'same-origin', headers:new Headers(options.headers)};
  if (init.body && !(init.body instanceof FormData) && typeof init.body !== 'string') {
    init.headers.set('Content-Type','application/json'); init.body = JSON.stringify(init.body);
  }
  let response;
  try { response = await fetch(path.startsWith('/api/') ? path : `/api${path.startsWith('/')?'':'/'}${path}`, init); }
  catch { throw new Error('서버에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도해 주세요.'); }
  const data = response.status === 204 ? {} : await response.json().catch(() => ({error:'서버 응답을 읽을 수 없습니다. 앱 서버 주소로 접속했는지 확인해 주세요.'}));
  if (!response.ok) { const error = new Error(data.error || '요청을 처리하지 못했습니다.'); error.status=response.status; error.code=data.code; throw error; }
  if (data.error) throw new Error(data.error);
  return data;
}
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function formatDate(value) { if (!value) return '—'; return String(value).slice(0,10).replaceAll('-','.'); }
export function formatTime(value) { if (!value) return '—'; const d=new Date(value); return Number.isNaN(d.getTime())?'—':new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(d); }
export function formatBytes(value) { return value<1024?`${value} B`:value<1024*1024?`${(value/1024).toFixed(1)} KB`:`${(value/1024/1024).toFixed(1)} MB`; }
export function showToast(message,type='success') {
  let region=document.querySelector('#toastRegion');
  if (!region) { region=document.createElement('div'); region.id='toastRegion'; region.className='toast-region'; region.setAttribute('aria-live','polite'); document.body.append(region); }
  const toast=document.createElement('div'); toast.className=`toast ${type==='error'?'error':''}`; toast.textContent=message; toast.setAttribute('role',type==='error'?'alert':'status'); region.append(toast); setTimeout(()=>toast.remove(),6500);
}
export function openDialog(dialog) { if (!dialog.open) dialog.showModal(); }
export function closeDialog(dialog) { dialog.close(); }
function saveBlob(blob,filename) { const url=URL.createObjectURL(blob),a=document.createElement('a'); a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000); }
const FILE_PROPAGATING_MESSAGE = '파일을 저장소에 반영 중입니다. 잠시 후 다시 시도해 주세요.';
function checkFileAbort(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('파일 요청이 취소되었습니다.', 'AbortError');
}
function fileRetryDelay(value) {
  if (value && /^\d+$/.test(value.trim())) return Number(value) * 1000;
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 5000;
}
function waitForStoredFile(delayMs, signal) {
  checkFileAbort(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('파일 요청이 취소되었습니다.', 'AbortError'));
    };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, delayMs);
    signal?.addEventListener('abort', cancel, {once:true});
  });
}
export async function fetchStoredFile(path, {signal, onRetry} = {}) {
  const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    checkFileAbort(signal);
    let response;
    try { response = await fetch(url, {method:'GET', credentials:'same-origin', signal}); }
    catch (error) {
      checkFileAbort(signal);
      if (error.name === 'AbortError') throw error;
      throw new Error('서버에 연결할 수 없습니다. 연결을 확인한 뒤 다시 시도해 주세요.', {cause:error});
    }
    checkFileAbort(signal);
    if (response.ok) return response;
    let body;
    try { body = await response.json(); }
    catch { checkFileAbort(signal); body = {}; }
    const propagating = response.status === 503 && body?.code === 'FILE_PROPAGATING';
    if (propagating && attempt < 2) {
      const delayMs = fileRetryDelay(response.headers.get('Retry-After'));
      onRetry?.({attempt:attempt + 2, maxAttempts:3, delayMs});
      await waitForStoredFile(delayMs, signal);
      continue;
    }
    const error = new Error(propagating ? FILE_PROPAGATING_MESSAGE : body?.error || '파일을 내려받을 수 없습니다.');
    error.status = response.status; error.code = body?.code;
    throw error;
  }
}
export async function downloadFile(path,filename,options = {}) {
  const response=await fetchStoredFile(path,options);
  saveBlob(await response.blob(),filename || '교육수료증.zip');
}
export async function downloadXlsx(rows,filename='교육이수현황.xlsx') {
  const blob=await new Response(createWorkbook(rows),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}}).blob();
  saveBlob(blob,filename.endsWith('.xlsx')?filename:`${filename}.xlsx`);
}
export function statusBadge(status) {
  const type={approved:'success',pending:'info',needs_revision:'danger',not_submitted:'warning',exempt:'muted',not_target:'muted'}[status] || 'muted';
  return `<span class="badge ${type}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
}

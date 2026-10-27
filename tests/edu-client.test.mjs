import test from 'node:test';
import assert from 'node:assert/strict';
import {api, downloadFile, fetchStoredFile} from '../edu-client.mjs';

const propagationMessage = '파일을 저장소에 반영 중입니다. 잠시 후 다시 시도해 주세요.';
const propagating = (retryAfter = '5') => new Response(JSON.stringify({error:propagationMessage, code:'FILE_PROPAGATING'}), {
  status:503, headers:{'Content-Type':'application/json', ...(retryAfter === null ? {} : {'Retry-After':retryAfter})},
});
function skipWaits(t) {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    delays.push(delay); queueMicrotask(callback); return delays.length;
  });
  return delays;
}

test('stored file GET preserves original bytes, credentials, signal, and API path', async t => {
  const original = new Uint8Array([0, 255, 1, 128, 7]);
  const controller = new AbortController();
  const fetch = t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/files/test');
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.signal, controller.signal);
    return new Response(original);
  });
  const response = await fetchStoredFile('files/test', {signal:controller.signal});
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), original);
  assert.equal(fetch.mock.callCount(), 1);
});

test('only propagating files retry, respecting Retry-After before returning success', async t => {
  const delays = skipWaits(t), retries = [];
  const responses = [propagating('5'), propagating('2'), new Response('original file')];
  const fetch = t.mock.method(globalThis, 'fetch', async () => responses.shift());
  const response = await fetchStoredFile('/api/files/test', {onRetry:retry => retries.push(retry)});
  assert.equal(await response.text(), 'original file');
  assert.equal(fetch.mock.callCount(), 3);
  assert.deepEqual(delays, [5000, 2000]);
  assert.deepEqual(retries, [{attempt:2, maxAttempts:3, delayMs:5000}, {attempt:3, maxAttempts:3, delayMs:2000}]);
});

test('propagation stops after three total GETs and exposes a retryable message', async t => {
  const delays = skipWaits(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => propagating(null));
  await assert.rejects(fetchStoredFile('/files/test'), error => {
    assert.equal(error.message, propagationMessage);
    assert.equal(error.status, 503);
    assert.equal(error.code, 'FILE_PROPAGATING');
    return true;
  });
  assert.equal(fetch.mock.callCount(), 3);
  assert.deepEqual(delays, [5000, 5000]);
});

test('Retry-After HTTP dates are respected and invalid values fall back to five seconds', async t => {
  const delays = skipWaits(t);
  const now = Date.UTC(2026, 9, 27, 0, 0, 0);
  t.mock.method(Date, 'now', () => now);
  const responses = [propagating(new Date(now + 7000).toUTCString()), propagating('invalid'), new Response('file')];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  await fetchStoredFile('/files/test');
  assert.deepEqual(delays, [7000, 5000]);
});

test('permission, missing-file, unrelated 503 and malformed errors never retry', async t => {
  const delays = skipWaits(t);
  const cases = [
    {status:403, body:{error:'권한이 없습니다.', code:'FILE_PROPAGATING'}},
    {status:404, body:{error:'파일이 없습니다.'}},
    {status:503, body:{error:'저장소 연결 오류', code:'STORAGE_UNAVAILABLE'}},
    {status:503, raw:'<html>Unavailable</html>'},
  ];
  for (const entry of cases) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(entry.raw || JSON.stringify(entry.body), {status:entry.status}));
    await assert.rejects(fetchStoredFile('/files/test'), error => error.status === entry.status);
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
  assert.deepEqual(delays, []);
});

test('network errors never retry', async t => {
  const delays = skipWaits(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('network disconnected'); });
  await assert.rejects(fetchStoredFile('/files/test'), /서버에 연결할 수 없습니다/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(delays, []);
});

test('an aborted signal prevents the first GET', async t => {
  const controller = new AbortController(); controller.abort();
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('unexpected'));
  await assert.rejects(fetchStoredFile('/files/test', {signal:controller.signal}), {name:'AbortError'});
  assert.equal(fetch.mock.callCount(), 0);
});

test('aborting during a retry wait cancels its timer and prevents the next GET', async t => {
  const controller = new AbortController();
  const timerId = {};
  let waiting;
  const beganWaiting = new Promise(resolve => { waiting = resolve; });
  const timer = t.mock.method(globalThis, 'setTimeout', () => { waiting(); return timerId; });
  const clear = t.mock.method(globalThis, 'clearTimeout', id => assert.equal(id, timerId));
  const fetch = t.mock.method(globalThis, 'fetch', async () => propagating());
  const pending = fetchStoredFile('/files/test', {signal:controller.signal});
  await beganWaiting;
  controller.abort();
  await assert.rejects(pending, {name:'AbortError'});
  assert.equal(timer.mock.callCount(), 1);
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(fetch.mock.callCount(), 1);
});

test('aborting an in-flight GET is preserved without retry', async t => {
  const controller = new AbortController();
  const fetch = t.mock.method(globalThis, 'fetch', (_path, {signal}) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {once:true});
  }));
  const pending = fetchStoredFile('/files/test', {signal:controller.signal});
  controller.abort();
  await assert.rejects(pending, {name:'AbortError'});
  assert.equal(fetch.mock.callCount(), 1);
});

test('aborting while consuming an error response remains an abort', async t => {
  const controller = new AbortController();
  let responseStream;
  const body = new ReadableStream({start(stream) { responseStream = stream; }});
  const fetch = t.mock.method(globalThis, 'fetch', async (_path, {signal}) => {
    signal.addEventListener('abort', () => responseStream.error(signal.reason), {once:true});
    return new Response(body, {status:503});
  });
  const pending = fetchStoredFile('/files/test', {signal:controller.signal});
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, {name:'AbortError'});
  assert.equal(fetch.mock.callCount(), 1);
});

test('upload POST through the existing JSON/form API is never automatically retried', async t => {
  const delays = skipWaits(t);
  const form = new FormData(); form.set('courseId', 'course');
  const fetch = t.mock.method(globalThis, 'fetch', async (path, options) => {
    assert.equal(path, '/api/submissions');
    assert.equal(options.method, 'POST');
    assert.equal(options.body, form);
    return propagating();
  });
  await assert.rejects(api('/submissions', {method:'POST', body:form}), error => error.code === 'FILE_PROPAGATING');
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(delays, []);
});

test('download waits for storage and saves exactly one original binary Blob', async t => {
  const delays = skipWaits(t), original = new Uint8Array([0, 255, 80, 68, 70]);
  let savedBlob, clicks = 0, attached = 0;
  const anchor = {click() { clicks++; }, remove() {}};
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable:true, value:{
    createElement(tag) { assert.equal(tag, 'a'); return anchor; },
    body:{append(element) { assert.equal(element, anchor); attached++; }},
  }});
  t.after(() => { if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document; });
  t.mock.method(URL, 'createObjectURL', blob => { savedBlob = blob; return 'blob:download'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const responses = [propagating('5'), new Response(original)];
  const fetch = t.mock.method(globalThis, 'fetch', async () => responses.shift());
  await downloadFile('/files/download', '수료증.pdf');
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(clicks, 1); assert.equal(attached, 1);
  assert.equal(anchor.download, '수료증.pdf');
  assert.deepEqual(new Uint8Array(await savedBlob.arrayBuffer()), original);
  assert.deepEqual(delays, [5000, 60000]);
});

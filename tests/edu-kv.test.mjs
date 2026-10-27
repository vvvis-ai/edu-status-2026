import test from 'node:test';
import assert from 'node:assert/strict';
import { createKVFiles } from '../server/kv-storage.mjs';
import { MAX_FILE_BYTES } from '../edu-shared.mjs';

function fixture() {
  const records = new Map(), reads = [], writes = [], deletions = [];
  let visible = true;
  const namespace = {
    async put(key, value, options) {
      assert.ok(value instanceof ArrayBuffer, 'file writes use binary, never text or base64');
      writes.push(key);
      records.set(key, { bytes: new Uint8Array(value).slice(), metadata: structuredClone(options.metadata) });
    },
    async getWithMetadata(key, options) {
      reads.push({ key, options });
      const record = visible && records.get(key);
      if (!record) return { value: null, metadata: null };
      return { metadata: structuredClone(record.metadata), value: new ReadableStream({ start(controller) { controller.enqueue(record.bytes.slice()); controller.close(); } }) };
    },
    async delete(key) { deletions.push(key); records.delete(key); },
  };
  return { namespace, files: createKVFiles(namespace), records, reads, writes, deletions, visibility(value) { visible = value; } };
}
const content = Uint8Array.from([0, 255, 254, 128, 13, 10, 37, 80, 68, 70]);
const options = { httpMetadata: { contentType: 'application/pdf' } };

test('KV adapter preserves binary view and streamed bytes, size metadata and an eventual write receipt without reading', async () => {
  const f = fixture();
  assert.equal(f.files.consistency, 'eventual');
  const backing = new Uint8Array(content.length + 4); backing.set(content, 2);
  const receipt = await f.files.put('certificates/view.pdf', backing.subarray(2, 2 + content.length), options);
  assert.deepEqual(receipt, { key: 'certificates/view.pdf', size: content.length, httpMetadata: options.httpMetadata });
  assert.equal(f.reads.length, 0, 'put never verifies visibility with get/head');
  assert.deepEqual(f.records.get('certificates/view.pdf').bytes, content);
  await f.files.put('certificates/stream.pdf', new ReadableStream({ start(controller) {
    controller.enqueue(content.subarray(0, 3)); controller.enqueue(new Uint8Array());
    controller.enqueue(content.subarray(3)); controller.close();
  } }), options);
  assert.equal(f.reads.length, 0);
  assert.deepEqual(f.records.get('certificates/stream.pdf').bytes, content);
  assert.deepEqual(f.records.get('certificates/stream.pdf').metadata, { size: content.length, contentType: 'application/pdf' });
  const object = await f.files.get('certificates/stream.pdf');
  assert.deepEqual(new Uint8Array(await new Response(object.body).arrayBuffer()), content);
  assert.deepEqual(f.reads[0].options, { type: 'stream', cacheTtl: 30 });
});

test('KV put succeeds while reads are delayed, then exposes the unchanged original after propagation', async () => {
  const f = fixture(); f.visibility(false);
  assert.equal((await f.files.put('delayed.bin', content.buffer)).size, content.length);
  assert.equal(f.reads.length, 0);
  assert.equal(await f.files.get('delayed.bin'), null);
  assert.equal(await f.files.head('delayed.bin'), null);
  f.visibility(true);
  const object = await f.files.get('delayed.bin');
  assert.equal(object.httpMetadata.contentType, 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await new Response(object.body).arrayBuffer()), content);
});

test('KV head cancels the unread stream and get leaves a valid stream for its caller', async () => {
  const f = fixture(); let reads = 0, cancelled = 0;
  f.namespace.getWithMetadata = async () => ({ metadata: { size: content.length, contentType: 'image/png' }, value: new ReadableStream({
    pull(controller) { reads++; controller.enqueue(content); }, cancel() { cancelled++; },
  }, { highWaterMark: 0 }) });
  assert.deepEqual(await f.files.head('photo.png'), { key: 'photo.png', size: content.length, httpMetadata: { contentType: 'image/png' } });
  assert.equal(reads, 0); assert.equal(cancelled, 1);
  const object = await f.files.get('photo.png');
  assert.equal(reads, 0); assert.equal(cancelled, 1);
  await object.body.cancel();
  assert.equal(cancelled, 2);
});

test('KV rejects corrupt stored metadata and cancels its body instead of leaking a stream', async () => {
  const f = fixture(); let cancelled = 0;
  const metadata = [null, {}, { size: 10 }, [], 'invalid', { size: 0, contentType: 'image/png' }, { size: -1, contentType: 'image/png' },
    { size: 1.5, contentType: 'image/png' }, { size: '10', contentType: 'image/png' }, { size: MAX_FILE_BYTES + 1, contentType: 'image/png' },
    { size: 10, contentType: 'image/png\r\nX-Bad: true' }, { size: 10, contentType: 'a'.repeat(1024) }];
  for (const item of metadata) {
    f.namespace.getWithMetadata = async () => ({ metadata: item, value: new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 }) });
    await assert.rejects(f.files.get('corrupt.bin'));
  }
  assert.equal(cancelled, metadata.length);
});

test('KV validates key byte lengths and safe paths before touching the namespace', async () => {
  const f = fixture();
  const valid = ['a'.repeat(512), `${'한'.repeat(170)}aa`, 'certificates/course/member/file.pdf'];
  for (const key of valid) await f.files.put(key, content, options);
  assert.equal(f.writes.length, valid.length);
  const invalid = ['', '.', '..', '/absolute', 'folder/../escape', 'folder/./file', 'bad\\key', 'bad\u0000key', '\ud800', 'C:drive', 'a'.repeat(513), `${'한'.repeat(171)}`];
  for (const key of invalid) {
    await assert.rejects(f.files.put(key, content, options), /저장 키/);
    await assert.rejects(f.files.get(key), /저장 키/);
    await assert.rejects(f.files.head(key), /저장 키/);
    await assert.rejects(f.files.delete(key), /저장 키/);
  }
  assert.equal(f.writes.length, valid.length);
  assert.equal(f.reads.length, 0); assert.equal(f.deletions.length, 0);
});

test('KV enforces the file bound and compact metadata before any write, including exact-size binary input', async () => {
  const f = fixture();
  assert.equal((await f.files.put('max.bin', new Uint8Array(MAX_FILE_BYTES))).size, MAX_FILE_BYTES);
  assert.equal(f.records.get('max.bin').bytes.byteLength, MAX_FILE_BYTES);
  await assert.rejects(f.files.put('oversize.bin', new Uint8Array(MAX_FILE_BYTES + 1)), /15MB/);
  await assert.rejects(f.files.put('empty.bin', new ArrayBuffer(0)), /0바이트/);
  await assert.rejects(f.files.put('text.bin', 'not binary'), /바이너리/);
  await assert.rejects(f.files.put('metadata.bin', content, { httpMetadata: { contentType: 'a'.repeat(1024) } }), /1KB/);
  await assert.rejects(f.files.put('invalid-type.bin', content, { httpMetadata: { contentType: 'image/png\n' } }), /메타데이터/);
  assert.deepEqual(f.writes, ['max.bin']);
});

test('KV stops and cancels invalid or oversized binary streams before storing an incomplete file', async () => {
  const f = fixture(); let cancelled = 0;
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_FILE_BYTES)); controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled++; } });
  await assert.rejects(f.files.put('large.bin', oversized), /15MB/);
  assert.equal(cancelled, 1); assert.equal(oversized.locked, false);
  const nonBinary = new ReadableStream({ start(controller) { controller.enqueue('text'); }, cancel() { cancelled++; } });
  await assert.rejects(f.files.put('text.bin', nonBinary), /바이너리/);
  assert.equal(cancelled, 2); assert.equal(nonBinary.locked, false);
  const broken = new ReadableStream({ start(controller) { controller.error(new Error('source failure')); } });
  await assert.rejects(f.files.put('broken.bin', broken), /source failure/);
  assert.equal(broken.locked, false);
  assert.equal(f.writes.length, 0);
});

test('KV propagates storage failures rather than returning a false write receipt or treating them as missing files', async () => {
  const f = fixture();
  f.namespace.put = async () => { throw new Error('write failed'); };
  await assert.rejects(f.files.put('fail.bin', content), /write failed/);
  assert.equal(f.reads.length, 0);
  f.namespace.getWithMetadata = async () => { throw new Error('read failed'); };
  await assert.rejects(f.files.get('fail.bin'), /read failed/);
  await assert.rejects(f.files.head('fail.bin'), /read failed/);
  f.namespace.delete = async () => { throw new Error('delete failed'); };
  await assert.rejects(f.files.delete('fail.bin'), /delete failed/);
  assert.throws(() => createKVFiles(null), /KV 저장소 연결/);
});

test('KV delete supports one key or a validated array without partial deletion on invalid input', async () => {
  const f = fixture();
  await f.files.put('one.bin', content); await f.files.put('two.bin', content);
  await assert.rejects(f.files.delete(['one.bin', '../bad']), /저장 키/);
  assert.equal(f.deletions.length, 0);
  await f.files.delete('one.bin');
  await f.files.delete(['two.bin', 'already-missing.bin']);
  assert.deepEqual(f.deletions, ['one.bin', 'two.bin', 'already-missing.bin']);
  assert.equal(f.records.size, 0);
});

import { MAX_FILE_BYTES } from '../edu-shared.mjs';

const encoder = new TextEncoder();
const invalidKey = () => new Error('올바르지 않은 파일 저장 키입니다.');

function checkedKey(key) {
  if (typeof key !== 'string' || !key || encoder.encode(key).byteLength > 512
      || /[\\\u0000-\u001f\u007f]/.test(key) || /[\uD800-\uDFFF]/u.test(key) || /^[a-z]:/i.test(key)
      || key.split('/').some(part => !part || part === '.' || part === '..')) throw invalidKey();
  return key;
}

function checkedSize(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) throw new Error('저장 파일은 0바이트를 초과하고 15MB 이하여야 합니다.');
  return size;
}

function checkedMetadata(size, contentType) {
  checkedSize(size);
  if (typeof contentType !== 'string' || !contentType || /[^\x20-\x7e]/.test(contentType)) throw new Error('파일 형식 메타데이터를 확인해 주세요.');
  const metadata = { size, contentType };
  if (encoder.encode(JSON.stringify(metadata)).byteLength > 1024) throw new Error('파일 메타데이터가 1KB를 초과했습니다.');
  return metadata;
}

async function binaryBytes(source) {
  if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    checkedSize(bytes.byteLength);
    // Copy a view's exact byte range, never its unrelated backing-buffer bytes.
    return bytes.slice();
  }
  if (!source || typeof source.getReader !== 'function') throw new Error('파일 원본은 바이너리 또는 읽기 스트림이어야 합니다.');
  const reader = source.getReader(), chunks = [];
  let size = 0, complete = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { complete = true; break; }
      if (!(next.value instanceof Uint8Array)) throw new Error('파일 스트림에 바이너리가 아닌 값이 있습니다.');
      size += next.value.byteLength;
      if (size > MAX_FILE_BYTES) checkedSize(size);
      chunks.push(next.value.slice());
    }
    checkedSize(size);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// API-compatible file storage over Workers KV. Every submitted file gets a new
// immutable key; a successful put is the write receipt, not a visibility check.
export function createKVFiles(namespace) {
  if (!namespace || ['put', 'getWithMetadata', 'delete'].some(method => typeof namespace[method] !== 'function')) throw new Error('수료증 KV 저장소 연결이 필요합니다.');

  async function get(key) {
    checkedKey(key);
    // The minimum documented cacheTtl limits negative-lookup caching, while
    // still acknowledging that a recently written file may not yet be visible.
    const result = await namespace.getWithMetadata(key, { type: 'stream', cacheTtl: 30 });
    if (result?.value == null) return null;
    const body = result.value;
    try {
      if (typeof body.getReader !== 'function' || typeof body.cancel !== 'function') throw new Error('저장된 파일 스트림을 확인할 수 없습니다.');
      const metadata = result.metadata;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('저장된 파일 메타데이터를 확인할 수 없습니다.');
      const validated = checkedMetadata(metadata.size, metadata.contentType);
      return { key, size: validated.size, httpMetadata: { contentType: validated.contentType }, body };
    } catch (error) {
      if (typeof body.cancel === 'function') await body.cancel().catch(() => {});
      throw error;
    }
  }

  return {
    consistency: 'eventual',
    async put(key, source, options = {}) {
      checkedKey(key);
      const bytes = await binaryBytes(source);
      const contentType = options.httpMetadata?.contentType;
      const metadata = checkedMetadata(bytes.byteLength, contentType === undefined ? 'application/octet-stream' : contentType);
      await namespace.put(key, bytes.buffer, { metadata });
      return { key, size: metadata.size, httpMetadata: { contentType: metadata.contentType } };
    },
    get,
    async head(key) {
      const object = await get(key);
      if (!object) return null;
      try { return { key: object.key, size: object.size, httpMetadata: object.httpMetadata }; }
      finally { await object.body.cancel(); }
    },
    async delete(key) {
      const keys = (Array.isArray(key) ? key : [key]).map(checkedKey);
      await Promise.all(keys.map(value => namespace.delete(value)));
    },
  };
}

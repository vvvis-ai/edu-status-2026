// ZIP32 store streams: files pass through without accumulating the archive in memory.
const encoder = new TextEncoder();
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function header(length, fields) {
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  for (const [offset, value, size = 4] of fields) size === 2 ? view.setUint16(offset, value, true) : view.setUint32(offset, value, true);
  return bytes;
}
function dosTime(date = new Date()) {
  return {time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()};
}
async function* chunks(source) {
  if (source instanceof Uint8Array) { yield source; return; }
  if (source instanceof ArrayBuffer) { yield new Uint8Array(source); return; }
  if (!source?.getReader) throw new Error('ZIP 파일 원본을 읽을 수 없습니다.');
  const reader = source.getReader();
  try { while (true) { const {done, value} = await reader.read(); if (done) break; yield value; } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function* zipChunks(entries) {
  if (entries.length > 65535) throw new Error('한 번에 내려받을 수 있는 파일 수를 초과했습니다.');
  const central = [], stamp = dosTime(); let offset = 0;
  for (const entry of entries) {
    // Backslashes and drive prefixes are paths on Windows ZIP extractors too.
    if (typeof entry.name !== 'string' || /[\\\u0000-\u001f]/.test(entry.name) || /^[a-z]:/i.test(entry.name)) throw new Error('올바르지 않은 ZIP 파일명입니다.');
    const name = encoder.encode(entry.name), start = offset;
    if (!name.length || name.length > 65535 || entry.name.startsWith('/') || entry.name.split('/').includes('..')) throw new Error('올바르지 않은 ZIP 파일명입니다.');
    const local = header(30, [[0,0x04034b50],[4,20,2],[6,0x808,2],[8,0,2],[10,stamp.time,2],[12,stamp.date,2],[26,name.length,2]]);
    yield local; yield name; offset += local.length + name.length;
    let crc = 0xffffffff, size = 0;
    for await (const chunk of chunks(await entry.open())) {
      size += chunk.length; offset += chunk.length;
      if (offset > 0x7fffffff || size > 0xffffffff) throw new Error('ZIP 크기가 2GB를 초과했습니다. 교육을 나누어 내려받아 주세요.');
      for (let i = 0; i < chunk.length; i++) crc = crcTable[(crc ^ chunk[i]) & 255] ^ (crc >>> 8);
      yield chunk;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = header(16, [[0,0x08074b50],[4,crc],[8,size],[12,size]]);
    yield descriptor; offset += 16;
    const item = header(46, [[0,0x02014b50],[4,20,2],[6,20,2],[8,0x808,2],[10,0,2],[12,stamp.time,2],[14,stamp.date,2],[16,crc],[20,size],[24,size],[28,name.length,2],[42,start]]);
    central.push(item, name);
  }
  const centralOffset = offset;
  for (const chunk of central) { yield chunk; offset += chunk.length; }
  yield header(22, [[0,0x06054b50],[8,entries.length,2],[10,entries.length,2],[12,offset-centralOffset],[16,centralOffset]]);
}
export function createZip(entries) {
  const iterator = zipChunks(entries);
  return new ReadableStream({async pull(controller) {
    try { const next = await iterator.next(); next.done ? controller.close() : controller.enqueue(next.value); }
    catch (error) { controller.error(error); }
  }, async cancel() { await iterator.return(); }});
}

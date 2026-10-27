import assert from 'node:assert/strict';

// Independent, bit-at-a-time IEEE CRC-32 oracle (no production lookup table).
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

// Read ZIP central-directory records rather than searching payload bytes for PK.
// This also checks local headers, stream descriptors, offsets and file CRCs.
export function readStoredZip(value) {
  const bytes = Buffer.from(value);
  const end = bytes.length - 22;
  assert.ok(end >= 0, 'ZIP has an end record');
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 4), 0, 'single-disk archive');
  assert.equal(bytes.readUInt16LE(end + 6), 0);
  assert.equal(bytes.readUInt16LE(end + 20), 0, 'no archive comment');
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  assert.equal(centralOffset + centralSize, end);
  const result = new Map();
  let position = centralOffset, nextLocal = 0;
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(position), 0x02014b50);
    const flags = bytes.readUInt16LE(position + 8);
    assert.equal(flags, 0x808, 'UTF-8 filenames and trailing data descriptors');
    assert.equal(bytes.readUInt16LE(position + 10), 0, 'stored file');
    const crc = bytes.readUInt32LE(position + 16);
    const size = bytes.readUInt32LE(position + 20);
    assert.equal(size, bytes.readUInt32LE(position + 24));
    const nameSize = bytes.readUInt16LE(position + 28);
    const extraSize = bytes.readUInt16LE(position + 30);
    const commentSize = bytes.readUInt16LE(position + 32);
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameSize);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    const local = bytes.readUInt32LE(position + 42);
    assert.equal(local, nextLocal, 'local offsets cover every entry without gaps');
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 6), flags);
    assert.equal(bytes.readUInt16LE(local + 8), 0);
    assert.equal(bytes.readUInt16LE(local + 26), nameSize);
    assert.deepEqual(bytes.subarray(local + 30, local + 30 + nameSize), nameBytes);
    const start = local + 30 + nameSize + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), crc, `valid payload CRC: ${name}`);
    const descriptor = start + size;
    assert.equal(bytes.readUInt32LE(descriptor), 0x08074b50);
    assert.equal(bytes.readUInt32LE(descriptor + 4), crc);
    assert.equal(bytes.readUInt32LE(descriptor + 8), size);
    assert.equal(bytes.readUInt32LE(descriptor + 12), size);
    assert.equal(result.has(name), false, `unique filename: ${name}`);
    result.set(name, data);
    nextLocal = descriptor + 16;
    position += 46 + nameSize + extraSize + commentSize;
  }
  assert.equal(position, end);
  assert.equal(nextLocal, centralOffset);
  return result;
}

export async function collect(stream) {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

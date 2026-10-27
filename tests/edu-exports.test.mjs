import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip } from '../edu-zip.mjs';
import { createZip as createServerZip } from '../server/zip.mjs';
import { createWorkbook } from '../edu-workbook.mjs';
import { collect, crc32, readStoredZip } from './helpers/archive.mjs';

const encode = value => new TextEncoder().encode(value);

test('ZIP round-trip preserves Korean filenames, binary bytes, empty files and independent CRC-32', async () => {
  assert.equal(crc32(encode('123456789')), 0xcbf43926, 'standard CRC-32 check vector');
  const binary = Uint8Array.from({ length: 513 }, (_, index) => index % 256);
  for (const zip of [createZip, createServerZip]) {
    const files = readStoredZip(await collect(zip([
      { name: '개인정보 교육/승인/총무팀_가상직원_수료증.pdf', open: async () => encode('123456789') },
      { name: '사진/수료 사진 🏫.png', open: async () => new ReadableStream({ start(controller) {
        controller.enqueue(binary.subarray(0, 1)); controller.enqueue(binary.subarray(1, 300));
        controller.enqueue(binary.subarray(300)); controller.close();
      } }) },
      { name: 'empty.txt', open: async () => new ArrayBuffer(0) },
    ])));
    assert.deepEqual([...files.keys()], ['개인정보 교육/승인/총무팀_가상직원_수료증.pdf', '사진/수료 사진 🏫.png', 'empty.txt']);
    assert.equal(files.get('개인정보 교육/승인/총무팀_가상직원_수료증.pdf').toString(), '123456789');
    assert.deepEqual(files.get('사진/수료 사진 🏫.png'), Buffer.from(binary));
    assert.equal(files.get('empty.txt').length, 0);
  }
  assert.equal(readStoredZip(await collect(createZip([]))).size, 0);
});

test('ZIP opens sources only as consumed and releases the active source on cancellation', async () => {
  const opened = []; let cancelled = false;
  const reader = createZip([
    { name: 'first.bin', open: async () => {
      opened.push('first');
      return new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { cancelled = true; } });
    } },
    { name: 'second.bin', open: async () => { opened.push('second'); return new Uint8Array([4]); } },
  ]).getReader();
  assert.equal((await reader.read()).value.length, 30);
  assert.deepEqual(opened, []);
  await reader.read(); // filename
  assert.deepEqual([...(await reader.read()).value], [1, 2, 3]);
  assert.deepEqual(opened, ['first']);
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.deepEqual(opened, ['first']);
});

test('ZIP rejects unsafe archive paths, excessive entry counts and failed source reads', async () => {
  for (const name of ['', '/absolute.pdf', '../escape.pdf', 'education/../escape.pdf', '..\\escape.pdf', 'C:\\escape.pdf', 'bad\u0000name.pdf']) {
    await assert.rejects(collect(createZip([{ name, open: async () => new Uint8Array([1]) }])), /ZIP 파일명/, name);
  }
  await assert.rejects(collect(createZip(Array(65536).fill({ name: 'file', open: async () => new Uint8Array() }))), /파일 수/);
  await assert.rejects(collect(createZip([{ name: 'missing.pdf', open: async () => { throw new Error('source missing'); } }])), /source missing/);
  await assert.rejects(collect(createZip([{ name: 'invalid.pdf', open: async () => null }])), /원본을 읽을 수 없습니다/);
});

const unescapeXml = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity]));
function worksheetCells(xml) {
  const cells = new Map();
  for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const reference = /\br="([A-Z]+\d+)"/.exec(match[1])?.[1];
    assert.ok(reference, 'worksheet cell has an address');
    const inline = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(match[2]);
    const numeric = /<v>([^<]*)<\/v>/.exec(match[2]);
    assert.ok(inline || numeric, `cell ${reference} contains a value`);
    cells.set(reference, inline ? unescapeXml(inline[1]) : Number(numeric[1]));
  }
  return cells;
}

test('XLSX contains connected OOXML parts and round-trips Korean text, numbers and literal formula-like input', async () => {
  const header = ['이름', '팀', '이수율', '설명', '빈 값', '메모'];
  const wideHeader = Array.from({ length: 28 }, (_, index) => header[index] || `교육 ${index + 1}`);
  const values = ['가상직원', '총무 & 교육 <팀>', 0.75, '=HYPERLINK("https://example.com")', null, ' 첫 줄\n둘째 줄 "인용" \'작은따옴표\' \u0001'];
  const files = readStoredZip(await collect(createWorkbook([wideHeader, values])));
  assert.deepEqual([...files.keys()].sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort());
  const part = name => files.get(name).toString('utf8');
  assert.match(part('[Content_Types].xml'), /PartName="\/xl\/worksheets\/sheet1.xml"/);
  assert.match(part('_rels/.rels'), /Target="xl\/workbook.xml"/);
  assert.match(part('xl/workbook.xml'), /name="교육 이수 현황" sheetId="1" r:id="rId1"/);
  assert.match(part('xl/_rels/workbook.xml.rels'), /Id="rId1"[^>]*Target="worksheets\/sheet1.xml"/);
  assert.match(part('xl/_rels/workbook.xml.rels'), /Target="styles.xml"/);
  const sheet = part('xl/worksheets/sheet1.xml');
  const cells = worksheetCells(sheet);
  assert.equal(cells.get('A1'), '이름');
  assert.equal(cells.get('AB1'), '교육 28');
  assert.equal(cells.get('A2'), '가상직원');
  assert.equal(cells.get('B2'), values[1]);
  assert.equal(cells.get('C2'), 0.75);
  assert.equal(cells.get('D2'), values[3]);
  assert.equal(cells.get('E2'), '');
  assert.equal(cells.get('F2'), values[5].replace('\u0001', ''));
  assert.doesNotMatch(sheet, /<f[ >]/, 'user text cannot become an executable spreadsheet formula');
  assert.match(sheet, /dimension ref="A1:AB2"/);
  assert.match(sheet, /state="frozen"/);
  assert.match(sheet, /autoFilter ref="A1:AB2"/);
});

test('empty XLSX stays a valid workbook with one-cell extent and no invalid filter range', async () => {
  const files = readStoredZip(await collect(createWorkbook([])));
  const sheet = files.get('xl/worksheets/sheet1.xml').toString();
  assert.match(sheet, /dimension ref="A1:A1"/);
  assert.doesNotMatch(sheet, /autoFilter/);
  assert.equal(worksheetCells(sheet).size, 0);
});

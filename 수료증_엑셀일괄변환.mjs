import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import parser from './certificate-parser.js';

export const extractNameFromFilename = parser.extractNameFromFilename;

export async function extractPdfInfo(filepath, defaultDept = '평생교육과') {
  const filename = path.basename(filepath);
  if (path.extname(filepath).toLowerCase() !== '.pdf') {
    const fields = parser.extractFields(filename, '', defaultDept);
    return {...fields, filename, completionDate: fields.date, status:'이미지(확인필요)'};
  }
  const task = pdfjs.getDocument({data:new Uint8Array(fs.readFileSync(filepath)),isEvalSupported:false});
  try {
    const pdf = await task.promise;
    const pages = [];
    let hasImagePage = false;
    for (let n=1;n<=pdf.numPages;n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = parser.linesFromTextItems(content.items,page.getViewport({scale:1})).join('\n');
      if ((text.match(/[가-힣]/g) || []).length < 20) hasImagePage = true;
      pages.push(text);
      page.cleanup();
    }
    const rawText=pages.join('\n\n');
    const fields=parser.extractFields(filename,rawText,defaultDept);
    return {...fields,filename,rawText,completionDate:fields.date,
      status:hasImagePage ? '이미지(HTML에서 OCR 필요)' : fields.missingFields.length ? '확인필요(HTML에서 OCR 보완)' : '정상완료'};
  } finally { await task.destroy(); }
}

async function main() {
  console.log('=====================================================');
  console.log('📑 교육수료증 정보 자동 추출 및 엑셀 일괄 취합');
  console.log('=====================================================');

  const supportedExts = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp'];
  function findFiles(dir) {
    let list = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory() && !ent.name.startsWith('.') && !['node_modules','vendor','tests','scripts'].includes(ent.name)) {
        list = list.concat(findFiles(full));
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (supportedExts.includes(ext)) list.push(full);
      }
    }
    return list;
  }

  const fileList = findFiles('.');
  if (fileList.length === 0) {
    console.log('⚠️ 분석할 수료증 파일이 없습니다.');
    return;
  }

  console.log(`발견된 수료증 파일: ${fileList.length}건 (PDF 및 이미지) 분석 중...\n`);

  const results = [];
  for (const p of fileList) {
    try {
      const item = await extractPdfInfo(p, '평생교육과');
      results.push(item);
      const icon = item.status === '정상완료' ? '✅' : '🖼️';
      console.log(`${icon} [${item.status}] ${item.name.padEnd(4, ' ')} | ${item.dept.padEnd(12, ' ')} | ${item.course} | ${item.hours} | ${item.filename}`);
    } catch (err) {
      console.error(`❌ [오류] ${path.basename(p)}: ${err.message}`);
    }
  }

  const headers = ['연번', '부서(명)', '성명', '교육기관', '교육과정명', '교육기간', '교육시간(인정시간)', '파일명', '분석상태'];
  const rows = results.map((d, i) => [
    i + 1,
    `"${(d.dept || '').replace(/"/g, '""')}"`,
    `"${(d.name || '').replace(/"/g, '""')}"`,
    `"${(d.org || '').replace(/"/g, '""')}"`,
    `"${(d.course || '').replace(/"/g, '""')}"`,
    `"${(d.period || '').replace(/"/g, '""')}"`,
    `"${(d.hours || '').replace(/"/g, '""')}"`,
    `"${(d.filename || '').replace(/"/g, '""')}"`,
    `"${(d.status || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outFilename = `교육수료증_취합결과_${today}.csv`;
  fs.writeFileSync(outFilename, csvContent, 'utf8');

  console.log('\n=====================================================');
  console.log(`🎉 취합 완료! 결과 파일이 갱신되었습니다: ${outFilename}`);
  console.log('엑셀에서 더블클릭하면 서식 표로 바로 열립니다.');
  console.log('=====================================================');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

export const publicAssets = [
  'edustatus_all.html','edustatus_admin.html','edu-style.css','edu-client.mjs','edu-shared.mjs',
  'edu-public.mjs','edu-admin.mjs','edu-department.mjs','edu-workbook.mjs','edu-zip.mjs',
  'edu-certificate-import.mjs','edu-certificate-match.mjs','edu-certificate-reader.mjs','edu-ocr-worker.js',
  'certificate-parser.js','certificate-ocr.js','vendor/pdf.min.js','vendor/pdf.worker.min.js','vendor/PDFJS-LICENSE.txt',
];

const pagePolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
const cdn = 'https://cdn.jsdelivr.net/npm';
const core = `${cdn}/tesseract.js-core@5.1.1/`;
const workerPolicy = `default-src 'none'; script-src 'wasm-unsafe-eval' ${cdn}/tesseract.js@5.1.1/dist/worker.min.js ${core}; connect-src ${core} ${cdn}/@tesseract.js-data/kor@1.0.0/4.0.0_best_int/kor.traineddata.gz`;

export const staticPolicy = pathname => pathname === '/edu-ocr-worker.js' ? workerPolicy : pagePolicy;

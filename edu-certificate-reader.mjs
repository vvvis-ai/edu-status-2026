import './certificate-parser.js';
import './certificate-ocr.js';

const parser = globalThis.CertificateParser;
const {cleanPixels} = globalThis.CertificateOcr;
const cdn = 'https://cdn.jsdelivr.net/npm';
const requiredFields = ['name', 'course', 'date'];
const maxImageEdge = 2800;
const missing = value => !value || value === '확인 필요';

function loadPdfEngine() {
  if (globalThis.pdfjsLib) return Promise.resolve(globalThis.pdfjsLib);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./vendor/pdf.min.js', import.meta.url);
    script.onload = () => {
      const pdfjs = globalThis.pdfjsLib;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.js', import.meta.url).href;
      resolve(pdfjs);
    };
    script.onerror = () => { script.remove(); reject(new Error('PDF 판독 도구를 불러오지 못했습니다.')); };
    document.head.append(script);
  });
}

// Tesseract.js 5.1.1 worker messages. The engine runs in its own worker and
// receives only the temporary recognition image, with no access to the page.
function startOcr(signal) {
  const worker = new Worker(new URL('./edu-ocr-worker.js', import.meta.url));
  const stop = () => worker.terminate();
  signal.addEventListener('abort', stop, {once:true});
  let sequence = 0;
  function call(action, payload, timeout = 45000) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const jobId = `ocr-${++sequence}`;
      const finish = (callback, value) => {
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => finish(reject, signal.reason);
      const onError = () => finish(reject, new Error('OCR 도구를 실행하지 못했습니다.'));
      const onMessage = ({data}) => {
        if (data.jobId !== jobId) return;
        if (data.status === 'resolve') finish(resolve, data.data);
        if (data.status === 'reject') onError();
      };
      const timer = setTimeout(onError, timeout);
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      signal.addEventListener('abort', onAbort, {once:true});
      worker.postMessage({workerId:'certificate-ocr',jobId,action,payload});
    });
  }
  return {call, close() { signal.removeEventListener('abort', stop); stop(); }};
}

function documentFields(text) {
  // Filename and default department values are not evidence of completion.
  return parser.extractFields('', text, '');
}

function canvasFor(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

export function createCertificateReader(signal) {
  let pdfEngine;
  let ocr;
  let ocrReady;
  async function recognize(canvas, fields) {
    if (!ocrReady) {
      ocrReady = (async () => {
        ocr = startOcr(signal);
        await ocr.call('load', {options:{lstmOnly:true,corePath:`${cdn}/tesseract.js-core@5.1.1`}});
        await ocr.call('loadLanguage', {langs:['kor'],options:{lstmOnly:true,langPath:`${cdn}/@tesseract.js-data/kor@1.0.0/4.0.0_best_int`}});
        await ocr.call('initialize', {langs:['kor'],oem:1});
        await ocr.call('setParameters', {params:{tessedit_pageseg_mode:'6',preserve_interword_spaces:'1'}});
      })().catch(error => { ocr?.close(); throw error; });
    }
    await ocrReady;
    const prepared = canvasFor(canvas.width, canvas.height);
    try {
      const ctx = prepared.getContext('2d', {willReadFrequently:true});
      ctx.drawImage(canvas, 0, 0);
      const image = ctx.getImageData(0, 0, prepared.width, prepared.height);
      image.data.set(cleanPixels(image.data, prepared.width, prepared.height));
      ctx.putImageData(image, 0, 0);
      for (const version of [prepared, canvas]) {
        const blob = await new Promise(resolve => version.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('OCR용 이미지를 만들지 못했습니다.');
        const result = await ocr.call('recognize', {image:new Uint8Array(await blob.arrayBuffer()),options:{},output:{text:true}});
        fields = parser.mergeMissingFields(fields, documentFields(result.text));
        if (requiredFields.every(key => !missing(fields[key]))) break;
      }
      return fields;
    } catch (error) {
      ocr.close();
      ocrReady = null;
      throw error;
    } finally { prepared.width = prepared.height = 0; }
  }

  async function extractPdf(file) {
    pdfEngine ||= loadPdfEngine();
    const pdfjs = await pdfEngine;
    signal.throwIfAborted();
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    const task = pdfjs.getDocument({data:bytes,isEvalSupported:false,useWasm:false});
    const cancel = () => { void task.destroy().catch(() => {}); };
    signal.addEventListener('abort', cancel, {once:true});
    const pages = [];
    let usedOcr = false;
    let ocrFailed = false;
    try {
      const pdf = await task.promise;
      for (let number = 1; number <= pdf.numPages; number++) {
        signal.throwIfAborted();
        const page = await pdf.getPage(number);
        const base = page.getViewport({scale:1});
        const content = await page.getTextContent();
        let fields = documentFields(parser.linesFromTextItems(content.items, base).join('\n'));
        if (requiredFields.some(key => missing(fields[key]))) {
          const viewport = page.getViewport({scale:Math.min(3, maxImageEdge / Math.max(base.width, base.height))});
          const canvas = canvasFor(viewport.width, viewport.height);
          try {
            await page.render({canvas, viewport}).promise;
            fields = await recognize(canvas, fields);
            usedOcr = true;
          } catch (error) {
            signal.throwIfAborted();
            ocrFailed = true;
          } finally { canvas.width = canvas.height = 0; }
        }
        pages.push(fields);
        page.cleanup();
      }
      return combineCertificatePages(pages, usedOcr, ocrFailed);
    } finally {
      signal.removeEventListener('abort', cancel);
      await task.destroy();
    }
  }

  return {
    async read(file) {
      if (/\.pdf$/i.test(file.name)) return extractPdf(file);
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(2, maxImageEdge / Math.max(bitmap.width, bitmap.height));
      const canvas = canvasFor(bitmap.width * scale, bitmap.height * scale);
      try {
        signal.throwIfAborted();
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        try { return combineCertificatePages([await recognize(canvas, {})], true, false); }
        catch (error) { signal.throwIfAborted(); return combineCertificatePages([], false, true); }
      } finally { bitmap.close(); canvas.width = canvas.height = 0; }
    },
    close() { ocr?.close(); },
  };
}

function combineCertificatePages(pages, usedOcr, ocrFailed) {
  const distinct = (items, key) => [...new Map(items.map(page => page[key]).filter(value => !missing(value))
    .map(value => [value.normalize('NFKC').replace(/\s/g, '').toLowerCase(), value])).values()];
  const names = distinct(pages, 'name');
  const courses = distinct(pages, 'course');
  const dates = distinct(pages.filter(page => !missing(page.name) || !missing(page.course)), 'date');
  return {
    name:names.length === 1 ? names[0] : '', course:courses.length === 1 ? courses[0] : '',
    date:dates.length === 1 ? dates[0] : '', source:usedOcr ? 'OCR' : 'PDF 텍스트', ocrFailed,
    blocked:names.length > 1 || courses.length > 1,
  };
}

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const parser = require('../certificate-parser.js');

test('sample PDF keeps both training dates independently of completion and issue dates', async()=>{
  const filename='폭력예방교육 수료증(가나준).pdf';
  const text=fs.readFileSync('tests/fixtures/period-native.txt','utf8');
  const result=parser.extractFields(filename,text);
  assert.equal(result.period,'2026.02.26 ~ 2026.02.27');
  assert.equal(result.name,'가나준');
  assert.deepEqual(result.missingFields,[]);
  const differentDates=parser.extractFields('',text+'\n수료일: 2026-02-28\n발급일: 2026-03-01');
  assert.equal(differentDates.period,result.period);
});

test('period labels, date formats, wrapped ranges and single-day training',()=>{
  for(const label of ['교육기간','수강기간','학습기간','기간']) {
    for(const range of ['2026.2.6. ~ 2026.2.7.','2026/2/6 ~ 2026/2/7','2026년 2월 6일 ~ 2026년 2월 7일','\n2026-02-06 ~\n2026-02-07','2026-02-06\n~ 2026-02-07']) {
      assert.equal(parser.extractFields('',`${label}: ${range}`).period,'2026.02.06 ~ 2026.02.07');
    }
  }
  assert.equal(parser.extractFields('', '교육기간: 2026-02-06').period,'2026.02.06 ~ 2026.02.06');
  for(const text of ['수료일: 2026-02-06','발급일: 2026-02-06','기간: 2026-02-07 ~ 2026-02-06','기간: 2026-02-06 ~ 2026-02-30','기간: 2026-02-06-2026-02-30','기간: 2026-02-06 ~']) {
    const result=parser.extractFields('',text);
    assert.equal(result.period,'확인 필요',text);
    assert.ok(result.missingFields.includes('period'));
  }
});

test('OCR fills missing period and preserves native or manually edited periods',()=>{
  const native=parser.extractFields('', '수료일: 2026-03-01');
  const ocr=parser.extractFields('', '기간: 2026-02-26 ~ 2026-02-27');
  assert.equal(parser.mergeMissingFields(native,ocr).period,ocr.period);
  assert.equal(parser.mergeMissingFields({...native,period:'2026.01.01 ~ 2026.01.02'},ocr).period,'2026.01.01 ~ 2026.01.02');
});

test('HTML table, workbook and clipboard export the editable training period',async()=>{
  const {context,elements}=htmlContext();
  const fields=parser.extractFields('sample.pdf',fs.readFileSync('tests/fixtures/period-native.txt','utf8'));
  context.sample={...fields,id:'sample',filename:'sample.pdf',status:'success'};
  vm.runInContext('parsedData = [sample]; renderTable()',context);
  assert.ok(elements.get('tableBody').innerHTML.includes('2026.02.26 ~ 2026.02.27'));
  context.updateField('sample','period','2026.02.25 ~ 2026.02.27');
  let workbook,clipboard;
  context.XLSX={utils:{aoa_to_sheet:rows=>({rows}),book_new:()=>({}),book_append_sheet:(wb,sheet)=>{wb.sheet=sheet;}},writeFile:wb=>{workbook=wb;}};
  context.navigator={clipboard:{writeText:async text=>{clipboard=text;}}};
  context.exportToExcel();
  context.copyTableToClipboard();
  assert.equal(workbook.sheet.rows[0][5],'교육기간');
  assert.equal(workbook.sheet.rows[1][5],'2026.02.25 ~ 2026.02.27');
  assert.ok(workbook.sheet['!cols'][5].wch>=25);
  assert.equal(clipboard.split('\n')[0].split('\t')[5],'교육기간');
  assert.equal(clipboard.split('\n')[1].split('\t')[5],'2026.02.25 ~ 2026.02.27');
});

test('previous certificate layout: all six fields are read from a portable synthetic fixture without OCR', () => {
  const filename='적극행정 수료증(가나영).pdf';
  const result=parser.extractFields(filename,fs.readFileSync('tests/fixtures/administration-native.txt','utf8'));
  assert.deepEqual(Object.fromEntries(['name','dept','org','course','date','hours'].map(k=>[k,result[k]])), {
    name:'가나영',dept:'예시교육과',org:'가상광역시인재개발원',
    course:'제 7 기 국민의 생활을 바꾸는 적극행정',date:'2026-08-10',hours:'50분'
  });
  assert.deepEqual(result.missingFields,[]);
});

test('spaced labels, multiline course and issuer, fractional hours, date priority',()=>{
  const result=parser.extractFields('certificate.pdf',`성 명 : 홍길동
교 육 과 정 명 : 현장에서 배우는
적극행정 실무
교 육 기 간 : 2026. 08. 01. ~ 2026. 08. 10.
수 료 일 : 2026/08/09
교 육 시 간 : 1.5 시간
2026년 09월 14일
부 산 광 역 시 인 재 개 발 원 장`);
  assert.equal(result.course,'현장에서 배우는 적극행정 실무');
  assert.equal(result.org,'부산광역시인재개발원');
  assert.equal(result.date,'2026-08-09');
  assert.equal(result.hours,'1.5시간');
  assert.deepEqual(result.missingFields,[]);
});

test('label on next line, field boundaries and combined duration',()=>{
  const result=parser.extractFields('증명서(김철수).pdf',`교육과정명:
개인정보 보호 교육
교육기관: 한국가나다교육원
교육시간: 1 시간 30 분 수료일: 2026-08-10`);
  assert.equal(result.course,'개인정보 보호 교육');
  assert.equal(result.hours,'1시간 30분');
  assert.equal(result.date,'2026-08-10');
  assert.equal(result.org,'한국가나다교육원');
});

test('period end beats later issue date; invalid dates and serial numbers rejected',()=>{
  assert.equal(parser.extractFields('', '기간: 2026-08-01 ~ 2026-08-10\n2026년 09월 14일').date,'2026-08-10');
  assert.equal(parser.extractFields('', '수료일: 2026-02-30\n제 2026-123-456 호').date,'확인 필요');
});

test('unrecognized fields never get unrelated foundation, course or normal status',()=>{
  const fields=parser.extractFields('적극행정 수료증.pdf','소속: 국가공무원인재개발원\n과정: 공무원 민원 대응');
  assert.equal(fields.org,'확인 필요');
  assert.equal(fields.hours,'확인 필요');
  assert.ok(fields.missingFields.length);
  const empty=parser.extractFields('자살예방교육.pdf','');
  assert.equal(empty.org,'확인 필요');
  assert.equal(empty.course,'확인 필요');
  assert.equal(empty.name,'확인 필요');
});

test('PDF draw order and split glyphs are reconstructed into visible lines',()=>{
  const item=(str,x,y,width=10)=>({str,transform:[10,0,0,10,x,y],width,height:10});
  const lines=parser.linesFromTextItems([item('50분',60,100),item('정 : 실무',25,130,60),item('과',0,130),item('교육시간:',0,100,55)]);
  assert.deepEqual(lines,['과 정 : 실무','교육시간: 50분']);
});

test('overprinted bold glyphs are deduplicated without removing adjacent repeats',()=>{
  const item=(str,x,y,width=10)=>({str,transform:[10,0,0,10,x,y],width,height:10});
  assert.deepEqual(parser.linesFromTextItems([
    item('성',0,100),item('성',0.26,100),item('명',20,100),item('명',20.26,100),
    item('하',50,100),item('하',60,100)
  ]),['성 명 하하']);
});

test('privacy PDF: plain table labels, account suffix, course, printed date and credited hours',async()=>{
  const filename='개인정보교육(다라준).pdf';
  const rawText=fs.readFileSync('tests/fixtures/privacy-native.txt','utf8');
  const result={...parser.extractFields(filename,rawText),rawText};
  assert.equal(result.name,'다라준');
  assert.equal(result.dept,'예시교육과');
  assert.equal(result.course,'예시 법정교육! 가상강사의 개인정보 보호');
  assert.equal(result.date,'2026-03-03');
  assert.equal(result.hours,'1.0시간');
  assert.deepEqual(result.missingFields,['org']);
  // Check that the name comes from the body, without a helpful filename.
  assert.equal(parser.extractFields('certificate.pdf',result.rawText).name,'다라준');
});

test('scanned certificate table is parsed from synthetic Korean OCR without hardcoded values',()=>{
  const text=fs.readFileSync('tests/fixtures/privacy-ocr.txt','utf8');
  const result=parser.extractFields('개인정보보호교육 수료증(마바준).pdf',text);
  assert.equal(result.org,'가상정보교육위원회');
  assert.equal(result.name,'마바준');
  assert.equal(result.course,'개인정보 처리자');
  assert.equal(result.hours,'1.1시간');
  assert.equal(result.date,'2026-08-13');
  assert.deepEqual(result.missingFields,[]);
  const other=parser.extractFields('증서(박영수).pdf',text.replace('개인정보 처리자','정보보안 실무').replaceAll('1.1시간','2.5시간').replace('2026년 08월 13잎','2026년 09월 20일'));
  assert.equal(other.course,'정보보안 실무');
  assert.equal(other.hours,'2.5시간');
  assert.equal(other.date,'2026-09-20');
  assert.equal(parser.extractFields('', '교육과정 수강시간\n개인정보 처리자\n총 합계 1시간').course,'확인 필요');
});

test('table with several courses does not mistake one row for total hours',()=>{
  const result=parser.extractFields('', '교육과정 수강시간\n보안 실무 1시간\n개인정보 실무 2시간\n총 합계 3시간');
  assert.equal(result.course,'보안 실무 / 개인정보 실무');
  assert.equal(result.hours,'확인 필요');
});

test('OCR preprocessing removes colored seals, faint marks and long rules but preserves dark glyphs',()=>{
  const {cleanPixels}=require('../certificate-ocr.js');
  const width=1000,height=1000,data=new Uint8ClampedArray(width*height*4).fill(255);
  const pixel=(x,y,r,g=r,b=r)=>data.set([r,g,b,255],(y*width+x)*4);
  pixel(10,10,200,30,30);pixel(20,20,220);pixel(30,30,100);
  for(let x=100;x<800;x++)pixel(x,200,80);
  for(let y=150;y<500;y++)pixel(400,y,80);
  for(let y=600;y<630;y++)pixel(600,y,0);
  const clean=cleanPixels(data,width,height);
  assert.equal(clean[(10*width+10)*4],255);
  assert.equal(clean[(20*width+20)*4],255);
  assert.equal(clean[(30*width+30)*4],0);
  assert.equal(clean[(200*width+500)*4],255);
  assert.equal(clean[(300*width+400)*4],255);
  assert.equal(clean[(610*width+600)*4],0);
  assert.equal(data[(200*width+500)*4],80,'original unchanged');
});

test('OCR retries only for missing data, preserves recovered fields and terminates worker',async()=>{
  const ocr=require('../certificate-ocr.js');
  const text=fs.readFileSync('tests/fixtures/privacy-ocr.txt','utf8');
  let calls=0,terminated=0,mixed=0,mode;
  const ctx={drawImage(){},getImageData:()=>({data:new Uint8ClampedArray([255,255,255,255])}),putImageData(){}};
  const options={canvas:{width:1,height:1},parser,filename:'증서(마바준).pdf',document:{createElement:()=>({getContext:()=>ctx})},
    Tesseract:{createWorker:async()=>({setParameters:async p=>{mode=p.tessedit_pageseg_mode;},recognize:async()=>{calls++;return {data:{text}};},reinitialize:async()=>{mixed++;},terminate:async()=>{terminated++;}})}};
  const complete=await ocr.recognize(options);
  assert.equal(complete.fields.course,'개인정보 처리자');
  assert.equal(calls,1);assert.equal(mode,'6');assert.equal(terminated,1);
  options.Tesseract.createWorker=async()=>({setParameters:async()=>{},recognize:async()=>({data:{text:++calls===2?'과정명: 먼저 읽은 과정':'교육기관: 테스트교육원\n과정명: 오독\n교육시간: 50분\n교육기간: 2026-08-13\n수료일: 2026-08-13'}}),reinitialize:async()=>{mixed++;},terminate:async()=>{terminated++;}});
  const fallback=await ocr.recognize(options);
  assert.equal(calls,3);assert.equal(fallback.fields.course,'먼저 읽은 과정');assert.equal(fallback.fields.org,'테스트교육원');assert.equal(mixed,0);
  options.Tesseract.createWorker=async()=>({setParameters:async()=>{},recognize:async()=>{throw Error('recognition failed');},terminate:async()=>{terminated++;}});
  await assert.rejects(ocr.recognize(options),/recognition failed/);
  assert.equal(terminated,3);
});

test('clock durations and corporate issuer OCR; no guesses from affiliation',()=>{
  assert.equal(parser.extractFields('', '과정시간 1:02:02').hours,'1시간 2분 2초');
  assert.equal(parser.extractFields('', '학습시간 0:50:00').hours,'50분');
  assert.equal(parser.extractFields('', '과정시간 1:72:00').hours,'확인 필요');
  assert.equal(parser.extractFields('', '학습시간 1:02:02 (총 1.0 시간)').hours,'1.0시간');
  assert.equal(parser.extractFields('', '(주)유밥 대표이사').org,'(주)유밥');
  assert.equal(parser.extractFields('', '㈜ 유밥 대표 이사').org,'(주)유밥');
  assert.equal(parser.extractFields('', '소속 (주)유밥').org,'확인 필요');
  assert.equal(parser.extractFields('', '위 사람은 유밥에서 실시하는\n상기 교육과정을 수료하였으므로').org,'유밥');
  assert.equal(parser.extractFields('', '교육과정: 유밥에서 실시하는 교육 소개').org,'확인 필요');
  assert.equal(parser.extractFields('', '과정명 교육시간 관리 실무').course,'교육시간 관리 실무');
});

test('printed date within access period wins, but explicit completion remains first',()=>{
  assert.equal(parser.extractFields('', '교육기간 2026-03-03 ~ 2026-12-31\n2026-03-03').date,'2026-03-03');
  assert.equal(parser.extractFields('', '교육기간 2026-03-03 ~ 2026-12-31\n수료일 2026-04-01\n2026-03-03').date,'2026-04-01');
});

function htmlContext() {
  const html=fs.readFileSync('★교육수료증_자동추출_엑셀변환기.html','utf8');
  const elements=new Map();
  const document={getElementById(id){
    if(!elements.has(id))elements.set(id,{value:id==='defaultDeptInput'?'평생교육과':'YYYY-MM-DD',checked:true,addEventListener(){},classList:{add(){},remove(){}}});
    return elements.get(id);
  }};
  const context=vm.createContext({document,CertificateParser:parser,console,setTimeout:()=>0,Uint8Array});
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  return {context,elements};
}

test('partly readable PDF triggers OCR only for missing fields, preserving native values and manual edits',async()=>{
  const {context,elements}=htmlContext();
  const native='성명: 다라준\n과정명: 프리한 법정교육 개인정보 보호\n교육시간: 1.0 시간\n교육기간: 2026-03-01 ~ 2026-03-03\n수료일: 2026-03-03';
  const items=native.split('\n').map((str,i)=>({str,transform:[10,0,0,10,0,700-i*20],width:200,height:10}));
  let ocrCalls=0,destroyed=0;
  context.loadPdf=async()=>({promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>({items}),getViewport:()=>({scale:1,transform:[1,0,0,-1,0,800]}),cleanup(){}})}),destroy:async()=>{destroyed++;}});
  context.recognizePdfPage=async(page,item)=>{
    ocrCalls++;
    item.hours='OCR 판독 중 (100%)';
    return '성명: 다라준\n과정명: 오인식 과정\n교육시간: 10시간\n수료일: 2026-12-31\n(주)유밥 대표이사';
  };
  const item={isImage:false};
  await context.parsePdfDocument({name:'certificate.pdf'},item);
  assert.equal(ocrCalls,1);
  assert.equal(item.status,'success');
  assert.equal(item.org,'(주)유밥');
  assert.equal(item.name,'다라준');
  assert.equal(item.hours,'1.0시간');
  assert.equal(item.date,'2026-03-03');
  assert.equal(item.course,'프리한 법정교육 개인정보 보호');
  assert.ok(item.rawText.includes('오인식 과정'));
  item.course='직접 수정한 교육명';
  await context.performOcrOnPdf({name:'certificate.pdf'},item);
  assert.equal(item.course,'직접 수정한 교육명');
  assert.equal(item.hours,'1.0시간');
  context.recognizePdfPage=async(page,item)=>{item.hours='OCR 판독 중';throw new Error('network offline');};
  await context.parsePdfDocument({name:'certificate.pdf'},item);
  assert.equal(item.status,'warning');
  assert.equal(item.hours,'1.0시간');
  assert.equal(item.org,'확인 필요');
  assert.match(item.rawText,/network offline/);
  elements.get('autoOcrCheckbox').checked=false;
  await context.parsePdfDocument({name:'certificate.pdf'},item);
  assert.equal(ocrCalls,2);
  assert.equal(item.status,'warning');
  assert.equal(destroyed,4);
  elements.get('autoOcrCheckbox').checked=true;
  items.push({str:'교육기관: 테스트교육원',transform:[10,0,0,10,0,500],width:200,height:10});
  await context.parsePdfDocument({name:'complete.pdf'},item);
  assert.equal(ocrCalls,2);
  assert.equal(item.status,'success');
  assert.equal(item.org,'테스트교육원');
  assert.equal(destroyed,5);
});

test('HTML uses real PDF engine, awaits scan OCR, and preserves PDF type for retries',async()=>{
  const html=fs.readFileSync('★교육수료증_자동추출_엑셀변환기.html','utf8');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements=new Map();
  const document={getElementById(id){
    if(!elements.has(id))elements.set(id,{value:id==='defaultDeptInput'?'평생교육과':'YYYY-MM-DD',checked:true,addEventListener(){},classList:{add(){},remove(){}}});
    return elements.get(id);
  }};
  const context=vm.createContext({document,CertificateParser:parser,console,setTimeout:()=>0,Uint8Array});
  vm.runInContext(script,context);
  const scanText='성명: 홍길동\n과정: 실무 교육\n교육기관: 테스트교육원\n교육기간: 2026-08-01 ~ 2026-08-10\n수료일: 2026-08-10\n교육시간: 50분';
  let destroyed=false,ocrFinished=false;
  context.loadPdf=async()=>({promise:Promise.resolve({numPages:2,getPage:async()=>({getTextContent:async()=>({items:[]}),getViewport:()=>({scale:1,transform:[1,0,0,-1,0,800]}),cleanup(){}})}),destroy:async()=>{destroyed=true;}});
  context.recognizePdfPage=async()=>{await new Promise(resolve=>setTimeout(resolve,5));ocrFinished=true;return scanText;};
  const item={isImage:false};
  await context.parsePdfDocument({name:'scan.pdf'},item);
  assert.ok(ocrFinished && destroyed);
  assert.equal(item.isImage,false);
  assert.equal(item.status,'success');
  assert.equal(item.hours,'50분');
  assert.equal(item.rawText.split('실무 교육').length-1,2);
  elements.get('autoOcrCheckbox').checked=false;
  await context.parsePdfDocument({name:'scan.pdf'},item);
  assert.equal(item.status,'warning');
  assert.equal(item.org,'확인 필요');
});

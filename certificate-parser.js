(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CertificateParser = api;
})(globalThis, function () {
  'use strict';

  // PDF stream order is not reading order. Group text by its visible baseline.
  function linesFromTextItems(items, viewport) {
    const rows = [];
    for (const item of items) {
      if (!item.str || !item.str.trim() || !item.transform) continue;
      let x = item.transform[4], y = -item.transform[5];
      if (viewport) {
        const [a,b,c,d,e,f] = viewport.transform;
        x = a * item.transform[4] + c * item.transform[5] + e;
        y = b * item.transform[4] + d * item.transform[5] + f;
      }
      const height = (item.height || 10) * (viewport?.scale || 1);
      const fragment = {text:item.str, x, y, width:item.width * (viewport?.scale || 1), height};
      let row = rows.find(r => Math.abs(r.y-y) <= Math.max(2, Math.min(r.height,height)*0.25));
      if (!row) { row = {y,height,parts:[]}; rows.push(row); }
      // Some generators simulate bold by painting the same glyphs twice.
      // Only remove overlapping copies, never repeated words elsewhere in a row.
      const tolerance = Math.max(0.3, height * 0.06);
      if (row.parts.some(p => p.text === fragment.text
          && Math.abs(p.x-x) <= tolerance && Math.abs(p.y-y) <= tolerance
          && Math.abs(p.width-fragment.width) <= tolerance)) continue;
      row.parts.push(fragment);
    }
    return rows.sort((a,b)=>a.y-b.y).map(row => {
      const parts = row.parts.sort((a,b)=>a.x-b.x);
      let text = '', previous;
      for (const part of parts) {
        if (previous && part.x-(previous.x+previous.width) > Math.max(1,part.height*0.12)
            && !/\s$/.test(text) && !/^\s/.test(part.text)) text += ' ';
        text += part.text;
        previous = part;
      }
      return text.replace(/[ \t]+/g,' ').trim();
    }).filter(Boolean);
  }

  const labels = ['상시학습인정시간','교육과정명','교육기관명','교육종료일','교육과정','교육기간','수강기간','학습기간','교육시간','인정시간','학습시간','이수시간','과정시간','수료일자','이수일자','수료일','이수일','발급일','발행일','교육기관','주관기관','발급기관','과정명','과정','기간','성명','이름','부서','소속','직급','직위','생년월일'];
  const spaced = word => [...word].join('[ \\t]*');
  const labelPattern = labels.map(spaced).join('|');
  function normalizeText(text) {
    let normalized = String(text || '').normalize('NFKC').replace(/\r\n?/g,'\n').replace(/[\u200B-\u200D\uFEFF]/g,'');
    for (const label of labels) {
      normalized = normalized.replace(new RegExp(spaced(label)+'(?=[ \\t]*(?:[:：]|$))','gm'),label);
    }
    // Keep adjacent table fields separate, including when PDF text has no newline.
    normalized = normalized.replace(new RegExp('([^\\n])([ \\t]+)('+labelPattern+')[ \\t]*[:：]','g'),'$1\n$3:');
    return normalized;
  }

  function extractNameFromFilename(filename) {
    const base = filename.replace(/\.[^/.]+$/,'');
    const match = /[(\[]([가-힣]{2,4})[)\]]/.exec(base) || /[_\-]([가-힣]{2,4})$/.exec(base);
    return match ? match[1] : '';
  }

  function extractFields(filename, text, defaultDept = '평생교육과') {
    const lines = normalizeText(text).split('\n').map(l=>l.trim()).filter(Boolean);
    const metadata = new RegExp('^(?:[•·*-]\\s*)?('+labelPattern+')(?:[ \\t]*[:：][ \\t]*(.*)|[ \\t]+(.+)|[ \\t]*$)');
    const fields = new Map();
    const isPeriod = key => /^(교육기간|수강기간|학습기간|기간)$/.test(key);
    let active = '';
    for (const line of lines) {
      const match = metadata.exec(line);
      if (match) {
        active = match[1].replace(/\s/g,'');
        fields.set(active,(match[2] || match[3] || '').trim());
      } else if (isPeriod(active) && /^(?:[~〜～–—-]\s*)?(?:19|20)\d{2}\s*[.년/-]/.test(line)
          && (!fields.get(active) || /[~〜～–—-]\s*$/.test(fields.get(active)) || /^[~〜～–—-]/.test(line))) {
        fields.set(active,[fields.get(active),line].filter(Boolean).join(' '));
      } else if (active && (!fields.get(active) || /^(교육과정명|교육과정|과정명|과정)$/.test(active))
          && !/^(위\s*사람|소정의|위와\s*같이|본\s*증|※|\d{4}\s*[.년/-])/.test(line)
          && !/(원장|이사장|총장|센터장|협회장)$/.test(line.replace(/\s/g,''))) {
        fields.set(active,[fields.get(active),line].filter(Boolean).join(' '));
      } else { active = ''; }
    }
    const get = (...keys) => keys.map(k=>fields.get(k)).find(v=>v && v!=='-') || '';
    const name = get('성명','이름').replace(/\s*[([][^)\]]*[)\]]\s*$/, '').replace(/\s/g,'') || extractNameFromFilename(filename);
    let dept = get('부서') || get('소속').replace(/^(부산(?:광역시)?\s*동구(?:청)?\s*|문화체육관광국\s*)/g,'').trim();
    if (!dept) dept = defaultDept;
    let course = get('교육과정명','교육과정','과정명','과정');
    // A two-column course/time table is not a label followed by a value.
    // Accept rows only below an explicit table header, and stop at its total.
    const tableHeader = lines.findIndex(l=>/^(?:교육과정명|교육과정|과정명)\s+(?:수강시간|교육시간|학습시간)$/.test(l.replace(/[ \t]+/g,' ')));
    const tableRows = [];
    if (tableHeader >= 0) {
      for (const line of lines.slice(tableHeader+1)) {
        if (/^(?:총\s*(?:합계|할계)|합계)/.test(line)) break;
        const row = /^(.+?)\s+(\d+(?:\.\d+)?\s*시간(?:\s*\d+\s*분)?|\d+\s*분)\s*$/.exec(line);
        if (!row) break;
        tableRows.push({course:row[1].trim(),hours:row[2]});
      }
      course = tableRows.map(row=>row.course).join(' / ');
    }

    const findDates = source => {
      const dates = [];
      const pattern = /(?<!\d)((?:19|20)\d{2})\s*[.\/년-]\s*(\d{1,2})\s*[.\/월-]\s*(\d{1,2})(?!\d)\s*일?/g;
      for (const m of source.matchAll(pattern)) {
        const y=Number(m[1]), month=Number(m[2]), day=Number(m[3]);
        const date = new Date(Date.UTC(y,month-1,day));
        if (date.getUTCFullYear()===y && date.getUTCMonth()===month-1 && date.getUTCDate()===day)
          dates.push(`${y}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
      }
      return dates;
    };
    // A date printed within an enrollment period can be the actual certificate
    // date (e-learning access may remain open until December). A later issue
    // date still must not replace a completed training period's end date.
    let date = findDates(get('수료일자','수료일','이수일자','이수일','교육종료일')).at(-1);
    const period = findDates(get('교육기간','수강기간','학습기간','기간'));
    const periodText = get('교육기간','수강기간','학습기간','기간');
    const hasRange = /[~〜～–—]|\d\s*\.?\s+-\s+\d/.test(periodText)
      || (periodText.match(/(?:19|20)\d{2}/g) || []).length > 1;
    let trainingPeriod = '확인 필요';
    if (period.length === 2 && period[0] <= period[1]) {
      trainingPeriod = period.map(value=>value.replace(/-/g,'.')).join(' ~ ');
    } else if (period.length === 1 && !hasRange) {
      const day = period[0].replace(/-/g,'.');
      trainingPeriod = `${day} ~ ${day}`;
    }
    const printedDate = findDates(get('발급일','발행일')).at(-1)
      || lines.filter(l=>/^[^가-힣A-Za-z0-9]{0,12}\d{4}\s*[.년/-]/.test(l)).flatMap(findDates).at(-1);
    if (!date && period.length >= 2 && printedDate >= period[0] && printedDate <= period.at(-1)) date = printedDate;
    if (!date) date = period.at(-1) || printedDate;

    const duration = source => {
      const m = /(\d+(?:\.\d+)?)\s*시간(?:\s*(\d+)\s*분)?|(\d+)\s*분/.exec(source);
      if (m) return m[3] !== undefined ? `${m[3]}분` : `${m[1]}시간${m[2] ? ` ${m[2]}분` : ''}`;
      const clock = /(?<![\d:])(\d+):([0-5]\d):([0-5]\d)(?![\d:])/.exec(source);
      if (!clock) return '';
      return [Number(clock[1]) ? `${Number(clock[1])}시간` : '', Number(clock[2]) ? `${Number(clock[2])}분` : '', Number(clock[3]) ? `${Number(clock[3])}초` : ''].filter(Boolean).join(' ') || '0분';
    };
    const hours = ['상시학습인정시간','인정시간','교육시간','학습시간','이수시간','과정시간'].map(k=>duration(get(k))).find(Boolean)
      || (tableRows.length === 1 ? duration(tableRows[0].hours) : '');

    let org = get('교육기관명','교육기관','주관기관','발급기관');
    if (!org) {
      const companyIssuer = [...lines].reverse().find(l=>/^(?:\(주\)|주식회사|㈜).+?\s*대표\s*이사(?:\s+[가-힣]{2,4})?$/.test(l));
      if (companyIssuer) org = companyIssuer.replace(/\s*대표\s*이사.*$/, '').replace(/\s/g,'');
    }
    if (!org) {
      // The seal can obscure the signature; use an explicit provider statement
      // in the certificate body, never an arbitrary occurrence in a title.
      const statement = /(?:^|\n)위\s*사람은\s+([가-힣A-Za-z0-9()· &.-]{2,60}?)에서\s*(?:실시|시행|주관|운영)/.exec(lines.join('\n'));
      if (statement) org = statement[1].trim();
    }
    const knownOrgs = ['한국생명존중희망재단','부산광역시인재개발원','국가공무원인재개발원','한국양성평등교육진흥원','개인정보보호위원회'];
    if (!org) {
      // Only accept a complete issuer line, not words in a course title or affiliation.
      const issuer = [...lines].reverse().find(l=>/^[가-힣A-Za-z()·\s]+(?:인재개발원장|연수원장|교육원장|진흥원장|연구원장|센터장|이사장|협회장|위원장|총장|학교장)$/.test(l));
      if (issuer) org = issuer.replace(/\s/g,'').replace(/(?:이사장|위원장|총장|장)$/,'');
    }
    if (!org) {
      const body = lines.filter(l=>!metadata.test(l)).join('').replace(/\s/g,'');
      org = knownOrgs.find(candidate=>body.includes(candidate)) || '';
    }
    if (org) org = knownOrgs.find(candidate=>org.replace(/\s/g,'').startsWith(candidate)) || org;
    const result = {name:name || '확인 필요',dept:dept || '확인 필요',org:org || '확인 필요',course:course || '확인 필요',date:date || '확인 필요',period:trainingPeriod,hours:hours || '확인 필요'};
    result.missingFields = ['name','org','course','period','hours'].filter(key=>result[key]==='확인 필요');
    return result;
  }
  function mergeMissingFields(primary, supplemental) {
    const merged = {...primary};
    for (const key of ['name','dept','org','course','date','period','hours']) {
      if (!merged[key] || merged[key] === '확인 필요') merged[key] = supplemental[key] || '확인 필요';
    }
    merged.missingFields = ['name','org','course','period','hours'].filter(key=>merged[key]==='확인 필요');
    return merged;
  }
  return {linesFromTextItems,extractNameFromFilename,extractFields,mergeMissingFields};
});

import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const execute = promisify(execFile);
const METADATA_QUERY = "SELECT id, json_extract(data,'$.year') AS year FROM records WHERE collection='courses' ORDER BY id; SELECT id, json_extract(data,'$.courseId') AS courseId, json_extract(data,'$.memberId') AS memberId, json_extract(data,'$.key') AS storageKey, json_extract(data,'$.size') AS size FROM records WHERE collection='files' ORDER BY id;";

export function koreaDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('기준 시각을 확인하세요.');
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function checkedDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error('기준일은 YYYY-MM-DD 형식의 실제 날짜여야 합니다.');
  }
  return value;
}

function checkedId(value) {
  if (typeof value !== 'string' || !/^[\w:-]{1,160}$/.test(value)) throw new Error('교육·파일 식별번호를 확인하세요.');
  return value;
}

export function buildDisposalPlan({courses, files}, {asOf = koreaDate(), generatedAt = new Date().toISOString(), source = 'offline'} = {}) {
  checkedDate(asOf);
  if (!Array.isArray(courses) || !Array.isArray(files)) throw new Error('courses·files 메타데이터 배열이 필요합니다.');
  const courseMap = new Map();
  for (const course of courses) {
    const id = checkedId(course?.id);
    if (courseMap.has(id) || !Number.isInteger(course.year) || course.year < 2000 || course.year > 2100) throw new Error('교육연도 또는 중복 교육 식별번호를 확인하세요.');
    courseMap.set(id, course.year);
  }
  const seen = new Set(), candidates = [];
  for (const file of files) {
    const id = checkedId(file?.id), courseId = checkedId(file.courseId), memberId = checkedId(file.memberId);
    const courseYear = courseMap.get(courseId);
    if (seen.has(id) || courseYear === undefined) throw new Error('파일 중복 또는 연결된 교육연도 누락을 확인하세요.');
    seen.add(id);
    const storageKey = file.storageKey ?? file.key;
    const parts = typeof storageKey === 'string' && /^certificates\/([\w:-]+)\/([\w:-]+)\/([\w:-]+)\/([\w:-]+)\.(?:pdf|jpg|png|webp)$/.exec(storageKey);
    if (!parts || parts[1] !== courseId || parts[2] !== memberId || parts[4] !== id
        || Buffer.byteLength(storageKey) > 512 || !Number.isSafeInteger(file.size) || file.size < 1) {
      throw new Error('파일 저장 키 또는 크기를 확인하세요.');
    }
    const expiry = `${courseYear}-12-31`;
    // The education year controls retention, including late uploads and every
    // earlier submission. This tool never selects only the latest revision.
    if (asOf > expiry) candidates.push({id, courseId, memberId, storageKey, size: file.size, courseYear, expiry});
  }
  candidates.sort((a, b) => a.courseYear - b.courseYear || a.courseId.localeCompare(b.courseId) || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    status: 'pending_approval',
    generatedAt,
    asOf,
    timeZone: 'Asia/Seoul',
    source,
    policy: '교육연도 12월 31일까지 보관, 다음 해 1월 1일부터 담당자 확인 및 승인 후 파기',
    scope: '승인 전 대상목록: 운영 파일 메타데이터 기준이며 로컬·ZIP·백업 사본과 보존 예외는 담당자가 별도 확인',
    filesExamined: files.length,
    candidateCount: candidates.length,
    totalBytes: candidates.reduce((sum, file) => sum + file.size, 0),
    candidates,
  };
}

async function remoteMetadata() {
  try {
    const result = await execute(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', '--remote', '--config', path.join(root, 'wrangler.jsonc'), '--json', '--command', METADATA_QUERY], {
      cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000,
      env: {...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1'},
    });
    const response = JSON.parse(result.stdout);
    if (!Array.isArray(response) || response.length !== 2 || response.some(item => item.success === false || !Array.isArray(item.results))) throw new Error('Invalid metadata response');
    return {courses: response[0].results, files: response[1].results};
  } catch {
    // Do not echo Wrangler stdout/stderr, credentials or input records.
    throw new Error('원격 메타데이터 조회에 실패했습니다. Cloudflare 인증과 DB 설정을 확인하세요.');
  }
}

async function prepareOutputDirectory() {
  let current = root;
  for (const segment of ['.edu-exports', 'disposal']) {
    current = path.join(current, segment);
    try {
      const entry = await fs.lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('출력 폴더는 실제 비공개 디렉터리여야 합니다.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(current);
    }
  }
  const resolved = await fs.realpath(current);
  const relative = path.relative(await fs.realpath(root), resolved);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('출력 경로를 확인하세요.');
  return current;
}

function argumentsFor(argv) {
  const options = {remote: false, help: argv.length === 0};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--help' || name === '-h') options.help = true;
    else if (name === '--remote') options.remote = true;
    else if (name === '--input' || name === '--as-of') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('옵션 값을 입력하세요.');
      options[name === '--input' ? 'input' : 'asOf'] = value;
    } else throw new Error('지원하지 않는 옵션입니다. --help를 확인하세요.');
  }
  if (options.remote && options.input) throw new Error('--remote와 --input 중 하나만 사용하세요.');
  return options;
}

export async function prepareDisposalList(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  if (options.help) {
    console.log('승인 전 수료증 파기대상 목록 생성 (조회 전용, 삭제 기능 없음)\n  node scripts/prepare-certificate-disposal.mjs --remote [--as-of YYYY-MM-DD]\n  node scripts/prepare-certificate-disposal.mjs --input 비공개_메타데이터.json [--as-of YYYY-MM-DD]\n기준일은 한국 날짜이며, 기본값은 실행 당일입니다. 출력은 .edu-exports/disposal/에만 저장합니다.');
    return;
  }
  if (!options.remote && !options.input) throw new Error('운영 조회는 --remote, 오프라인 검증은 --input을 지정하세요.');
  const metadata = options.remote ? await remoteMetadata() : JSON.parse(await fs.readFile(path.resolve(root, options.input), 'utf8'));
  const generatedAt = new Date().toISOString();
  const plan = buildDisposalPlan(metadata, {asOf: options.asOf || koreaDate(), generatedAt, source: options.remote ? 'remote-d1-metadata' : 'offline-metadata'});
  const directory = await prepareOutputDirectory();
  const file = path.join(directory, `pending-disposal-${generatedAt.replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify(plan, null, 2), {flag: 'wx', mode: 0o600});
  console.log(`승인 전 파기대상 ${plan.candidateCount}개 / 확인 파일 ${plan.filesExamined}개. 목록: ${path.relative(root, file)}. 파일 삭제는 수행하지 않았습니다.`);
  return {file, plan};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareDisposalList().catch(() => {
    console.error('파기대상 목록을 만들지 못했습니다. 입력 형식·옵션·출력 경로·Cloudflare 인증을 확인하세요.');
    process.exitCode = 1;
  });
}

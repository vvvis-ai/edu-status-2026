import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, '.dev.vars');
const destination = path.join(root, '.dev.vars.production.json');
const variables = Object.fromEntries((await fs.readFile(source, 'utf8'))
  .split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))
  .map(line => {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('비공개 설정 파일 형식을 확인해 주세요.');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
const secrets = {};
for (const key of ['ADMIN_PASSWORD', 'SESSION_SECRET']) {
  if (typeof variables[key] !== 'string' || !variables[key] || /[\r\n\0]/.test(variables[key])) throw new Error('관리자 비밀번호와 세션 키를 비공개 설정 파일에서 확인해 주세요.');
  secrets[key] = variables[key];
}
try {
  if ((await fs.lstat(destination)).isSymbolicLink()) throw new Error('배포 설정 경로에 심볼릭 링크를 사용할 수 없습니다.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await fs.writeFile(destination, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
console.log('비공개 배포 설정 2개를 준비했습니다. 값은 출력하지 않았습니다.');

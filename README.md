# 교육 관리 앱

부서원이 본인 이름을 선택해 수료증을 제출하고, 관리자가 승인·보완 요청을 처리하는 교육 관리 앱입니다. 교육 등록·복제·기간별 조회, 대상자·면제 설정, 명단·전출·인사이력, 최신 수료증 ZIP, 이수현황 XLSX를 제공합니다. 새 기능은 API와 저장소가 필요한 개발본이며 아직 운영 사이트에 배포하지 않았습니다.

## 로컬 실행

Node.js 24 이상에서 실행합니다. 새 체크아웃은 공개 가상 데이터로 초기화합니다.

```powershell
npm ci
npm run init:demo
npm start
```

- 부서원: http://127.0.0.1:3198/edustatus_all.html
- 관리자: http://127.0.0.1:3198/edustatus_admin.html
- 생성된 관리자 비밀번호: 이 PC의 `.dev.vars`에서 확인
- 로컬 DB·수료증: `.edu-data/`에 영구 보관
- 종료: `Ctrl+C`

이미 `.dev.vars`, `server/seed.json`, `.edu-data`가 있는 PC에서는 `npm start` 또는 `실행_교육관리앱.bat`로 이어서 실행합니다. `init:demo`는 기존 seed·secret 파일을 덮어쓰지 않습니다. 실제 명단·이수 스냅샷·수료증·비밀번호는 저장소에 포함하지 않습니다.

## 검증과 Cloudflare 준비

```powershell
npm run check
npm test
npm run build
npm run cf:types
npm run deploy:dry-run
```

Node 서버는 SQLite와 로컬 파일을 사용하고, Cloudflare Worker는 D1과 R2를 사용합니다. 두 서버가 같은 API 코드를 공유합니다. `build`는 허용된 웹 파일과 보안헤더만 `web-dist`에 만들고, `deploy:dry-run`은 업로드 없이 번들·설정을 검사합니다. 전용 D1과 스키마 연결은 완료했으며, R2 계정 활성화 후 버킷 생성·실제 이관·Worker 배포를 이어갑니다. `npm run deploy`는 빌드 후 로컬 `.dev.vars`의 서버 secret을 같은 배포에 설정합니다. [최종 배포 진행 상태](docs/최종배포_진행상태.md)를 확인하세요.

로컬 Workers의 스키마·가상 seed 준비, 비공개 이관 SQL, 백업·복구, 배포 절차는 [운영안내](docs/운영안내.md)를 참고하세요.

## GitHub Pages와 API

이 개발본의 HTML만 GitHub Pages에 올리면 `/api/bootstrap` 같은 API 요청을 처리할 서버가 없어 오류가 납니다. 수료증 업로드·원본 저장·관리자 세션도 동작하지 않습니다. 새 화면은 로컬 서버 또는 D1/R2가 연결된 Worker의 동일한 주소에서 실행해야 합니다. 기존 GitHub Pages 운영 화면에 대한 새 기능 배포는 아직 수행하지 않았습니다.

Worker 주소를 확정하면 공개 `deployment.json`의 `workerOrigin`을 채우고 `npm run build:pages`로 연결 페이지 3개를 생성합니다. Pages workflow는 이 연결 페이지만 게시하여 기존 부서원/관리자 주소를 Worker의 해당 화면으로 이동시킵니다. [Pages 연결안내](docs/Pages_연결안내.md)의 publishing source 전환 순서를 확인하세요.

## 코드 구성

| 경로 | 역할 |
| --- | --- |
| `edustatus_all.html`, `edu-public.mjs` | 부서원 선택·조회·제출 |
| `edustatus_admin.html`, `edu-admin.mjs` | 검토·교육·명단·현황 관리 |
| `edu-shared.mjs`, `edu-client.mjs`, `edu-style.css` | 공통 상태·API·화면 스타일 |
| `edu-zip.mjs`, `edu-workbook.mjs` | ZIP·XLSX 내보내기 |
| `server/` | 공통 API·스키마·로컬/Worker 진입점 |
| `scripts/` | 빌드·검사·가상 초기화·이관 준비 |
| `tests/` | API·HTTP·공통 상태·내보내기·파서 회귀 테스트 |

## 기존 수료증 추출 도구

`★교육수료증_자동추출_엑셀변환기.html`은 수료증에서 정보를 읽어 엑셀로 취합하는 별도 도구입니다. 같은 폴더의 `certificate-parser.js`, `certificate-ocr.js`, `vendor/` PDF 엔진을 사용합니다. XLSX·OCR·글꼴 라이브러리는 외부 CDN을 사용하므로 해당 기능에는 인터넷 연결이 필요합니다. PDF 엔진 재생성은 `npm run build:pdf`입니다.

CLI는 `npm run convert` 또는 `실행_수료증_엑셀추출.bat`로 실행합니다. 현재 폴더와 일부 하위 폴더의 수료증을 찾아 CSV를 만듭니다. 교육 관리 앱의 정적 빌드에는 이 별도 도구와 원본 수료증을 넣지 않습니다.

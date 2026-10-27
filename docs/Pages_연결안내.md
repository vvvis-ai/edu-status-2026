# 기존 GitHub Pages 주소 연결

교육 앱과 `/api`는 같은 Worker 주소에서 실행합니다. 기존 GitHub Pages 주소는 부서원·관리자 링크를 Worker로 이동시키는 연결 페이지로 유지합니다. 앱 HTML과 모듈은 로컬/Worker 실행용으로 그대로 두고, Pages에는 별도 `pages-bridge/`의 HTML 3개만 게시합니다.

## Worker 주소 확정 후 설정

1. Worker를 실제 HTTPS 주소에서 검증합니다. 공개 교육·명단 조회, 관리자 로그인, 파일 권한과 다운로드를 확인합니다.
2. `deployment.example.json`을 `deployment.json`으로 복사하고 `workerOrigin`에 검증한 Worker origin을 입력합니다. 이 JSON은 공개 접속주소만 담는 저장소 설정입니다. 비밀번호·토큰·실명 데이터를 넣지 않습니다.
3. `npm run build:pages`로 연결 페이지를 만듭니다. 예: `workerOrigin`은 `https://앱이름.계정.workers.dev` 형식이며 끝의 `/`는 있어도 됩니다. 경로·쿼리·해시·계정정보와 HTTP 주소는 거부합니다.

설정 파일 대신 한 번만 주소를 지정해 로컬 결과를 확인할 수도 있습니다.

```powershell
npm run build:pages -- --origin https://앱이름.계정.workers.dev
```

이 명령의 검사는 URL 형식 검사입니다. 실제 서비스 도달과 기능 검증은 게시 전에 별도로 해야 합니다. `deployment.json`이 없거나 값이 잘못되면 빌드는 실패하며 목적지를 추정하지 않습니다. 생성 폴더에 예상하지 않은 파일이 있어도 게시용 빌드를 중단합니다.

## 유지하는 진입 경로

| Pages 경로 | 이동할 Worker 경로 |
| --- | --- |
| `/edu-status-2026/` | `/edustatus_all.html` |
| `/edu-status-2026/edustatus_all.html` | `/edustatus_all.html` |
| `/edu-status-2026/edustatus_admin.html` | `/edustatus_admin.html` |

각 페이지는 meta refresh와 `location.replace`로 이동하고, 자동 이동이 차단되면 명확한 링크를 제공합니다. 기존 주소의 쿼리·해시·세션을 새 주소에 전달하지 않습니다. Worker에서 이름 선택이나 관리자 로그인을 다시 진행합니다.

## Pages 게시

`.github/workflows/pages.yml`은 main push 또는 수동 실행으로 Node.js 24에서 `npm ci`, `npm run build:pages`를 수행하고 `pages-bridge/`만 Pages artifact로 업로드합니다. Worker 배포·D1 이관·R2 공개 설정은 수행하지 않습니다.

저장소 관리자가 Worker 검증 이후 GitHub Pages publishing source를 **GitHub Actions**로 설정해야 합니다. 이 설정 변경을 빌드 스크립트가 대신하지 않습니다. 기존 main/root 자동 게시가 남아 있는 상태로 앱 소스만 먼저 올리면 기존 Pages 주소에서 API 오류가 발생할 수 있으므로, publishing source 전환과 연결 페이지 게시 순서를 함께 확인합니다.

게시 후 기존 부서원/관리자 주소를 각각 열어 올바른 Worker 페이지로 이동하는지 확인합니다. 목적지를 바꿀 때는 `deployment.json`을 수정한 뒤 workflow를 다시 실행합니다. 앱의 `edustatus_*.html`을 연결 페이지로 덮어쓰지 않습니다.

참고: [GitHub Pages 사용자 지정 workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

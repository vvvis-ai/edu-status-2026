# 교육 관리 앱 개발 계약

## 공통 데이터

- 모든 id는 문자열. 초기 교육/사람 id는 기존 숫자를 문자열로 유지.
- Course: `{id,name,site,url,deadline,submissionDeadline,year,periodType:'year'|'month'|'quarter',periodValue:number,details:string[],requirement:'all'|'one'|'custom',requirementNote,requestDepartment,description,published:boolean,archived:boolean,targetMode:'all'|'selected',targetMemberIds:string[],exemptMemberIds:string[],createdAt,updatedAt,version:number}`.
- Member: `{id,name,position,team,active:boolean,joinedOn,leftOn,note,legacyCompletions:string[],createdAt,updatedAt,version:number}`. 다른 사람은 반드시 신규 id. 수정 시 legacyCompletions는 서버가 보존.
- Submission: `{id,courseId,memberId,status:'pending'|'approved'|'needs_revision',completedOn,comment,submittedAt,reviewedAt,reviewNote,version,files:[{id,name,type,size}]}`. 재제출은 새 Submission, 과거 기록 보존.
- Override: `{id:memberId+':'+courseId,memberId,courseId,status:'approved'|'not_submitted'|'exempt',reason,updatedAt,version}`. status clear로 삭제 가능.
- UI에서 표시하는 종합 상태: not_target / not_submitted / pending / approved / needs_revision / exempt.
- API 수정은 version 필수, stale=409. 오류 JSON `{error:'한국어 오류',code?}`. 날짜 YYYY-MM-DD, 시간 ISO UTC.

## API (동일 origin /api)

- GET /api/bootstrap → `{courses:공개교육,members:재직명단,selectedMemberId,serverTime}`. 명단 completions/note 제외.
- POST /api/member-session `{memberId}` → `{member}`; DELETE /api/member-session → ok. 별도 HttpOnly 쿠키.
- GET /api/me → `{member,courses:공개교육,submissions:본인전체,overrides:본인전체,serverTime}`.
- POST /api/submissions : FormData courseId, completedOn, comment, files(동일 키 반복). 최대10파일, 각15MiB, 합60MiB. PDF/JPEG/PNG/WebP 실제 시그니처 검증. 재직·대상·공개·보관 상태 검사. 승인 후 재제출 금지, pending/needs_revision 허용. 저장 완료 후 `{submission}`.
- GET /api/files/:fileId?download=1 → 본인 또는 관리자에게만 파일. 기본 inline.
- POST /api/admin/login `{password}` → `{authenticated:true}`. 세션 HttpOnly 쿠키, secret env.ADMIN_PASSWORD 사용.
- GET /api/admin/session → `{authenticated:boolean}`.
- POST /api/admin/logout → ok.
- GET /api/admin/data → `{courses,members,submissions,overrides,audit,serverTime}`.
- POST /api/admin/courses → `{course}`, PUT /api/admin/courses/:id + version → `{course}`.
- POST /api/admin/members → `{member}`, PUT /api/admin/members/:id + version → `{member}`.
- GET /api/admin/members/:id/history → `{history,serverTime}`. 관리자 전용, 해당 부서원의 등록·인사 변경 감사 이력을 최신순으로 전량 조회. 대시보드의 최근 감사로그 500건 제한과 독립.
- POST /api/admin/submissions/:id/review `{status:'approved'|'needs_revision',reviewNote,version}` → `{submission}`. 최신 제출만 검토.
- PUT /api/admin/overrides/:memberId/:courseId `{status:'approved'|'not_submitted'|'exempt'|'clear',reason,version:0또는현재값}` → `{override}`. 수동 처리는 사유 필수. 검토보다 override 우선. 새 제출/검토 시 override 제거해 새 결과 반영.
- GET /api/admin/courses/:id/download?scope=approved|latest → ZIP. 기본 approved. 각 인원의 최신 제출만 대상. 하나라도 파일 누락되면 오류, 빈 ZIP 금지. 파일명 교육명/상태/팀_이름_수료일_번호.확장자, 이름 충돌시 memberId 포함.
- POST /api/admin/import-legacy `{members:[{id,name,position,completions}],confirm:true}` → import summary. 원본을 삭제하지 않는 초기 이수기록 병합, 이름충돌 시409. 이미 제출/override 있는 기록은 상태 덮어쓰지 않음. 감사로그.

## 서버 계약

- server/api.mjs export `handleApi(request,env)` : API 아닌 경로는 null 반환. 예외를 JSON으로 처리.
- env.DB는 D1 호환 prepare().bind().first()/all()/run(), batch(), exec(). 모든 mutation 조건부 UPDATE로 version 보장.
- env.FILES는 R2 호환 put(key,ReadableStream|ArrayBuffer|Uint8Array,{httpMetadata:{contentType}}), get(key) → `{body:ReadableStream,size,httpMetadata}`, head(key), delete(key).
- env.ADMIN_PASSWORD, env.SESSION_SECRET은 서버 secret. env.IS_LOCAL boolean 가능. seed 초기화는 root의 local start 또는 배포 migrations에서 담당. api 모듈에서 자동시드하지 않음.
- schema.sql은 records(collection TEXT,id TEXT,data TEXT,version INTEGER, PRIMARY KEY(collection,id)), sessions(token_hash TEXT PRIMARY KEY,role TEXT,member_id TEXT,expires_at INTEGER), login_attempts(key TEXT PRIMARY KEY,count INTEGER,reset_at INTEGER) 테이블. collections courses/members/submissions/overrides/audit/files(파일metadata+storage key) 사용. Agent가 필요 컬럼 추가 가능하나 root에게 전달.
- 파일 저장 후 put 결과와 head의 크기가 업로드 원본과 다르면 503 `FILE_STORAGE_CHANGED`로 접수를 거부하고 이번 파일들을 정리. 저장 후 외부 보안 프로그램이 다시 변환하는 환경은 원본 저장소로 사용하기 전에 별도 검증 필요.
- Root의 server/zip.mjs export createZip(entries) → ReadableStream; entries = [{name,open:async()=>ReadableStream|Uint8Array}]. backend는 모든 파일 head 미리 검사하고 스트림으로 ZIP 생성.

## root 공통 클라이언트/모델 exports

- edu-client.mjs: `api(path,options={})` (/api를 자동 prefix, JSON body 객체 자동직렬화, FormData 그대로, credentials same-origin, 오류 Error.message 한국어), `escapeHtml(value)`, `formatDate(value)`(빈값 —), `formatTime(value)`, `formatBytes(bytes)`, `showToast(message,type='success')`, `openDialog(dialog)`/`closeDialog(dialog)`, `downloadFile(path,filename)`, `downloadXlsx(rows,filename)` (행들의 2차원배열), `statusBadge(status)`(안전 HTML).
- edu-shared.mjs: `getLatestSubmission(submissions,memberId,courseId)`, `isTarget(course,member)`, `getStatus(course,member,submissions=[],overrides=[])`, `getProgress(courses,member,submissions=[],overrides=[])` → `{total,approved,pending,needsRevision,remaining,percent}`, `matchesPeriod(course,{year,month,quarter})`, `isNewCourse(course,now?)`(등록후14일), `STATUS_LABELS`, `FILE_ACCEPT`, `MAX_FILE_BYTES`, `MAX_TOTAL_BYTES`, `MAX_FILES`, `UPLOAD_NOTICE`.
- 공통 CSS 클래스 container, hero, panel, stack, row, grid, button(.primary/.secondary/.ghost/.danger), badge(.success/.warning/.danger/.muted/.info), field(input label), empty-state, dialog, notice, muted, section-title. 폼 입력/표 기본 스타일 제공. 색상 CSS 변수 --primary,--text,--muted,--border,--surface.
- 이수율·요약은 공개된 진행 교육에서 면제·대상 아님을 제외해 계산. 보관 교육은 부서원의 목록·제출 이력에서 확인하되 요약 집계에서 제외.
- 부서원·관리자 파일 미리보기는 권한 확인 후 Blob URL을 사용. 파일 API 자체의 sandbox CSP는 유지하며 닫거나 파일을 바꿀 때 URL·요청을 정리. 이미지 실패 안내와 파일 다운로드 대안 제공.
- HTML은 `<link rel="stylesheet" href="./edu-style.css">` 및 자신의 ES module을 사용. <meta charset>와 viewport 필수. 외부 CDN 없이 동작. 초기에 로딩/오류 상태 표시. localStorage에 이수/업로드데이터 저장 금지.

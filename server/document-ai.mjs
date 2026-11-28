import {documentAiProviders} from './document-ai-providers.mjs';

const descriptions={
  name:'공문이 안내하는 교육명',requestDepartment:'교육 이수를 요청한 부서',site:'수강 사이트 이름',
  url:'실제로 명시된 수강 사이트 http 또는 https 주소',year:'교육 연도 네 자리',
  deadline:'수강 종료일 YYYY-MM-DD',submissionDeadline:'수료증 제출 마감일 YYYY-MM-DD. 수강 종료일을 대신 사용하지 않는다.',
  details:'실제로 들어야 하는 강좌명. 여러 개면 줄바꿈으로 구분',
  requirement:'모두 이수는 all, 택일은 one, 기타 명시된 조건은 custom, 불명확하면 빈 문자열',
  requirementNote:'이수 조건 상세와 대상별 예외를 원문에 근거하여 작성'
};
const maxSize=10*1024*1024;
const properties=Object.fromEntries(Object.entries(descriptions).map(([name,description])=>[
  name,{type:'string',description:description+'. 공문에 근거가 없으면 빈 문자열.'},
]));
const schema={type:'object',properties,required:Object.keys(properties)};
async function readBytes(request,limit){
  const reader=request.body?.getReader();if(!reader)return new Uint8Array();
  const parts=[];let length=0;
  while(true){
    const {done,value}=await reader.read();if(done)break;
    length+=value.length;if(length>limit){await reader.cancel();return null;}
    parts.push(value);
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  return bytes;
}
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
async function keyStatus(id,provider,env){
  const managed=Boolean(env[provider.secret]);
  const store=env.localDocumentAiStore?.(id);
  return {id,label:provider.label,registered:managed||Boolean(await store?.exists()),editable:!managed&&Boolean(store)};
}

function documentMime(bytes){
  const header=String.fromCharCode(...bytes.subarray(0,5));
  if(header==='%PDF-')return 'application/pdf';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes[0]===137&&header.slice(1,4)==='PNG')return 'image/png';
  return '';
}

export async function handleDocumentAi(request,env,action,send=fetch,legacy=false){
  const url=new URL(request.url);
  if(action==='providers'&&request.method==='GET'){
    return reply({providers:await Promise.all([...documentAiProviders].map(([id,provider])=>keyStatus(id,provider,env)))});
  }

  const id=legacy?'upstage':(url.searchParams.get('provider')??'upstage');
  const provider=documentAiProviders.get(id);
  if(!provider)return reply({error:'지원하는 AI 제공업체를 선택해 주세요.'},400);
  if(request.method!=='GET'&&request.headers.get('origin')!==url.origin){
    return reply({error:'등록 화면을 다시 열어 주세요.'},403);
  }
  const store=env.localDocumentAiStore?.(id);
  if(action==='key'){
    if(request.method==='GET')return reply(await keyStatus(id,provider,env));
    if(request.method!=='PUT'||!store||env[provider.secret]){
      return reply({error:'배포 키는 Workers Secret에서 관리합니다.'},405);
    }
    const bytes=await readBytes(request,2048);
    const value=bytes&&new TextDecoder().decode(bytes).trim();
    if(!value||!(/^[!-~]{8,1024}$/).test(value))return reply({error:'발급받은 API 키를 확인해 주세요.'},400);
    try{await store.save(value);}
    catch{return reply({error:'이 Windows 계정에서 API 키를 암호화해 저장하지 못했습니다.'},500);}
    return reply({id,label:provider.label,registered:true,editable:true});
  }
  if(action!=='extract'||request.method!=='POST')return reply({error:'요청 경로를 확인해 주세요.'},404);
  const label=provider.label;
  let key;
  try{key=env[provider.secret]||await store?.read();}
  catch{return reply({error:label+' 키를 읽을 수 없습니다. 같은 Windows 계정에서 키를 다시 저장해 주세요.'},500);}
  if(!key)return reply({error:'먼저 '+label+' API 키를 등록해 주세요.'},409);
  const bytes=await readBytes(request,maxSize);
  if(!bytes)return reply({error:'프리뷰는 10MB 이하 공문을 지원합니다.'},413);
  const mime=documentMime(bytes);
  if(!mime)return reply({error:'PDF·JPG·PNG 파일을 확인해 주세요.'},415);
  let binary='';
  for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
  let response;
  const timeout=AbortSignal.timeout(90000);
  try{
    response=await send(provider.url,{
      method:'POST',redirect:'error',signal:AbortSignal.any([request.signal,timeout]),
      headers:{...provider.headers(key),'Content-Type':'application/json'},
      body:JSON.stringify(provider.body({mime,base64:btoa(binary),schema})),
    });
  }catch{
    return reply({error:timeout.aborted?label+' 응답 시간이 초과되었습니다.':label+'에 연결하지 못했습니다. 프리뷰 서버의 외부 인터넷 연결을 확인해 주세요.'},502);
  }
  if(!response.ok){
    const message=[401,403].includes(response.status)?'키와 이용 권한을 확인해 주세요.'
      :[402,429].includes(response.status)?'요청 한도와 결제 상태를 확인해 주세요.'
      :[400,413,415].includes(response.status)?'문서 형식, 크기 또는 페이지 수를 확인해 주세요.'
      :'제공업체의 모델 이용 권한과 서비스 상태를 확인해 주세요.';
    await response.body?.cancel().catch(()=>{});
    return reply({error:label+' 응답 '+response.status+' · '+message},502);
  }
  try{
    const {text,requestId,tokens}=provider.read(await response.json());
    const result=JSON.parse(text);
    if(!result||typeof result!=='object'||Array.isArray(result))throw Error();
    const fields=Object.fromEntries(Object.keys(properties).map(k=>[k,typeof result[k]==='string'?result[k].trim():'']));
    if(!/^https?:\/\/\S+$/i.test(fields.url))fields.url='';
    for(const k of ['deadline','submissionDeadline']){
      const date=new Date(fields[k]+'T00:00:00Z');
      if(!Number.isFinite(+date)||date.toISOString().slice(0,10)!==fields[k])fields[k]='';
    }
    if(!/^20\d{2}$/.test(fields.year))fields.year='';
    if(!['all','one','custom'].includes(fields.requirement))fields.requirement='';
    return reply({
      fields,provider:label,
      requestId:typeof requestId==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(requestId)?requestId:null,
      tokens:Number.isFinite(tokens)?tokens:null,
    });
  }catch{
    return reply({error:label+'가 응답했지만 추출 결과를 읽을 수 없습니다.'},502);
  }
}

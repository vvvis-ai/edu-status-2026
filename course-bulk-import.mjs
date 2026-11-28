let providers=[];
let savingKey=false;

const controls=document.createElement('section');
controls.innerHTML=`
  <label for="documentAiProvider">AI 제공업체</label>
  <select id="documentAiProvider" disabled></select>

  <p class="form-help" id="documentAiHelp"></p>
  <details>
    <summary>AI 문서 분석 설정</summary>
    <label for="documentAiKey">API 키</label>
    <input id="documentAiKey" type="password" autocomplete="off" spellcheck="false" maxlength="1024" disabled>
    <button class="button secondary" type="button" id="saveKey" disabled>키 저장</button>
    <p role="status" id="keyState"></p>
  </details>`;

const select=controls.querySelector('#documentAiProvider');
const keyInput=controls.querySelector('#documentAiKey');
const keyButton=controls.querySelector('#saveKey');
const keyState=controls.querySelector('#keyState');

const aiHelp=controls.querySelector('#documentAiHelp');
const selectedProvider=()=>providers.find(provider=>provider.id===select.value);

async function callServer(path,options,provider){
  const query=provider?'?'+new URLSearchParams({provider}):'';
  const response=await fetch('/api/admin/document-ai/'+path+query,options);
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data)throw Error(data?.error||'관리자 화면을 새로고침해 주세요.');
  return data;
}

function renderAiControls(){
  const provider=selectedProvider();
  select.disabled=!providers.length||savingKey||bulkRunning;
  keyInput.disabled=keyButton.disabled=!provider?.editable||savingKey||bulkRunning;
  bulkStart.disabled=bulkRunning||savingKey||!provider?.registered||!batch.some(row=>!row.id);

  if(!provider)return;
  keyState.textContent=provider.registered?'키 저장됨 · 분석 시 연결을 확인합니다.'
    :provider.editable?'이 제공업체에 저장된 키가 없습니다.':'배포 환경의 Workers Secret에 이 제공업체의 키를 등록하세요.';
  aiHelp.textContent=provider.registered
    ?(bulk.open?'일괄등록을 시작하면 선택한 파일을 차례로 ':'분석 버튼을 누르면 공문 원본을 ')+provider.label+'에 전송합니다. API 이용료가 발생할 수 있습니다.'
    :provider.label+' API 키를 등록한 뒤 분석할 수 있습니다.';
}

function renderProviderList(preferred){
  select.replaceChildren(...providers.map(provider=>new Option(
    provider.label+(provider.registered?' · 키 저장됨':''),provider.id,
  )));
  const selection=providers.find(provider=>provider.id===preferred)??providers.find(provider=>provider.registered)??providers[0];
  if(selection)select.value=selection.id;
  renderAiControls();
}

async function loadProviders(){
  aiHelp.textContent='AI 제공업체를 불러오는 중입니다…';
  try{
    const {providers:available}=await callServer('providers');
    providers=available;
    renderProviderList(select.value);
  }catch(error){
    providers=[];
    renderProviderList('');
    aiHelp.textContent=error.message;
  }
}

select.addEventListener('change',()=>{keyInput.value='';renderAiControls();});
keyInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();keyButton.click();}});
keyButton.onclick=async()=>{
  const provider=selectedProvider();
  if(!provider?.editable||savingKey)return;
  const value=keyInput.value.trim();
  keyInput.value='';
  if(!value){keyState.textContent='API 키를 입력하세요.';return;}
  savingKey=true;
  renderAiControls();
  keyState.textContent='키 저장 중…';
  try{
    const saved=await callServer('key',{method:'PUT',body:value},provider.id);
    providers=providers.map(item=>item.id===provider.id?saved:item);
    savingKey=false;
    renderProviderList(provider.id);
  }catch(error){
    savingKey=false;
    renderAiControls();
    keyState.textContent=error.message;
  }
};
const bulkButton=document.createElement('button');
bulkButton.type='button';
bulkButton.className='button secondary';
bulkButton.textContent='일괄등록';
document.querySelector('#newCourseButton').after(bulkButton);
const bulk=document.createElement('dialog');
bulk.className='dialog admin-dialog';
bulk.setAttribute('aria-labelledby','bulkTitle');
bulk.innerHTML='<div class="dialog-head"><h2 id="bulkTitle">교육 일괄등록</h2><button type="button" class="dialog-close" aria-label="닫기">×</button></div><div class="dialog-body"><div id="bulkControls"></div><label id="bulkDrop" class="soft-note" style="display:block;margin:16px 0;border:2px dashed #aba1d7">교육별 공문 한 개씩 선택하거나 여기에 끌어다 놓으세요.<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png"></label><p class="form-help">파일 한 개를 교육 한 건으로 등록합니다. 등록 결과는 임시저장되며 검토 후 공개할 수 있습니다.</p><ol id="bulkRows"></ol><p role="status" id="bulkStatus"></p></div><div class="dialog-footer"><button type="button" class="button primary" id="bulkStart">AI 추출 및 일괄등록</button></div>';
document.body.append(bulk);
const bulkStart=bulk.querySelector('#bulkStart');
const bulkFiles=bulk.querySelector('input[type=file]');
const drop=bulk.querySelector('#bulkDrop');
const bulkStatus=bulk.querySelector('#bulkStatus');
const closeBulk=bulk.querySelector('.dialog-close');
let batch=[];
let bulkRunning=false;

function drawBatch(){
  const rows=batch.map(row=>{
    const item=document.createElement('li');
    item.append(row.file.name+' · '+row.message+' ');
    if(row.id){
      const edit=document.createElement('button');
      edit.type='button';edit.className='button secondary';edit.textContent='검토·수정';edit.disabled=bulkRunning;
      edit.onclick=()=>{
        bulk.close();
        document.dispatchEvent(new CustomEvent('bulk-course-review',{detail:row.id}));
      };
      item.append(edit);
    }else if(!bulkRunning){
      const remove=document.createElement('button');
      remove.type='button';remove.className='button ghost';remove.textContent='목록에서 제외';
      remove.onclick=()=>{batch=batch.filter(candidate=>candidate!==row);drawBatch();};
      item.append(remove);
    }
    return item;
  });
  bulk.querySelector('#bulkRows').replaceChildren(...rows);
  renderAiControls();
}
bulkButton.onclick=()=>{
  bulk.querySelector('#bulkControls').append(controls);
  keyInput.value='';
  bulk.showModal();
  drawBatch();void loadProviders();
};
bulk.addEventListener('cancel',event=>{if(bulkRunning)event.preventDefault();});
bulk.addEventListener('close',()=>{
  keyInput.value='';
  renderAiControls();
});
closeBulk.onclick=()=>bulk.close();
function addFiles(files){
  if(bulkRunning)return;
  const rejected=[];
  for(const file of files){
    if(!/\.(pdf|jpe?g|png)$/i.test(file.name)||file.size>10*1024*1024||!file.size){
      rejected.push(file.name);continue;
    }
    batch.push({file,message:'대기',id:null});
  }
  bulkStatus.textContent=rejected.length?'추가할 수 없는 파일 (PDF·JPG·PNG, 10MB 이하) · '+rejected.join(', '):'';
  drawBatch();
}
bulkFiles.onchange=()=>{addFiles(bulkFiles.files);bulkFiles.value='';};
drop.ondragover=event=>{event.preventDefault();event.dataTransfer.dropEffect=bulkRunning?'none':'copy';};
drop.ondrop=event=>{event.preventDefault();addFiles(event.dataTransfer.files);};
bulkStart.onclick=async()=>{
  const provider=selectedProvider();
  if(bulkRunning||!provider?.registered)return;
  bulkRunning=true;bulkFiles.disabled=closeBulk.disabled=true;
  const pending=batch.filter(row=>!row.id);
  let added=0,duplicates=0,failed=0;
  try{
    for(const [index,row] of pending.entries()){
      bulkStatus.textContent=(index+1)+' / '+pending.length+' · '+provider.label+' 처리 중';
      row.message='분석 및 등록 중';drawBatch();
      try{
        const hash=await crypto.subtle.digest('SHA-256',await row.file.arrayBuffer());
        const digest=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
        const query=new URLSearchParams({provider:provider.id,filename:row.file.name,digest});
        const response=await fetch('/api/admin/course-drafts/import?'+query,{method:'POST',body:row.file});
        const data=await response.json();
        if(!response.ok)throw Error(data.error||'등록하지 못했습니다.');
        row.id=data.id;
        row.message=(data.existing?'이미 등록됨':'임시저장 완료')+' · '+data.name;
        if(data.existing)duplicates++;else added++;
      }catch(error){failed++;row.message='실패 · '+error.message;}
    }
    bulkStatus.textContent='신규 '+added+'건 · 기존 '+duplicates+'건 · 실패 '+failed+'건'+(failed?' · 버튼을 다시 누르면 실패한 파일을 재시도합니다.':'');
    if(added||duplicates)document.querySelector('#refreshButton').click();
  }finally{
    bulkRunning=false;bulkFiles.disabled=closeBulk.disabled=false;
    drawBatch();
  }
};

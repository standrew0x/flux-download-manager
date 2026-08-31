const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const activeStates = new Set(['probing','downloading','merging','verifying']);
const queuedStates = new Set(['queued','scheduled']);
const state = { jobs:[], settings:{}, system:{}, filter:'all', category:null, search:'', sort:'recent', selected:null, connected:false, previous:new Map() };
const svg = id => `<svg aria-hidden="true"><use href="#icon-${id}"></use></svg>`;
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const bytes = value => { const n=Number(value)||0, units=['B','KB','MB','GB','TB']; let i=0,v=n; while(v>=1024&&i<4){v/=1024;i++;} return `${i? v.toFixed(v>=100?0:v>=10?1:2):Math.round(v)} ${units[i]}`; };
const duration = value => { let n=Math.max(0,Math.round(Number(value)||0)); if(!value&&value!==0)return '—'; const h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=n%60; return h?`${h}h ${m}m`:m?`${m}m ${s}s`:`${s}s`; };
const percent = job => job.totalBytes ? Math.max(0,Math.min(100,job.downloadedBytes/job.totalBytes*100)) : job.status==='complete'?100:0;
const date = value => value ? new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : '—';
const iconFor = category => ({video:'video',documents:'document',archives:'archive',software:'file',other:'file'}[category]||'file');
const titleStatus = value => ({complete:'Completed',failed:'Needs attention',cancelled:'Cancelled',probing:'Connecting',merging:'Finalizing',verifying:'Verifying',scheduled:'Scheduled'}[value] || value?.replace(/^./,c=>c.toUpperCase()) || 'Unknown');

async function api(url, options={}) {
  const response = await fetch(url,{...options,headers:options.body?{'Content-Type':'application/json',...(options.headers||{})}:options.headers});
  let data={}; try{data=await response.json();}catch{}
  if(!response.ok) throw new Error(data.error||`Request failed (${response.status})`); return data;
}

function toast(message, kind='info') {
  const item=document.createElement('div'); item.className=`toast ${kind}`; item.innerHTML=`<span>${svg(kind==='error'?'info':kind==='success'?'check':'activity')}</span><p>${esc(message)}</p>`;
  $('#toastRegion').append(item); setTimeout(()=>item.remove(),4200);
}

function applySnapshot(data) {
  const old=state.previous; state.jobs=data.jobs||state.jobs; state.settings=data.settings||state.settings; state.system=data.system||state.system;
  for(const job of state.jobs){const before=old.get(job.id);if(before&&before!==job.status&&['complete','failed'].includes(job.status)) notify(job);}
  state.previous=new Map(state.jobs.map(j=>[j.id,j.status])); state.connected=true; render();
}

async function load() { try{applySnapshot(await api('/api/bootstrap'));}catch(error){state.connected=false;renderConnection();toast(error.message,'error');} }
function connect() {
  const events=new EventSource('/api/events'); events.addEventListener('snapshot',event=>{try{applySnapshot(JSON.parse(event.data));}catch{}});
  events.onopen=()=>{state.connected=true;renderConnection();}; events.onerror=()=>{state.connected=false;renderConnection();};
  setInterval(()=>{if(!state.connected)load();},5000);
}

function notify(job) {
  if(!state.settings.notifications)return; const message=job.status==='complete'?`${job.filename} is ready`:`${job.filename} needs attention`;
  toast(message,job.status==='complete'?'success':'error');
  if('Notification'in window&&Notification.permission==='granted')new Notification('Flux Download Manager',{body:message});
}

function visibleJobs() {
  let jobs=state.jobs.filter(job=>{
    if(state.filter==='active'&&!activeStates.has(job.status))return false;
    if(state.filter==='queued'&&!queuedStates.has(job.status))return false;
    if(state.filter==='paused'&&job.status!=='paused')return false;
    if(state.filter==='complete'&&job.status!=='complete')return false;
    if(state.filter==='failed'&&!['failed','cancelled'].includes(job.status))return false;
    if(state.category&&job.category!==state.category)return false;
    const query=state.search.toLowerCase(); return !query||[job.filename,job.displayUrl,job.directory,job.category].some(v=>String(v||'').toLowerCase().includes(query));
  });
  const compares={recent:(a,b)=>String(b.createdAt).localeCompare(a.createdAt),name:(a,b)=>a.filename.localeCompare(b.filename),progress:(a,b)=>percent(b)-percent(a),speed:(a,b)=>(b.speedBps||0)-(a.speedBps||0),status:(a,b)=>a.status.localeCompare(b.status)};
  return jobs.sort(compares[state.sort]||compares.recent);
}

function render() { renderConnection(); renderCounts(); renderSummary(); renderList(); if(state.selected)renderDetails(); applyTheme(state.settings.theme||localStorage.getItem('flux-theme')||'dark'); }
function renderConnection(){ $('#connectionBadge').classList.toggle('is-offline',!state.connected);$('#connectionBadge b').textContent=state.connected?'Live':'Reconnecting';$('#engineState').textContent=state.connected?'Online':'Offline'; }
function renderCounts(){
  const count=fn=>state.jobs.filter(fn).length; const set=(id,n)=>$(id).textContent=n;
  set('#countAll',state.jobs.length);set('#countActive',count(j=>activeStates.has(j.status)));set('#countQueued',count(j=>queuedStates.has(j.status)));set('#countPaused',count(j=>j.status==='paused'));set('#countComplete',count(j=>j.status==='complete'));set('#countFailed',count(j=>['failed','cancelled'].includes(j.status)));
  for(const name of ['Video','Documents','Archives','Other'])set(`#count${name}`,count(j=>j.category===name.toLowerCase()));
}
function renderSummary(){
  const active=state.jobs.filter(j=>activeStates.has(j.status)),speed=active.reduce((n,j)=>n+(j.speedBps||0),0),received=state.jobs.reduce((n,j)=>n+(j.downloadedBytes||0),0),complete=state.jobs.filter(j=>j.status==='complete').length;
  $('#summaryActive').textContent=active.length;$('#summaryActiveHint').textContent=active.length?`${state.jobs.filter(j=>j.status==='queued').length} waiting in queue`:'No transfers running';$('#summarySpeed').textContent=`${bytes(speed)}/s`;$('#summaryReceived').textContent=bytes(received);$('#summaryComplete').textContent=complete;$('#summaryCompleteHint').textContent=complete?'Ready to open':'Nothing finished yet';
  $('#engineActive').textContent=`${active.length} active`;$('#engineSpeed').textContent=`${bytes(speed)}/s`;$('#engineMeter').style.width=`${Math.min(100,active.length/Math.max(1,state.settings.maxConcurrent||3)*100)}%`;
}

function renderList(){
  const jobs=visibleJobs(),list=$('#downloadList');$('#loadingList').hidden=true;$('#visibleCount').textContent=`${jobs.length} item${jobs.length===1?'':'s'}`;
  const labels={all:'All downloads',active:'Active downloads',queued:'Queued downloads',paused:'Paused downloads',complete:'Completed downloads',failed:'Needs attention'};$('#queueTitle').textContent=state.category?`${state.category[0].toUpperCase()+state.category.slice(1)} downloads`:labels[state.filter];
  $('#statePanel').hidden=jobs.length>0;list.hidden=jobs.length===0;
  if(!jobs.length){$('#stateTitle').textContent=state.search?'No matching downloads':state.jobs.length?'Nothing in this view':'Your queue is clear';$('#stateMessage').textContent=state.search?'Try a different filename, URL, or folder.':'Add a link and Flux will handle parallel connections, retries, and resume.';return;}
  list.innerHTML=jobs.map(job=>{
    const p=percent(job),active=activeStates.has(job.status),primary=job.status==='complete'?`${bytes(job.totalBytes)}`:active?`${bytes(job.speedBps)}/s`:job.status==='failed'?'Transfer stopped':`${bytes(job.downloadedBytes)} / ${job.totalBytes?bytes(job.totalBytes):'—'}`;
    const secondary=active?`${duration(job.etaSeconds)} remaining`:job.status==='scheduled'?date(job.scheduledAt):job.error||`${job.connections} connection${job.connections===1?'':'s'}`;
    const control=active?`<button class="row-action is-primary" data-action="pause" title="Pause">${svg('pause')}</button>`:['paused','failed','cancelled','scheduled'].includes(job.status)?`<button class="row-action is-primary" data-action="${job.status==='failed'?'retry':'resume'}" title="Resume">${svg(job.status==='failed'?'refresh':'play')}</button>`:job.status==='complete'?`<button class="row-action is-primary" data-action="open" title="Open file">${svg('external')}</button>`:'';
    return `<article class="download-row ${state.selected===job.id?'is-selected':''}" data-id="${job.id}" data-state="${job.status}" role="listitem" tabindex="0"><div class="row-file"><span class="file-icon ${esc(job.category)}">${svg(iconFor(job.category))}</span><div class="file-copy"><div class="file-title-line"><strong class="file-title">${esc(job.filename)}</strong>${job.priority==='high'?'<span class="priority-tag">High</span>':''}</div><div class="file-meta"><span>${esc(job.category)}</span><i></i><span title="${esc(job.displayUrl)}">${esc(job.displayUrl)}</span></div><div class="row-progress"><div class="progress-track"><span style="width:${p}%"></span></div><span class="progress-label">${p.toFixed(p>=10?0:1)}%</span></div></div></div><div class="row-status"><span class="status-pill ${job.status}">${titleStatus(job.status)}</span><small>${job.retries?`${job.retries} retr${job.retries===1?'y':'ies'}`:date(job.updatedAt)}</small></div><div class="row-transfer"><div class="transfer-primary ${active?'is-active':''}">${esc(primary)}</div><div class="transfer-secondary">${svg(active?'clock':'activity')}<span title="${esc(secondary)}">${esc(secondary)}</span></div></div><div class="row-actions">${control}<button class="row-action" data-action="folder" title="Open folder">${svg('folder')}</button><button class="row-action is-danger" data-action="remove" title="Remove">${svg('trash')}</button></div></article>`;
  }).join('');
}

function renderDetails(){
  const job=state.jobs.find(j=>j.id===state.selected);if(!job){closeDetails();return;} const p=percent(job),events=[...(job.events||[])].reverse();$('#detailsTitle').textContent=job.filename;
  const actions=activeStates.has(job.status)?`<button class="secondary-button" data-detail-action="pause">${svg('pause')} Pause</button>`:['paused','cancelled','failed','scheduled'].includes(job.status)?`<button class="primary-button" data-detail-action="${job.status==='failed'?'retry':'resume'}">${svg('play')} ${job.status==='failed'?'Retry':'Resume'}</button>`:'';
  $('#detailsContent').innerHTML=`<div class="drawer-file-card"><span class="file-icon ${esc(job.category)}">${svg(iconFor(job.category))}</span><div><h3>${esc(job.filename)}</h3><p>${esc(job.displayUrl)}</p></div></div><div class="drawer-progress-card"><div class="drawer-progress-top"><div><span>${titleStatus(job.status)}</span><strong>${bytes(job.downloadedBytes)} <small>of ${job.totalBytes?bytes(job.totalBytes):'unknown'}</small></strong></div><strong>${p.toFixed(1)}%</strong></div><div class="progress-track"><span style="width:${p}%"></span></div></div><div class="drawer-stat-grid"><div class="drawer-stat"><span>Speed</span><strong>${bytes(job.speedBps)}/s</strong></div><div class="drawer-stat"><span>Time left</span><strong>${duration(job.etaSeconds)}</strong></div><div class="drawer-stat"><span>Connections</span><strong>${job.segmentCount||job.connections}</strong></div><div class="drawer-stat"><span>Retries</span><strong>${job.retries||0}</strong></div></div>${job.error?`<div class="error-note">${svg('info')}<span>${esc(job.error)}</span></div>`:''}<div class="drawer-actions">${actions}<button class="secondary-button" data-detail-action="${job.status==='complete'?'open':'folder'}">${svg(job.status==='complete'?'external':'folder')} ${job.status==='complete'?'Open file':'Open folder'}</button></div><section class="drawer-section"><div class="drawer-section-title"><h3>Save location</h3></div><div class="detail-path">${svg('folder')}<span title="${esc(job.outputPath)}">${esc(job.outputPath)}</span></div></section><section class="drawer-section"><div class="drawer-section-title"><h3>Activity</h3></div><ol class="event-log">${events.length?events.map(e=>`<li class="event-item"><span class="event-dot"></span><div class="event-copy"><strong>${esc(e.message)}</strong><span>${date(e.at)}</span></div></li>`).join(''):'<li class="event-item"><span class="event-dot"></span><div class="event-copy"><strong>Ready</strong></div></li>'}</ol></section>`;
}
function openDetails(id){state.selected=id;$('#detailsDrawer').classList.add('is-open');$('#detailsDrawer').setAttribute('aria-hidden','false');$('#drawerScrim').hidden=false;renderList();renderDetails();}
function closeDetails(){state.selected=null;$('#detailsDrawer').classList.remove('is-open');$('#detailsDrawer').setAttribute('aria-hidden','true');$('#drawerScrim').hidden=true;renderList();}

function showAdd(){const d=$('#addDialog');$('#downloadDestination').value=state.settings.downloadFolder||state.system.downloadFolder||'';$('#downloadConnections').value=String(state.settings.defaultConnections||4);$('#downloadUrl').value='';$('#downloadFilename').value='';$('#downloadSpeedLimit').value='';$('#scheduleEnabled').checked=false;$('#scheduleField').hidden=true;d.showModal();setTimeout(()=>$('#downloadUrl').focus(),20);}
function showSettings(){ $('#settingMaxConcurrent').value=state.settings.maxConcurrent||3;$('#settingDefaultConnections').value=state.settings.defaultConnections||4;$('#settingDownloadFolder').value=state.settings.downloadFolder||'';$('#settingSpeedLimit').value=state.settings.speedLimit?state.settings.speedLimit/1024/1024:0;$('#settingTheme').value=state.settings.theme||'dark';$('#settingNotifications').checked=state.settings.notifications!==false;$('#settingAutoResume').checked=state.settings.autoResume!==false;$('#settingsDialog').showModal(); }
function applyTheme(theme){const actual=theme==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):theme;document.body.dataset.theme=actual;localStorage.setItem('flux-theme',theme);$('#themeButton use').setAttribute('href',actual==='dark'?'#icon-sun':'#icon-moon');$('#themeButton').setAttribute('aria-label',`Switch to ${actual==='dark'?'light':'dark'} theme`);}

async function perform(id,action){try{if(['open','folder'].includes(action)){await api('/api/system/open',{method:'POST',body:JSON.stringify({jobId:id,target:action==='open'?'file':'folder'})});return;}await api(`/api/downloads/${id}/actions`,{method:'POST',body:JSON.stringify({action})});toast(`${titleStatus(action)} requested`,'success');}catch(error){toast(error.message,'error');}}
function confirmAction(title,message,{option=false,accept='Confirm'}={}){return new Promise(resolve=>{const d=$('#confirmDialog');$('#confirmTitle').textContent=title;$('#confirmMessage').textContent=message;$('#confirmOption').hidden=!option;$('#confirmCheckbox').checked=false;$('#confirmAccept').textContent=accept;const done=value=>{d.close();resolve(value);};$('#confirmCancel').onclick=()=>done(null);$('#confirmAccept').onclick=()=>done(option?{checked:$('#confirmCheckbox').checked}:{});d.showModal();});}
async function removeJob(id){const job=state.jobs.find(j=>j.id===id),answer=await confirmAction('Remove download?',`Remove “${job?.filename||'this download'}” from Flux?`,{option:true,accept:'Remove'});if(!answer)return;try{await api(`/api/downloads/${id}?deleteFiles=${answer.checked}`,{method:'DELETE',body:JSON.stringify({})});closeDetails();toast('Download removed','success');}catch(error){toast(error.message,'error');}}

$$('.nav-item').forEach(button=>button.addEventListener('click',()=>{ $$('.nav-item').forEach(b=>{b.classList.remove('is-active');b.removeAttribute('aria-current');});button.classList.add('is-active');button.setAttribute('aria-current','page');state.filter=button.dataset.filter||'all';state.category=button.dataset.category||null;renderList();}));
$('#downloadList').addEventListener('click',event=>{const row=event.target.closest('.download-row');if(!row)return;const action=event.target.closest('[data-action]')?.dataset.action;if(action){event.stopPropagation();action==='remove'?removeJob(row.dataset.id):perform(row.dataset.id,action);}else openDetails(row.dataset.id);});
$('#downloadList').addEventListener('keydown',event=>{const row=event.target.closest('.download-row');if(!row)return;if(event.key==='Enter')openDetails(row.dataset.id);if(event.key===' '){event.preventDefault();const job=state.jobs.find(j=>j.id===row.dataset.id);perform(job.id,activeStates.has(job.status)?'pause':'resume');}});
$('#detailsContent').addEventListener('click',event=>{const action=event.target.closest('[data-detail-action]')?.dataset.detailAction;if(action)perform(state.selected,action);});
$('#addDownloadButton').onclick=showAdd;$('#stateAction').onclick=showAdd;$('#settingsButton').onclick=showSettings;$('#shortcutButton').onclick=()=>$('#shortcutsDialog').showModal();$('#closeDetailsButton').onclick=closeDetails;$('#drawerScrim').onclick=closeDetails;$('#refreshButton').onclick=load;
$$('[data-close-dialog]').forEach(button=>button.onclick=()=>document.getElementById(button.dataset.closeDialog).close());
$('#globalSearch').oninput=event=>{state.search=event.target.value;renderList();};$('#sortSelect').onchange=event=>{state.sort=event.target.value;renderList();};$('#clearSearchButton').onclick=()=>{state.search='';$('#globalSearch').value='';state.filter='all';state.category=null;renderList();};
$('#scheduleEnabled').onchange=event=>{$('#scheduleField').hidden=!event.target.checked;};$('#themeButton').onclick=async()=>{const theme=document.body.dataset.theme==='dark'?'light':'dark';applyTheme(theme);try{state.settings=await api('/api/settings',{method:'PUT',body:JSON.stringify({theme})});}catch{}};
$('#sidebarToggle').onclick=()=>{const open=$('#sidebar').classList.toggle('is-open');$('#sidebarToggle').setAttribute('aria-expanded',open);};

async function chooseFolder(input){try{const result=await api('/api/system/pick-folder',{method:'POST',body:'{}'});if(result.path)input.value=result.path;}catch(error){toast(error.message,'error');}}
$('#pickFolderButton').onclick=()=>chooseFolder($('#downloadDestination'));$('#pickSettingsFolderButton').onclick=()=>chooseFolder($('#settingDownloadFolder'));
$('#setupBrowserCaptureButton').onclick=async()=>{try{const result=await api('/api/system/browser-setup',{method:'POST',body:'{}'});toast(`Setup opened for ${result.browsers.join(', ')}. Load the folder shown in Explorer.`,'success');}catch(error){toast(error.message,'error');}};
$('#addForm').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;const button=$('#submitDownloadButton');button.disabled=true;try{const speed=Number($('#downloadSpeedLimit').value)||0;await api('/api/downloads',{method:'POST',body:JSON.stringify({url:$('#downloadUrl').value.trim(),destination:$('#downloadDestination').value.trim(),filename:$('#downloadFilename').value.trim(),connections:Number($('#downloadConnections').value),priority:$('#downloadPriority').value,category:$('#downloadCategory').value,speedLimit:speed*1024*1024,scheduleAt:$('#scheduleEnabled').checked?$('#downloadSchedule').value:null,sha256:$('#downloadSha256').value.trim()})});$('#addDialog').close();toast('Download added to the queue','success');}catch(error){toast(error.message,'error');}finally{button.disabled=false;}};
$('#settingsForm').onsubmit=async event=>{event.preventDefault();try{const patch={maxConcurrent:Number($('#settingMaxConcurrent').value),defaultConnections:Number($('#settingDefaultConnections').value),downloadFolder:$('#settingDownloadFolder').value.trim(),speedLimit:(Number($('#settingSpeedLimit').value)||0)*1024*1024,theme:$('#settingTheme').value,notifications:$('#settingNotifications').checked,autoResume:$('#settingAutoResume').checked};if(patch.notifications&&'Notification'in window&&Notification.permission==='default')await Notification.requestPermission();state.settings=await api('/api/settings',{method:'PUT',body:JSON.stringify(patch)});$('#settingsDialog').close();applyTheme(patch.theme);toast('Settings saved','success');}catch(error){toast(error.message,'error');}};
$('#shutdownButton').onclick=async()=>{const answer=await confirmAction('Exit Flux?','Active downloads will return to the queue and resume the next time Flux starts.',{accept:'Exit Flux'});if(!answer)return;try{await api('/api/system/shutdown',{method:'POST',body:'{}'});toast('Flux has stopped','success');setTimeout(()=>window.close(),500);}catch(error){toast(error.message,'error');}};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$$('dialog[open]').length)closeDetails();if((event.ctrlKey||event.metaKey)&&['n','k','f',','].includes(event.key.toLowerCase())){event.preventDefault();if(event.key.toLowerCase()==='n')showAdd();else if(event.key===',')showSettings();else{$('#globalSearch').focus();$('#globalSearch').select();}}if(event.key==='?'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))$('#shortcutsDialog').showModal();});

applyTheme(localStorage.getItem('flux-theme')||'dark');load();connect();

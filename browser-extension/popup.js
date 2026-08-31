const $ = selector => document.querySelector(selector);
const FLUX = 'http://127.0.0.1:17652';
const formatBytes = value => { let n=Number(value)||0,i=0;const units=['B','KB','MB','GB','TB'];while(n>=1024&&i<4){n/=1024;i++;}return `${n.toFixed(n>=10?1:2)} ${units[i]}`; };
function browser(){const a=navigator.userAgent;if(/Edg\//.test(a))return'Microsoft Edge';if(/OPR\//.test(a))return'Opera';return'Google Chrome';}
async function render(){
  const data=await chrome.storage.local.get({enabled:true,thresholdGiB:6,capturedCount:0,lastCapture:null,lastError:null});
  $('#enabled').checked=data.enabled;$('#threshold').value=data.thresholdGiB;$('#thresholdLabel').textContent=`${data.thresholdGiB} GB`;$('#browserName').textContent=browser();$('#statusDot').classList.toggle('on',data.enabled);
  $('#lastCapture').textContent=data.lastCapture?`Last: ${data.lastCapture.filename} · ${formatBytes(data.lastCapture.bytes)}`:data.lastError?`Last handoff failed: ${data.lastError}`:'No downloads captured yet.';
  try{const response=await fetch(`${FLUX}/api/browser/status`);if(!response.ok)throw new Error();$('#serviceLight').classList.add('on');$('#serviceTitle').textContent='Flux is ready';$('#serviceCopy').textContent=`${data.capturedCount} download${data.capturedCount===1?'':'s'} captured`;}
  catch{$('#serviceLight').classList.remove('on');$('#serviceTitle').textContent='Flux is not running';$('#serviceCopy').textContent='Launch Flux to enable takeover';}
}
$('#enabled').addEventListener('change',async event=>{await chrome.storage.local.set({enabled:event.target.checked});render();});
$('#threshold').addEventListener('change',async event=>{const value=Math.max(6,Number(event.target.value)||6);await chrome.storage.local.set({thresholdGiB:value});render();});
$('#openFlux').addEventListener('click',()=>chrome.tabs.create({url:FLUX}));
render();

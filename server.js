import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DownloadStore } from './src/store.js';
import { DownloadEngine, DEFAULT_SETTINGS } from './src/download-engine.js';

const execFileAsync = promisify(execFile);
const HOST = '127.0.0.1';
const PORT = Number(process.env.FLUXDM_PORT) || 17652;
const ORIGIN = `http://${HOST}:${PORT}`;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const store = new DownloadStore({ defaultSettings: DEFAULT_SETTINGS });
const engine = new DownloadEngine({ store });
await engine.init();

const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };
const headers = {
  'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY', 'Referrer-Policy':'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
};

function send(res, status, value, extra = {}) {
  const body = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, { ...headers, 'Content-Type':'application/json; charset=utf-8', 'Content-Length':Buffer.byteLength(body), ...extra }); res.end(body);
}

async function body(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json'), { status:415 });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw Object.assign(new Error('Request body is too large'), { status:413 }); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON body'), { status:400 }); }
}

function assertLocalMutation(req) {
  const origin = req.headers.origin;
  const extensionOrigin = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin || '');
  if (origin && origin !== ORIGIN && origin !== `http://localhost:${PORT}` && !extensionOrigin) throw Object.assign(new Error('Request origin is not allowed'), { status:403 });
  const host = String(req.headers.host || '');
  if (![`${HOST}:${PORT}`, `localhost:${PORT}`].includes(host)) throw Object.assign(new Error('Request host is not allowed'), { status:403 });
}

function systemInfo() { return { version:'1.0.0', platform:process.platform, downloadFolder:engine.getSettings().downloadFolder, stateFolder:store.rootDir, browserExtensionFolder:path.join(ROOT,'browser-extension') }; }

async function openTarget(jobId, target) {
  const job = engine.list().find(item => item.id === jobId); if (!job) throw Object.assign(new Error('Download not found'), { status:404 });
  const selected = target === 'file' && job.status === 'complete' ? job.outputPath : job.directory;
  if (process.platform === 'win32') {
    const args = target === 'file' && job.status === 'complete' ? [selected] : [selected];
    spawn('explorer.exe', args, { detached:true, stdio:'ignore', windowsHide:false }).unref();
  } else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [selected], { detached:true, stdio:'ignore' }).unref();
}

async function pickFolder() {
  if (process.platform !== 'win32') return engine.getSettings().downloadFolder;
  const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Choose a Flux download folder'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.SelectedPath)}";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile','-Sta','-Command',script], { windowsHide:false, timeout:120000 });
  return stdout.trim() || null;
}

function browserCandidates() {
  return [
    { name:'Microsoft Edge', executable:path.join(process.env['PROGRAMFILES(X86)']||'', 'Microsoft','Edge','Application','msedge.exe'), page:'edge://extensions/' },
    { name:'Google Chrome', executable:path.join(process.env.PROGRAMFILES||'', 'Google','Chrome','Application','chrome.exe'), page:'chrome://extensions/' },
    { name:'Google Chrome', executable:path.join(process.env['PROGRAMFILES(X86)']||'', 'Google','Chrome','Application','chrome.exe'), page:'chrome://extensions/' },
    { name:'Opera', executable:path.join(process.env.LOCALAPPDATA||'', 'Programs','Opera','opera.exe'), page:'opera://extensions/' },
  ].filter((item,index,all)=>item.executable && existsSync(item.executable) && all.findIndex(other=>other.name===item.name)===index);
}

async function openBrowserSetup() {
  const extensionFolder = path.join(ROOT,'browser-extension');
  for (const browser of browserCandidates()) spawn(browser.executable,[browser.page],{detached:true,stdio:'ignore'}).unref();
  if (process.platform === 'win32') spawn('explorer.exe',[extensionFolder],{detached:true,stdio:'ignore'}).unref();
  return { browsers:browserCandidates().map(item=>item.name), extensionFolder };
}

async function staticFile(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, relative);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error:'Forbidden' });
  try { const info = await stat(file); if (!info.isFile()) throw Object.assign(new Error(),{code:'ENOENT'}); const data = await readFile(file); res.writeHead(200, { ...headers, 'Content-Type':mime[path.extname(file)] || 'application/octet-stream', 'Content-Length':data.length, 'Cache-Control': path.extname(file)==='.html' ? 'no-store' : 'no-cache' }); res.end(data); }
  catch (error) { if (error.code === 'ENOENT') send(res,404,{error:'Not found'}); else throw error; }
}

const clients = new Set();
function publish(snapshot = { jobs:engine.list(), settings:engine.getSettings() }) {
  const payload = `event: snapshot\ndata: ${JSON.stringify({ ...snapshot, system:systemInfo() })}\n\n`;
  for (const res of clients) res.write(payload);
}
engine.on('change', publish);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, ORIGIN); const pathname = url.pathname;
    const requestOrigin = String(req.headers.origin || '');
    if (/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin',requestOrigin); res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Headers','Content-Type'); res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH, DELETE, PUT, OPTIONS');
    }
    if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) { res.writeHead(204,{...headers}); return res.end(); }
    if (req.method === 'GET' && pathname === '/api/health') return send(res,200,{ok:true, version:'1.0.0'});
    if (req.method === 'GET' && pathname === '/api/browser/status') return send(res,200,{ok:true,minimumBytes:6*1024**3,extensionFolder:path.join(ROOT,'browser-extension')});
    if (req.method === 'GET' && pathname === '/api/bootstrap') return send(res,200,{jobs:engine.list(), settings:engine.getSettings(), system:systemInfo()});
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200,{...headers,'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'}); res.write(`event: snapshot\ndata: ${JSON.stringify({jobs:engine.list(),settings:engine.getSettings(),system:systemInfo()})}\n\n`); clients.add(res); req.on('close',()=>clients.delete(res)); return;
    }
    if (pathname.startsWith('/api/') && !['GET','HEAD'].includes(req.method)) assertLocalMutation(req);
    if (req.method === 'POST' && pathname === '/api/downloads') return send(res,201,await engine.add(await body(req)));
    if (req.method === 'POST' && pathname === '/api/browser/capture') {
      const input=await body(req), hardMinimum=6*1024**3, totalBytes=Number(input.totalBytes), requestedMinimum=Math.max(hardMinimum,Number(input.minBytes)||hardMinimum);
      if (!Number.isFinite(totalBytes) || totalBytes <= requestedMinimum) throw Object.assign(new Error(`Flux only takes over browser downloads larger than ${Math.round(requestedMinimum/1024**3)} GB`),{status:400});
      return send(res,201,await engine.add({url:input.url,filename:input.filename,headers:input.headers,source:'browser',browserName:input.browserName,minBytes:requestedMinimum,connections:engine.getSettings().defaultConnections}));
    }
    const match = pathname.match(/^\/api\/downloads\/([a-zA-Z0-9_-]+)$/);
    if (match && req.method === 'PATCH') return send(res,200,await engine.update(match[1],await body(req)));
    if (match && req.method === 'DELETE') return send(res,200,await engine.remove(match[1],{deleteFiles:url.searchParams.get('deleteFiles')==='true'}));
    const action = pathname.match(/^\/api\/downloads\/([a-zA-Z0-9_-]+)\/actions$/);
    if (action && req.method === 'POST') {
      const input = await body(req); const fn = {pause:'pause',resume:'resume',cancel:'cancel',retry:'retry'}[input.action];
      if (!fn) throw Object.assign(new Error('Unknown download action'),{status:400}); return send(res,200,await engine[fn](action[1]));
    }
    if (req.method === 'PUT' && pathname === '/api/settings') return send(res,200,await engine.updateSettings(await body(req)));
    if (req.method === 'POST' && pathname === '/api/system/open') { const input=await body(req); await openTarget(input.jobId,input.target); return send(res,200,{ok:true}); }
    if (req.method === 'POST' && pathname === '/api/system/pick-folder') return send(res,200,{path:await pickFolder()});
    if (req.method === 'POST' && pathname === '/api/system/browser-setup') return send(res,200,await openBrowserSetup());
    if (req.method === 'POST' && pathname === '/api/system/shutdown') { send(res,200,{ok:true}); setTimeout(async()=>{await engine.shutdown();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();},100); return; }
    if (pathname.startsWith('/api/')) return send(res,404,{error:'API route not found'});
    if (req.method === 'GET' || req.method === 'HEAD') return staticFile(req,res,pathname);
    send(res,405,{error:'Method not allowed'},{Allow:'GET, HEAD'});
  } catch (error) { console.error(error); send(res,error.status || (error.message==='Download not found'?404:400),{error:error.message || 'Request failed'}); }
});

function edgePath() {
  if (process.platform !== 'win32') return null;
  const candidates = [path.join(process.env['PROGRAMFILES(X86)']||'', 'Microsoft','Edge','Application','msedge.exe'), path.join(process.env.PROGRAMFILES||'', 'Microsoft','Edge','Application','msedge.exe'), path.join(process.env.LOCALAPPDATA||'', 'Microsoft','Edge','Application','msedge.exe')];
  return candidates.find(candidate => candidate && existsSync(candidate));
}

async function openApp() {
  const url = ORIGIN; const edge = edgePath();
  if (edge) spawn(edge,[`--app=${url}`,'--start-maximized'],{detached:true,stdio:'ignore'}).unref();
  else if (process.platform === 'win32') spawn('explorer.exe',[url],{detached:true,stdio:'ignore'}).unref();
  else spawn(process.platform==='darwin'?'open':'xdg-open',[url],{detached:true,stdio:'ignore'}).unref();
}

server.once('error', error => {
  if (error.code === 'EADDRINUSE' && process.argv.includes('--open')) { openApp(); process.exit(0); }
  console.error(error); process.exit(1);
});
server.listen(PORT,HOST,()=>{ console.log(`Flux is running at ${ORIGIN}`); if(process.argv.includes('--open')) openApp(); });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await engine.shutdown();server.close(()=>process.exit(0));});

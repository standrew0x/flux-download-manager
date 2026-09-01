import { app, BrowserWindow, Menu, Tray, nativeImage, session, shell } from 'electron';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.FLUXDM_PORT) || 17652;
const ORIGIN = `http://${HOST}:${PORT}`;
const ICON = path.join(ROOT, 'build', 'icon.png');

let mainWindow;
let tray;
let runtime;
let quitting = false;
let cleanupStarted = false;

app.setName('Flux Download Manager');
app.setAppUserModelId('com.standrew0x.flux');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(startDesktop).catch(error=>{
    console.error(error);
    app.quit();
  });
}

async function isFluxHealthy() {
  try {
    const response = await fetch(`${ORIGIN}/api/health`, { signal:AbortSignal.timeout(800) });
    return response.ok;
  } catch { return false; }
}

async function ensureServer() {
  if (await isFluxHealthy()) return;
  process.env.FLUXDM_ELECTRON = '1';
  process.env.FLUXDM_EXTENSION_ROOT = await prepareBrowserExtension();
  runtime = await import('./server.js');
  for (let attempt=0; attempt<40; attempt+=1) {
    if (await isFluxHealthy()) return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Flux could not start its local download service.');
}

async function prepareBrowserExtension() {
  const source = app.isPackaged
    ? path.join(process.resourcesPath, 'browser-extension')
    : path.join(ROOT, 'browser-extension');
  const destination = path.join(app.getPath('userData'), 'browser-extension');
  await mkdir(destination,{recursive:true});
  await cp(source,destination,{recursive:true,force:true});
  return destination;
}

async function startDesktop() {
  await ensureServer();
  session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  createWindow();
  createTray();
  process.on('flux:shutdown',()=>{
    quitting = true;
    app.quit();
  });
  app.on('activate',showWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width:1380,
    height:900,
    minWidth:960,
    minHeight:680,
    show:false,
    backgroundColor:'#080b12',
    icon:ICON,
    title:'Flux Download Manager',
    autoHideMenuBar:true,
    webPreferences:{
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true,
    },
  });
  mainWindow.loadURL(ORIGIN);
  mainWindow.once('ready-to-show',()=>mainWindow?.show());
  mainWindow.on('close',event=>{
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.webContents.setWindowOpenHandler(({url})=>{
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action:'deny' };
  });
  mainWindow.webContents.on('will-navigate',(event,url)=>{
    let destinationOrigin;
    try { destinationOrigin = new URL(url).origin; } catch { destinationOrigin = ''; }
    if (destinationOrigin !== ORIGIN) { event.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  let icon = nativeImage.createFromPath(ICON);
  if (!icon.isEmpty()) icon = icon.resize({width:20,height:20});
  tray = new Tray(icon);
  tray.setToolTip('Flux Download Manager');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label:'Open Flux', click:showWindow },
    { label:'Open Downloads Folder', click:openDownloadsFolder },
    { type:'separator' },
    { label:'Quit Flux', click:()=>{ quitting=true; app.quit(); } },
  ]));
  tray.on('double-click',showWindow);
}

async function openDownloadsFolder() {
  try {
    const response = await fetch(`${ORIGIN}/api/bootstrap`);
    const payload = await response.json();
    const error = await shell.openPath(payload.settings.downloadFolder);
    if (error) console.error(error);
  } catch (error) { console.error(error); }
}

app.on('window-all-closed',()=>{
  // Flux stays available in the tray so active downloads continue.
});

app.on('before-quit',event=>{
  quitting = true;
  if (cleanupStarted || !runtime?.shutdownFlux) return;
  event.preventDefault();
  cleanupStarted = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  if (tray && !tray.isDestroyed()) tray.destroy();
  runtime.shutdownFlux()
    .catch(console.error)
    .finally(()=>app.quit());
});

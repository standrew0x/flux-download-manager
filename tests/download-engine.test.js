import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DownloadStore } from '../src/store.js';
import { DownloadEngine, DEFAULT_SETTINGS, normalizeDownloadUrl } from '../src/download-engine.js';

const DATA = Buffer.alloc(10 * 1024 * 1024 + 211);
for (let i = 0; i < DATA.length; i++) DATA[i] = i % 251;

async function fixture({ slow = false } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/missing') { res.writeHead(404); res.end(); return; }
    if (req.url === '/preview') { const page=Buffer.from('<!doctype html><title>Preview</title>');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':page.length});res.end(page);return; }
    if (req.url === '/page.html') { const page=Buffer.from('<!doctype html><title>Real HTML file</title>');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':page.length});res.end(page);return; }
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    let start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : DATA.length - 1;
    end = Math.min(end, DATA.length - 1); const chunk = DATA.subarray(start, end + 1);
    const headers = { 'Content-Length':chunk.length, 'Accept-Ranges':'bytes', 'Content-Type':'application/octet-stream', 'Content-Disposition':'attachment; filename="payload.bin"', ETag:'"flux-test-v1"' };
    if (range) { headers['Content-Range'] = `bytes ${start}-${end}/${DATA.length}`; res.writeHead(206, headers); } else res.writeHead(200, headers);
    if (!slow) { res.end(chunk); return; }
    let offset = 0; const send = () => { if (res.destroyed) return; const next = chunk.subarray(offset, offset + 64 * 1024); if (!next.length) { res.end(); return; } res.write(next); offset += next.length; setTimeout(send, 8); }; send();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); return { url:`http://127.0.0.1:${address.port}`, close:()=>new Promise(resolve=>server.close(resolve)) };
}

async function waitFor(engine, predicate, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const job = engine.list()[0]; if (job && predicate(job)) return job; await new Promise(resolve=>setTimeout(resolve,30)); }
  throw new Error(`Timed out; last state: ${JSON.stringify(engine.list()[0])}`);
}

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(),'flux-test-')); const store = new DownloadStore({ rootDir:path.join(root,'state'), defaultSettings:{...DEFAULT_SETTINGS,maxRetries:2} }); const engine = new DownloadEngine({store}); await engine.init();
  t.after(async()=>{await engine.shutdown();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});}); return {root,engine};
}

test('segmented download completes byte-perfectly with collision-safe output', async t => {
  const remote=await fixture();t.after(remote.close);const {root,engine}=await setup(t);const downloads=path.join(root,'downloads');
  await engine.add({url:`${remote.url}/file`,destination:downloads,connections:4});
  const done=await waitFor(engine,j=>j.status==='complete',20000);assert.equal(done.supportsRanges,true);assert.ok(done.segmentCount>1);assert.deepEqual(await readFile(done.outputPath),DATA);
});

test('pause preserves partial data and resume finishes the transfer', async t => {
  const remote=await fixture({slow:true});t.after(remote.close);const {root,engine}=await setup(t);await engine.updateSettings({maxConcurrent:1});
  const added=await engine.add({url:`${remote.url}/slow`,destination:path.join(root,'downloads'),connections:1});
  await waitFor(engine,j=>j.status==='downloading'&&j.downloadedBytes>128*1024);await engine.pause(added.id);const paused=await waitFor(engine,j=>j.status==='paused');assert.ok(paused.downloadedBytes>0);
  await engine.resume(added.id);const done=await waitFor(engine,j=>j.status==='complete',20000);assert.deepEqual(await readFile(done.outputPath),DATA);
});

test('permanent HTTP errors fail without an infinite retry loop', async t => {
  const remote=await fixture();t.after(remote.close);const {root,engine}=await setup(t);await engine.add({url:`${remote.url}/missing`,destination:path.join(root,'downloads')});
  const failed=await waitFor(engine,j=>j.status==='failed');assert.match(failed.error,/HTTP 404/);assert.equal(failed.retries,0);
});

test('Dropbox preview links are normalized to direct downloads', () => {
  const normalized=normalizeDownloadUrl('https://www.dropbox.com/scl/fi/example/video.mov?rlkey=secret&st=share&dl=0');
  assert.equal(normalized.searchParams.get('dl'),'1');assert.equal(normalized.searchParams.get('rlkey'),'secret');assert.equal(normalized.searchParams.get('st'),'share');
});

test('HTML preview pages fail immediately instead of becoming fake downloads', async t => {
  const remote=await fixture();t.after(remote.close);const {root,engine}=await setup(t);await engine.add({url:`${remote.url}/preview`,destination:path.join(root,'downloads'),filename:'video.mov'});
  const failed=await waitFor(engine,j=>j.status==='failed');assert.match(failed.error,/HTML preview or error page/);assert.equal(failed.retries,0);await assert.rejects(readFile(failed.outputPath),{code:'ENOENT'});
});

test('explicit HTML files remain downloadable', async t => {
  const remote=await fixture();t.after(remote.close);const {root,engine}=await setup(t);await engine.add({url:`${remote.url}/page.html`,destination:path.join(root,'downloads')});
  const done=await waitFor(engine,j=>j.status==='complete');assert.match((await readFile(done.outputPath)).toString(),/Real HTML file/);
});

import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, appendFile, copyFile, mkdir, open, readFile, rename, rm, stat, truncate, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DownloadStore } from './store.js';

export const DEFAULT_SETTINGS = {
  maxConcurrent: 3,
  defaultConnections: 4,
  downloadFolder: path.join(os.homedir(), 'Downloads'),
  speedLimit: 0,
  notifications: true,
  autoResume: true,
  theme: 'dark',
  maxRetries: 6,
};

const ACTIVE = new Set(['probing', 'downloading', 'merging', 'verifying']);
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const PRIORITY = { high: 0, normal: 1, low: 2 };

class HttpError extends Error {
  constructor(status, message, retryAfter = 0) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.retryable = RETRYABLE_STATUS.has(status);
    this.retryAfter = retryAfter;
  }
}

class RangeRejected extends Error {}

const iso = () => new Date().toISOString();
const clone = value => structuredClone(value);
const exists = async value => access(value).then(() => true, () => false);
const cleanName = value => String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 220) || 'download.bin';

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = url.username ? '***' : '';
    url.password = url.password ? '***' : '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|auth|signature|secret|password/i.test(key)) url.searchParams.set(key, '***');
    }
    return url.toString();
  } catch { return String(value); }
}

function safeRequestHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = new Map([['cookie','Cookie'],['referer','Referer'],['user-agent','User-Agent'],['authorization','Authorization']]);
  const result = {};
  for (const [name, raw] of Object.entries(value)) {
    const canonical = allowed.get(String(name).toLowerCase());
    if (canonical && typeof raw === 'string' && raw.length <= 16384 && !/[\r\n]/.test(raw)) result[canonical] = raw;
  }
  return result;
}

function filenameFromHeaders(headers, url) {
  const disposition = headers.get('content-disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  let candidate = encoded ? decodeURIComponent(encoded) : plain;
  if (!candidate) {
    try { candidate = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch {}
  }
  return cleanName(candidate || 'download.bin');
}

function parseContentRange(value) {
  const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  return match ? { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) } : null;
}

function classifyCategory(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (['.mp4','.mkv','.mov','.avi','.webm','.m4v','.mp3','.wav','.flac','.m4a'].includes(ext)) return 'video';
  if (['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.txt','.csv','.epub'].includes(ext)) return 'documents';
  if (['.zip','.rar','.7z','.tar','.gz','.bz2','.xz'].includes(ext)) return 'archives';
  if (['.exe','.msi','.dmg','.pkg','.apk','.iso'].includes(ext)) return 'software';
  return 'other';
}

function abortError() { return new DOMException('Download interrupted', 'AbortError'); }
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

export class DownloadEngine extends EventEmitter {
  constructor({ store = new DownloadStore({ defaultSettings: DEFAULT_SETTINGS }) } = {}) {
    super();
    this.store = store;
    this.jobs = new Map();
    this.settings = clone(DEFAULT_SETTINGS);
    this.active = new Map();
    this.running = new Map();
    this.lastSaved = new Map();
    this.timer = null;
    this.pumping = false;
  }

  async init() {
    await this.store.init();
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.store.settings()) };
    for (const loaded of await this.store.load()) {
      if (ACTIVE.has(loaded.status)) loaded.status = this.settings.autoResume ? 'queued' : 'paused';
      loaded.speedBps = 0; loaded.etaSeconds = null;
      this.jobs.set(loaded.id, loaded);
      await this.store.save(loaded);
    }
    this.timer = setInterval(() => this.#pump(), 500);
    this.timer.unref?.();
    queueMicrotask(() => this.#pump());
    return this;
  }

  list() { return [...this.jobs.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(job => { const copy=clone(job); for(const key of Object.keys(copy))if(key.startsWith('_'))delete copy[key]; return copy; }); }
  getSettings() { return clone(this.settings); }

  async updateSettings(patch = {}) {
    const next = { ...this.settings };
    if ('maxConcurrent' in patch) next.maxConcurrent = Math.max(1, Math.min(20, Number(patch.maxConcurrent) || 1));
    if ('defaultConnections' in patch) next.defaultConnections = Math.max(1, Math.min(16, Number(patch.defaultConnections) || 1));
    if ('downloadFolder' in patch) next.downloadFolder = path.resolve(String(patch.downloadFolder));
    if ('speedLimit' in patch) next.speedLimit = Math.max(0, Number(patch.speedLimit) || 0);
    if ('notifications' in patch) next.notifications = Boolean(patch.notifications);
    if ('autoResume' in patch) next.autoResume = Boolean(patch.autoResume);
    if ('theme' in patch && ['dark','light','system'].includes(patch.theme)) next.theme = patch.theme;
    this.settings = await this.store.settings(next);
    this.#broadcast(); this.#pump();
    return this.getSettings();
  }

  async add(spec = {}) {
    let parsed;
    try { parsed = new URL(String(spec.url || '')); } catch { throw new TypeError('Enter a valid HTTP or HTTPS URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('Only HTTP and HTTPS downloads are supported');
    const directory = path.resolve(String(spec.destination || spec.directory || this.settings.downloadFolder));
    await mkdir(directory, { recursive: true });
    const automaticName = !String(spec.filename || '').trim();
    const filename = cleanName(spec.filename || decodeURIComponent(parsed.pathname.split('/').pop() || '') || 'download.bin');
    const id = randomUUID().replaceAll('-', '').slice(0, 16);
    const scheduledAt = spec.scheduleAt ? new Date(spec.scheduleAt).toISOString() : null;
    if (scheduledAt && Number.isNaN(Date.parse(scheduledAt))) throw new TypeError('Scheduled start time is invalid');
    const job = {
      id, url: parsed.toString(), displayUrl: redactUrl(parsed.toString()), directory, filename,
      outputPath: path.join(directory, filename), automaticName,
      category: spec.category && spec.category !== 'auto' ? spec.category : classifyCategory(filename),
      connections: Math.max(1, Math.min(16, Number(spec.connections) || this.settings.defaultConnections)),
      priority: ['high','normal','low'].includes(spec.priority) ? spec.priority : 'normal',
      speedLimit: Math.max(0, Number(spec.speedLimit) || 0), expectedSha256: String(spec.sha256 || '').toLowerCase() || null,
      source: spec.source === 'browser' ? 'browser' : 'app', browserName: spec.browserName ? String(spec.browserName).slice(0,80) : null,
      minBytes: spec.minBytes ? Math.max(1, Number(spec.minBytes)) : null, _requestHeaders: safeRequestHeaders(spec.headers),
      status: scheduledAt && Date.parse(scheduledAt) > Date.now() ? 'scheduled' : 'queued', scheduledAt,
      createdAt: iso(), updatedAt: iso(), completedAt: null, downloadedBytes: 0, totalBytes: null,
      speedBps: 0, etaSeconds: null, retries: 0, supportsRanges: null, etag: null, lastModified: null,
      error: null, events: [],
    };
    this.#event(job, 'info', job.status === 'scheduled' ? `Scheduled for ${new Date(scheduledAt).toLocaleString()}` : job.source === 'browser' ? `Captured from ${job.browserName || 'browser'}` : 'Added to the queue');
    this.jobs.set(id, job); await this.store.save(job); this.#broadcast(); this.#pump();
    return clone(job);
  }

  async pause(id) {
    const job = this.#job(id);
    if (!ACTIVE.has(job.status) && !['queued','scheduled'].includes(job.status)) throw new Error(`Cannot pause a ${job.status} download`);
    job.status = 'paused'; job.speedBps = 0; job.etaSeconds = null; this.#event(job, 'info', 'Paused; partial data is preserved');
    this.active.get(id)?.abort(); await this.#save(job, true); return clone(job);
  }

  async resume(id) {
    const job = this.#job(id);
    if (!['paused','failed','cancelled','scheduled'].includes(job.status)) throw new Error(`Cannot resume a ${job.status} download`);
    job.status = 'queued'; job.scheduledAt = null; job.error = null; this.#event(job, 'info', 'Returned to the queue');
    await this.#save(job, true); this.#pump(); return clone(job);
  }

  async cancel(id) {
    const job = this.#job(id);
    if (job.status === 'complete') throw new Error('A completed download cannot be cancelled');
    job.status = 'cancelled'; job.speedBps = 0; job.etaSeconds = null; this.#event(job, 'warning', 'Cancelled; partial data is preserved');
    this.active.get(id)?.abort(); await this.#save(job, true); return clone(job);
  }

  async retry(id) {
    const job = this.#job(id);
    job.status = 'queued'; job.error = null; job.retries = 0; this.#event(job, 'info', 'Retry requested');
    await this.#save(job, true); this.#pump(); return clone(job);
  }

  async update(id, patch = {}) {
    const job = this.#job(id);
    if (patch.priority && PRIORITY[patch.priority] !== undefined) job.priority = patch.priority;
    if ('speedLimit' in patch) job.speedLimit = Math.max(0, Number(patch.speedLimit) || 0);
    if (patch.category) job.category = String(patch.category);
    if (patch.scheduleAt && !ACTIVE.has(job.status)) { job.scheduledAt = new Date(patch.scheduleAt).toISOString(); job.status = 'scheduled'; }
    await this.#save(job, true); this.#pump(); return clone(job);
  }

  async remove(id, { deleteFiles = false } = {}) {
    const job = this.#job(id); this.active.get(id)?.abort(); this.active.delete(id);
    if (deleteFiles) await unlink(job.outputPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await this.store.removeStaging(id); await this.store.remove(id); this.jobs.delete(id); this.#broadcast();
    return job;
  }

  async shutdown() {
    clearInterval(this.timer);
    for (const [id, controller] of this.active) { const job = this.jobs.get(id); if (job) job.status = 'queued'; controller.abort(); }
    await Promise.allSettled([...this.running.values()]);
    await Promise.all([...this.jobs.values()].map(job => this.store.save(job)));
  }

  #job(id) { const job = this.jobs.get(String(id)); if (!job) throw new Error('Download not found'); return job; }
  #event(job, level, message) { job.events = [...(job.events || []), { at: iso(), level, message }].slice(-80); job.updatedAt = iso(); }
  #broadcast() { this.emit('change', { jobs: this.list(), settings: this.getSettings() }); }
  async #save(job, force = false) {
    job.updatedAt = iso(); const now = Date.now(); const last = this.lastSaved.get(job.id) || 0;
    if (force || now - last > 900) { this.lastSaved.set(job.id, now); await this.store.save(job); }
    this.#broadcast();
  }

  async #pump() {
    if (this.pumping) return; this.pumping = true;
    try {
      for (const job of this.jobs.values()) if (job.status === 'scheduled' && Date.parse(job.scheduledAt) <= Date.now()) { job.status = 'queued'; await this.#save(job, true); }
      const slots = Math.max(0, this.settings.maxConcurrent - this.active.size);
      const queued = [...this.jobs.values()].filter(j => j.status === 'queued').sort((a,b) => (PRIORITY[a.priority]-PRIORITY[b.priority]) || a.createdAt.localeCompare(b.createdAt));
      for (const job of queued.slice(0, slots)) {
        const controller = new AbortController(); this.active.set(job.id, controller);
        const running = this.#run(job, controller.signal).finally(() => { this.active.delete(job.id); this.running.delete(job.id); this.#broadcast(); this.#pump(); });
        this.running.set(job.id, running);
      }
    } finally { this.pumping = false; }
  }

  async #run(job, signal) {
    try {
      job.status = 'probing'; job.error = null; this.#event(job, 'info', 'Inspecting server capabilities'); await this.#save(job, true);
      const probe = await this.#retry(job, signal, () => this.#probe(job, signal));
      Object.assign(job, probe);
      if (job.minBytes && job.totalBytes && job.totalBytes <= job.minBytes) throw new Error(`Browser capture threshold not reached (${Math.round(job.minBytes/1024/1024/1024)} GB minimum)`);
      if (job.automaticName) {
        job.filename = probe.probedFilename; job.category = classifyCategory(job.filename); job.outputPath = path.join(job.directory, job.filename);
      }
      job.outputPath = await this.#uniqueOutput(job);
      job.filename = path.basename(job.outputPath);
      const staging = this.store.stagingDir(job.id); await mkdir(staging, { recursive: true });
      job.status = 'downloading'; this.#event(job, 'info', job.supportsRanges && job.totalBytes ? `Downloading with ${job.segmentCount} connections` : 'Downloading as a single stream'); await this.#save(job, true);
      let source;
      if (job.supportsRanges && job.totalBytes && job.segmentCount > 1) {
        try { source = await this.#segmented(job, staging, signal); }
        catch (error) {
          if (!(error instanceof RangeRejected)) throw error;
          await rm(staging,{recursive:true,force:true}); await mkdir(staging,{recursive:true}); job.supportsRanges=false; job.segmentCount=1; job.downloadedBytes=0;
          this.#event(job,'warning','Server rejected segmented ranges; continuing as a safe single stream'); await this.#save(job,true); source=await this.#single(job,staging,signal);
        }
      } else source = await this.#single(job, staging, signal);
      job.status = job.expectedSha256 ? 'verifying' : 'merging'; job.speedBps = 0; job.etaSeconds = 0; await this.#save(job, true);
      const finalPath = await this.#finalize(job, source, signal);
      job.outputPath = finalPath; job.filename = path.basename(finalPath); job.status = 'complete'; job.completedAt = iso(); job.downloadedBytes = job.totalBytes || (await stat(finalPath)).size; job.totalBytes ||= job.downloadedBytes;
      this.#event(job, 'success', 'Download completed and verified'); await this.store.removeStaging(job.id); await this.#save(job, true);
    } catch (error) {
      if (error?.name === 'AbortError' && ['paused','cancelled','queued'].includes(job.status)) return;
      job.status = 'failed'; job.speedBps = 0; job.etaSeconds = null; job.error = error?.message || String(error); this.#event(job, 'error', job.error); await this.#save(job, true);
    }
  }

  async #probe(job, signal) {
    const response = await fetch(job.url, { headers: { 'User-Agent': 'Flux/1.0', ...job._requestHeaders, Range: 'bytes=0-0' }, redirect: 'follow', signal });
    if (!response.ok) throw this.#httpError(response);
    const range = parseContentRange(response.headers.get('content-range'));
    const supportsRanges = response.status === 206 && Boolean(range);
    const totalBytes = supportsRanges ? range.total : Number(response.headers.get('content-length')) || null;
    const probedFilename = filenameFromHeaders(response.headers, response.url);
    await response.body?.cancel();
    const segmentCount = supportsRanges && totalBytes ? Math.max(1, Math.min(job.connections, Math.ceil(totalBytes / (8 * 1024 * 1024)))) : 1;
    return { finalUrl: response.url, supportsRanges, totalBytes, probedFilename, segmentCount, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
  }

  #httpError(response) {
    const retry = Number(response.headers.get('retry-after')) || 0;
    return new HttpError(response.status, `Server returned HTTP ${response.status}`, retry * 1000);
  }

  async #retry(job, signal, operation) {
    let attempt = 0;
    while (true) {
      try { return await operation(); }
      catch (error) {
        if (error?.name === 'AbortError' || error instanceof RangeRejected) throw error;
        attempt += 1;
        if (error instanceof HttpError && !error.retryable) throw error;
        if (attempt > this.settings.maxRetries) throw new Error(`Retry limit reached: ${error.message}`);
        job.retries += 1; const delay = error.retryAfter || Math.min(30000, 700 * 2 ** (attempt - 1) + Math.random() * 400);
        this.#event(job, 'warning', `Retry ${attempt}/${this.settings.maxRetries} in ${Math.ceil(delay/1000)}s — ${error.message}`); await this.#save(job, true); await sleep(delay, signal);
      }
    }
  }

  #rangeHeaders(job, start, end) {
    const headers = { 'User-Agent': 'Flux/1.0', ...job._requestHeaders, Range: `bytes=${start}-${end}` };
    if (job.etag || job.lastModified) headers['If-Range'] = job.etag || job.lastModified;
    return headers;
  }

  async #segmented(job, staging, signal) {
    const size = Math.ceil(job.totalBytes / job.segmentCount);
    const progress = [];
    const paths = Array.from({length: job.segmentCount}, (_, i) => path.join(staging, `segment-${i}.part`));
    for (let i=0;i<paths.length;i++) progress[i] = await stat(paths[i]).then(s => s.size, () => 0);
    job.downloadedBytes = progress.reduce((a,b)=>a+b,0); this.#resetSpeed(job);
    const local = new AbortController(); const segmentSignal = AbortSignal.any([signal, local.signal]);
    const tasks = paths.map((file, index) => this.#retry(job, segmentSignal, async () => {
      const start = index * size, end = Math.min(job.totalBytes - 1, start + size - 1), expected = end - start + 1;
      let current = await stat(file).then(s=>s.size,()=>0); if (current === expected) return;
      if (current > expected) { await truncate(file, 0); current = 0; progress[index] = 0; }
      const requested = start + current;
      const response = await fetch(job.finalUrl || job.url, { headers: this.#rangeHeaders(job, requested, end), signal });
      if (response.status !== 206) { await response.body?.cancel(); throw new RangeRejected('Server stopped honoring byte ranges'); }
      const range = parseContentRange(response.headers.get('content-range'));
      if (!range || range.start !== requested || range.end !== end || range.total !== job.totalBytes) { await response.body?.cancel(); throw new RangeRejected('Server returned an invalid byte range'); }
      for await (const chunk of response.body) { if (signal.aborted) throw abortError(); await appendFile(file, chunk); progress[index] += chunk.length; await this.#progress(job, progress.reduce((a,b)=>a+b,0), chunk.length, signal); }
      if ((await stat(file)).size !== expected) throw new Error(`Segment ${index + 1} ended early`);
    }));
    try { await Promise.all(tasks); } catch (error) { local.abort(); await Promise.allSettled(tasks); throw error; }
    job.status = 'merging'; await this.#save(job, true);
    const merged = path.join(staging, 'merged.part'); await rm(merged, { force: true });
    for (const file of paths) await pipeline(createReadStream(file), createWriteStream(merged,{flags:'a'}));
    if ((await stat(merged)).size !== job.totalBytes) throw new Error('Merged size does not match the server size');
    return merged;
  }

  async #single(job, staging, signal) {
    const partial = path.join(staging, 'download.part'); let existing = await stat(partial).then(s=>s.size,()=>0); this.#resetSpeed(job); job.downloadedBytes = existing;
    await this.#retry(job, signal, async () => {
      existing = await stat(partial).then(s=>s.size,()=>0);
      const headers = { 'User-Agent':'Flux/1.0', ...job._requestHeaders };
      if (existing) { headers.Range = `bytes=${existing}-`; if (job.etag || job.lastModified) headers['If-Range'] = job.etag || job.lastModified; }
      const response = await fetch(job.finalUrl || job.url, { headers, signal });
      if (!response.ok) throw this.#httpError(response);
      let append = existing > 0 && response.status === 206;
      if (append) { const range = parseContentRange(response.headers.get('content-range')); if (!range || range.start !== existing || (job.totalBytes && range.total !== job.totalBytes)) throw new RangeRejected('Resume validator changed; restarting safely'); }
      if (!append) { await truncate(partial, 0).catch(()=>{}); existing = 0; job.downloadedBytes = 0; }
      if (!job.totalBytes) job.totalBytes = (Number(response.headers.get('content-length')) || 0) + existing || null;
      for await (const chunk of response.body) { if (signal.aborted) throw abortError(); await appendFile(partial, chunk); existing += chunk.length; await this.#progress(job, existing, chunk.length, signal); }
      if (job.totalBytes && existing !== job.totalBytes) throw new Error(`Transfer ended at ${existing} of ${job.totalBytes} bytes`);
    });
    return partial;
  }

  #resetSpeed(job) { job._speedStarted = Date.now(); job._speedBytes = job.downloadedBytes || 0; job._limitStarted = Date.now(); job._limitBytes = 0; }
  async #progress(job, total, delta, signal) {
    job.downloadedBytes = total;
    const elapsed = Math.max(.1, (Date.now() - job._speedStarted) / 1000); job.speedBps = Math.max(0, (total - job._speedBytes) / elapsed); job.etaSeconds = job.totalBytes && job.speedBps ? Math.max(0, (job.totalBytes-total)/job.speedBps) : null;
    const limit = job.speedLimit || this.settings.speedLimit;
    if (limit > 0) { job._limitBytes += delta; const ideal = job._limitBytes / limit * 1000, actual = Date.now() - job._limitStarted; if (ideal > actual) await sleep(Math.min(ideal-actual, 1000), signal); }
    await this.#save(job);
  }

  async #uniqueOutput(job) {
    const reserved = new Set([...this.jobs.values()].filter(j=>j.id!==job.id && j.status!=='failed' && j.status!=='cancelled').map(j=>path.resolve(j.outputPath).toLowerCase()));
    const ext = path.extname(job.filename), stem = path.basename(job.filename, ext); let attempt = 0, candidate;
    do { candidate = path.join(job.directory, attempt ? `${stem} (${attempt})${ext}` : job.filename); attempt++; } while (reserved.has(path.resolve(candidate).toLowerCase()) || await exists(candidate));
    return candidate;
  }

  async #finalize(job, source, signal) {
    if (signal.aborted) throw abortError(); await mkdir(job.directory, { recursive: true });
    const finalPath = await this.#uniqueOutput(job); const temporary = `${finalPath}.flux-${job.id}.tmp`; await copyFile(source, temporary);
    if (job.expectedSha256) {
      if (!/^[a-f0-9]{64}$/i.test(job.expectedSha256)) throw new Error('Expected SHA-256 must contain 64 hexadecimal characters');
      const hash = createHash('sha256'); for await (const chunk of createReadStream(temporary)) hash.update(chunk);
      const actual = hash.digest('hex'); if (actual !== job.expectedSha256) { await rm(temporary,{force:true}); throw new Error(`SHA-256 mismatch (received ${actual})`); }
    }
    await rename(temporary, finalPath); return finalPath;
  }
}

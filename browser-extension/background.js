const FLUX = 'http://127.0.0.1:17652';
const GIB = 1024 ** 3;
const DEFAULTS = { enabled: true, thresholdGiB: 6, capturedCount: 0, lastCapture: null, lastError: null };
const handling = new Set();

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

function browserName() {
  const agent = navigator.userAgent;
  if (/Edg\//.test(agent)) return 'Microsoft Edge';
  if (/OPR\//.test(agent)) return 'Opera';
  if (/Vivaldi\//.test(agent)) return 'Vivaldi';
  if (/Brave/i.test(agent)) return 'Brave';
  return 'Google Chrome';
}

async function setBadge(enabled) {
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#baff36' : '#707779' });
  await chrome.action.setBadgeTextColor?.({ color: '#111511' }).catch(() => {});
  await chrome.action.setBadgeText({ text: enabled ? '6+' : 'OFF' });
}

async function fluxFetch(path, options = {}) {
  const response = await fetch(`${FLUX}${path}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
  });
  let value = {};
  try { value = await response.json(); } catch {}
  if (!response.ok) throw new Error(value.error || `Flux returned ${response.status}`);
  return value;
}

async function resolveSize(item) {
  if (Number(item.totalBytes) > 0) return Number(item.totalBytes);
  const url = item.finalUrl || item.url;
  try {
    const head = await fetch(url, { method: 'HEAD', credentials: 'include', redirect: 'follow', cache: 'no-store' });
    const length = Number(head.headers.get('content-length'));
    if (Number.isFinite(length) && length > 0) return length;
  } catch {}
  try {
    const probe = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', redirect: 'follow', cache: 'no-store' });
    const range = probe.headers.get('content-range')?.match(/\/(\d+)$/);
    const length = range ? Number(range[1]) : Number(probe.headers.get('content-length'));
    await probe.body?.cancel();
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch { return null; }
}

async function requestHeaders(item) {
  const url = item.finalUrl || item.url;
  const headers = { 'User-Agent': navigator.userAgent };
  if (item.referrer) headers.Referer = item.referrer;
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (cookies.length) headers.Cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  } catch {}
  return headers;
}

function basename(filename, url) {
  const fromBrowser = String(filename || '').split(/[\\/]/).pop();
  if (fromBrowser) return fromBrowser;
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || undefined; } catch { return undefined; }
}

async function rollbackFlux(jobId) {
  if (!jobId) return;
  await fluxFetch(`/api/downloads/${jobId}?deleteFiles=false`, { method: 'DELETE', body: '{}' }).catch(() => {});
}

async function consider(item) {
  if (!item || handling.has(item.id) || item.state !== 'in_progress') return;
  if (!/^https?:/i.test(item.finalUrl || item.url || '')) return;
  if (item.danger && item.danger !== 'safe') return;
  const config = await settings();
  if (!config.enabled) return;
  handling.add(item.id);
  let accepted;
  try {
    const totalBytes = await resolveSize(item);
    const threshold = Math.max(6, Number(config.thresholdGiB) || 6) * GIB;
    if (!totalBytes || totalBytes <= threshold) return;
    await fluxFetch('/api/browser/status');
    const url = item.finalUrl || item.url;
    accepted = await fluxFetch('/api/browser/capture', {
      method: 'POST',
      body: JSON.stringify({
        url,
        filename: basename(item.filename, url),
        totalBytes,
        minBytes: threshold,
        browserName: browserName(),
        headers: await requestHeaders(item),
      }),
    });
    const current = (await chrome.downloads.search({ id: item.id }))[0];
    if (!current || current.state !== 'in_progress') {
      await rollbackFlux(accepted.id);
      return;
    }
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
    const capturedCount = Number(config.capturedCount || 0) + 1;
    await chrome.storage.local.set({ capturedCount, lastCapture: { filename: accepted.filename, at: Date.now(), bytes: totalBytes }, lastError: null });
    await chrome.action.setBadgeText({ text: '✓' });
    setTimeout(() => setBadge(true), 2500);
  } catch (error) {
    if (accepted?.id) await rollbackFlux(accepted.id);
    await chrome.storage.local.set({ lastError: String(error?.message || error), lastErrorAt: Date.now() });
  } finally {
    handling.delete(item.id);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ ...DEFAULTS, ...current });
  await setBadge(current.enabled ?? true);
});
chrome.runtime.onStartup.addListener(async () => setBadge((await settings()).enabled));
chrome.storage.onChanged.addListener(async changes => { if (changes.enabled || changes.thresholdGiB) await setBadge((await settings()).enabled); });
chrome.downloads.onCreated.addListener(item => { consider(item); });
chrome.downloads.onChanged.addListener(async delta => {
  if (delta.totalBytes?.current > 0 || delta.state?.current === 'in_progress') {
    const item = (await chrome.downloads.search({ id: delta.id }))[0];
    if (item) consider(item);
  }
});
setBadge(true);

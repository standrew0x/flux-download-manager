# Flux Download Manager

**A fast, resilient, local-first download manager for Windows.** Flux combines accelerated multi-connection transfers with persistent queues, safe resume, scheduling, integrity verification, and a polished desktop dashboard.

## Highlights

### Fast, resilient downloads

- Accelerated segmented downloads with up to 16 parallel connections
- Pause and resume without losing downloaded data
- Automatic recovery after closing Flux or restarting Windows
- Bounded retries with exponential backoff for temporary network failures
- Safe handling of servers that stop supporting byte ranges
- Live transfer speed, progress, downloaded size, and ETA

### Browser capture for very large files

- Automatically takes over browser downloads larger than 6 GB
- Leaves downloads of 6 GB or less in the browser
- Supports Microsoft Edge, Google Chrome, Opera, Brave, Vivaldi, and other Chromium browsers
- Preserves authenticated cookies and referrer information for signed-in downloads
- Cancels the browser transfer only after Flux confirms the handoff
- Never bypasses browser malware or unsafe-download warnings

### Queue and bandwidth control

- Persistent download queue with configurable concurrency
- High, normal, and low priorities
- Schedule downloads for a specific date and time
- Per-download and global speed limits
- Pause, resume, retry, cancel, remove, and restart controls

### File integrity and safety

- Strict `Content-Range` validation for every segment
- ETag, Last-Modified, and If-Range validation across resumes
- Optional SHA-256 checksum verification
- Atomic final-file placement so incomplete files never appear finished
- Collision-safe filenames and per-job staging directories
- Permanent HTTP errors fail immediately instead of retrying forever

### Desktop experience

- Responsive dark and light dashboard
- Search, sorting, categories, and status filters
- Detailed activity timeline and error diagnostics
- Configurable download folder and default connection count
- Desktop completion notifications
- Native open-file, open-folder, and folder-picker actions
- Keyboard shortcuts and accessible controls

### Local-first privacy

- Runs entirely on the local computer
- No analytics, cloud account, or third-party Flux service
- Local API binds only to `127.0.0.1`
- State-changing requests are protected by origin checks
- Sensitive URL credentials are redacted in the interface and logs

## Quick start

Requirements:

- Windows 10 or 11
- Node.js 24 or newer
- Microsoft Edge, Chrome, Opera, or another modern browser

Clone the repository, then double-click **`Download Manager.cmd`**. Flux starts its local service and opens the dashboard in a desktop-style browser window. Active downloads continue if the window is closed.

For development:

```powershell
npm start
npm test
```

## Enable automatic browser takeover

1. Double-click **`Setup Browser Capture.cmd`**.
2. Enable **Developer mode** on each browser's Extensions page.
3. Choose **Load unpacked**.
4. Select the repository's `browser-extension` folder.

After this one-time setup, the Flux Capture extension leaves ordinary downloads alone and hands HTTP(S) downloads larger than 6 GB to the local Flux service.

## Data storage

Job state and partial files are stored under `%APPDATA%\Flux Download Manager`. Full download URLs must remain in local job state so signed or tokenized transfers can resume; credentials and sensitive query values are redacted from the dashboard and event history.

## V1 scope

Flux downloads direct HTTP(S) resources. It does not bypass DRM, decrypt protected streams, scrape media hidden behind site-specific players, replace browser security warnings, download torrents, or configure proxies.

The original Python/Tkinter prototype remains in the repository for reference. The supported V1 entry point is `server.js`, launched through `Download Manager.cmd`.

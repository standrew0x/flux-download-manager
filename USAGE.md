# Flux quick start

1. Double-click `Download Manager.cmd`.
2. Choose **Add download** or press `Ctrl+N`.
3. Paste an HTTP(S) URL, choose the destination, and adjust advanced options if needed.
4. Use the row controls to pause, resume, retry, open, or inspect a download.

Useful shortcuts:

- `Ctrl+N` — new download
- `Ctrl+F` — search downloads
- `Ctrl+,` — settings
- `Escape` — close the active dialog or drawer

Closing the Flux window does not stop active downloads. Open `Download Manager.cmd` again to return to the dashboard. Use **Quit Flux** in Settings when you want to stop the local service; active transfers are preserved and return to the queue on the next launch.

## Capture large browser downloads

Run `Setup Browser Capture.cmd` once, then use **Load unpacked** in each browser's Extensions page and select the `browser-extension` folder. After that, browser downloads larger than 6 GB automatically move to Flux. Downloads of 6 GB or less continue normally in the browser.

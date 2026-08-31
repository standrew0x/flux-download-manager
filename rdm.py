#!/usr/bin/env python3
"""Resilient Download Manager: persistent, resumable HTTP(S) downloads."""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import datetime as dt
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable


APP_NAME = "Resilient Download Manager"
USER_AGENT = "Mozilla/5.0 RDM/1.0"
DEFAULT_STATE_ROOT = Path.home() / ".rdm"
CHUNK_SIZE = 1024 * 1024
CONTROL_POLL_SECONDS = 0.1
ACTIVE_STATES = {"queued", "probing", "downloading", "retrying", "merging", "pausing", "cancelling"}
VIDEO_EXTENSIONS = {
    ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".wmv", ".mts", ".m2ts", ".mpg", ".mpeg"
}


class PauseRequested(Exception):
    pass


class CancelRequested(Exception):
    pass


class RangeRejected(Exception):
    pass


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat()


def human_bytes(value: float | int | None) -> str:
    if value is None:
        return "?"
    size = float(value)
    units = ["B", "KB", "MB", "GB", "TB"]
    for unit in units:
        if abs(size) < 1024 or unit == units[-1]:
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} TB"


def human_duration(seconds: float | int | None) -> str:
    if seconds is None or not math.isfinite(float(seconds)) or seconds < 0:
        return "?"
    seconds = int(seconds)
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


def atomic_json_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_json(path: Path, default: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return {} if default is None else dict(default)


def normalize_dropbox_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if "dropbox.com" not in parsed.netloc.lower():
        return url
    query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    query["dl"] = "1"
    query.pop("raw", None)
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query)))


def safe_default_filename(url: str) -> str:
    name = urllib.parse.unquote(Path(urllib.parse.urlparse(url).path).name)
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return name or "download.bin"


def process_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        # Unlike POSIX, os.kill(pid, 0) is not a safe liveness probe on
        # Windows: non-console signals are implemented with TerminateProcess.
        # Query the process handle instead so checking status cannot kill the
        # worker it is observing.
        import ctypes
        from ctypes import wintypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel32.CloseHandle.restype = wintypes.BOOL

        handle = kernel32.OpenProcess(process_query_limited_information, False, int(pid))
        if not handle:
            return ctypes.get_last_error() == 5  # Access denied still means it exists.
        try:
            exit_code = wintypes.DWORD()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


class JobStore:
    def __init__(self, job_id: str, root: Path = DEFAULT_STATE_ROOT):
        self.job_id = job_id
        self.root = root
        self.directory = root / "jobs" / job_id
        self.state_path = self.directory / "state.json"
        self.control_path = self.directory / "control.json"
        self.log_path = self.directory / "worker.log"
        self._lock = threading.RLock()

    def read_state(self) -> dict[str, Any]:
        return read_json(self.state_path)

    def update_state(self, **changes: Any) -> dict[str, Any]:
        with self._lock:
            state = self.read_state()
            state.update(changes)
            state["updated_at"] = now_iso()
            atomic_json_write(self.state_path, state)
            return state

    def read_action(self) -> str:
        return str(read_json(self.control_path, {"action": "run"}).get("action", "run"))

    def set_action(self, action: str) -> None:
        atomic_json_write(self.control_path, {"action": action, "updated_at": now_iso()})

    def log(self, message: str) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(f"[{now_iso()}] {message}\n")


def reconcile_job(store: JobStore) -> dict[str, Any]:
    """Resolve active-looking jobs whose worker process has already exited."""
    state = store.read_state()
    if not state or state.get("status") not in ACTIVE_STATES:
        return state
    if process_alive(state.get("pid")):
        return state

    action = store.read_action()
    status = str(state.get("status", ""))
    if action == "pause" or status == "pausing":
        changes = {"status": "paused", "error": None}
        message = "Paused after the worker process stopped; partial data was preserved"
    elif action == "cancel" or status == "cancelling":
        changes = {"status": "cancelled", "error": None}
        message = "Cancelled after the worker process stopped; partial data was preserved"
    else:
        changes = {"status": "failed", "error": "Worker process stopped unexpectedly"}
        message = "FAILED: worker process stopped unexpectedly"
    state = store.update_state(pid=None, speed_bps=0, eta_seconds=None, **changes)
    store.log(message)
    return state


def request_job_action(store: JobStore, action: str) -> dict[str, Any]:
    """Request pause/cancel and expose the transition immediately to the UI."""
    if action not in {"pause", "cancel"}:
        raise ValueError(f"Unsupported job action: {action}")
    state = store.read_state()
    if not state:
        raise FileNotFoundError(f"Unknown job: {store.job_id}")

    target = "paused" if action == "pause" else "cancelled"
    transition = "pausing" if action == "pause" else "cancelling"
    status = str(state.get("status", ""))
    if status == target:
        return state
    if action == "pause" and status not in ACTIVE_STATES:
        raise ValueError(f"Cannot pause a job whose status is {status or 'unknown'}")
    if action == "cancel" and status == "complete":
        raise ValueError("Cannot cancel a completed job")

    pid = state.get("pid")
    store.update_state(status=transition, speed_bps=0, eta_seconds=None)
    store.set_action(action)
    store.log(f"{transition.title()} requested; partial data will be preserved")
    if not process_alive(pid):
        return reconcile_job(store)
    return store.read_state()


def create_job(
    url: str,
    output: Path,
    connections: int = 4,
    stall_timeout: int = 30,
    state_root: Path = DEFAULT_STATE_ROOT,
) -> JobStore:
    output = output.expanduser().resolve()
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4().hex[:12]
    store = JobStore(job_id, state_root)
    store.directory.mkdir(parents=True, exist_ok=False)
    state = {
        "id": job_id,
        "url": normalize_dropbox_url(url),
        "output": str(output),
        "connections": max(1, min(int(connections), 32)),
        "stall_timeout": max(5, int(stall_timeout)),
        "status": "queued",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "downloaded_bytes": 0,
        "total_bytes": None,
        "speed_bps": 0,
        "eta_seconds": None,
        "retries": 0,
        "error": None,
        "pid": None,
    }
    atomic_json_write(store.state_path, state)
    store.set_action("run")
    store.log(f"Created job for {state['url']} -> {output}")
    return store


def list_jobs(state_root: Path = DEFAULT_STATE_ROOT) -> list[dict[str, Any]]:
    jobs_root = state_root / "jobs"
    if not jobs_root.exists():
        return []
    states = []
    for path in jobs_root.iterdir():
        if path.is_dir():
            state = reconcile_job(JobStore(path.name, state_root))
            if state:
                states.append(state)
    return sorted(states, key=lambda item: item.get("created_at", ""), reverse=True)


def probe(url: str, timeout: int) -> tuple[bool, int | None, str]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Range": "bytes=0-0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        status = getattr(response, "status", response.getcode())
        final_url = response.geturl()
        content_range = response.headers.get("Content-Range", "")
        if status == 206:
            match = re.match(r"bytes\s+\d+-\d+/(\d+|\*)", content_range, re.IGNORECASE)
            total = int(match.group(1)) if match and match.group(1) != "*" else None
            response.read(1)
            return True, total, final_url
        content_length = response.headers.get("Content-Length")
        total = int(content_length) if content_length and content_length.isdigit() else None
        return False, total, final_url


class DownloadWorker:
    def __init__(self, store: JobStore):
        self.store = store
        self.state = store.read_state()
        if not self.state:
            raise FileNotFoundError(f"Unknown job: {store.job_id}")
        self.url = str(self.state["url"])
        self.output = Path(self.state["output"])
        self.connections = int(self.state.get("connections", 4))
        self.stall_timeout = int(self.state.get("stall_timeout", 30))
        self.total: int | None = self.state.get("total_bytes")
        self._progress_lock = threading.RLock()
        self._stop_event = threading.Event()
        self._control_watcher_stop = threading.Event()
        self._control_watcher_thread: threading.Thread | None = None
        self._downloaded = int(self.state.get("downloaded_bytes", 0) or 0)
        self._started_monotonic = time.monotonic()
        self._started_bytes = self._downloaded
        self._last_state_write = 0.0
        self._retries = int(self.state.get("retries", 0) or 0)

    def _watch_control(self) -> None:
        """Monitor pause/cancel even while the download thread is blocked in I/O."""
        while not self._control_watcher_stop.wait(CONTROL_POLL_SECONDS):
            action = self.store.read_action()
            if action not in {"pause", "cancel"}:
                continue
            status = "paused" if action == "pause" else "cancelled"
            self.store.update_state(status=status, pid=None, speed_bps=0, eta_seconds=None, error=None)
            self.store.log(f"{status.title()}; partial data was preserved")
            # The worker is a dedicated background process. A hard self-exit is
            # intentional here: it interrupts a blocked socket read immediately,
            # while Windows closes open file handles without deleting partial data.
            os._exit(0)

    def _start_control_watcher(self) -> None:
        self._control_watcher_stop.clear()
        self._control_watcher_thread = threading.Thread(
            target=self._watch_control,
            name=f"rdm-control-{self.store.job_id}",
            daemon=True,
        )
        self._control_watcher_thread.start()

    def _stop_control_watcher(self) -> None:
        self._control_watcher_stop.set()
        if self._control_watcher_thread is not None:
            self._control_watcher_thread.join(timeout=1)

    def _check_control(self) -> None:
        action = self.store.read_action()
        if action == "pause":
            raise PauseRequested()
        if action == "cancel":
            raise CancelRequested()
        if self._stop_event.is_set():
            raise PauseRequested()

    def _sleep_interruptibly(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self._check_control()
            time.sleep(min(0.5, end - time.monotonic()))

    def _record_retry(self, error: BaseException, attempt: int) -> None:
        with self._progress_lock:
            self._retries += 1
            delay = min(60, 2 ** min(attempt, 6))
            self.store.log(f"Retry {self._retries}: {type(error).__name__}: {error}; waiting {delay}s")
            self.store.update_state(status="retrying", retries=self._retries, error=str(error))
        self._sleep_interruptibly(delay)

    def _set_downloaded(self, value: int, force: bool = False) -> None:
        with self._progress_lock:
            self._downloaded = value
            now = time.monotonic()
            if not force and now - self._last_state_write < 0.75:
                return
            elapsed = max(now - self._started_monotonic, 0.001)
            speed = max(0.0, (self._downloaded - self._started_bytes) / elapsed)
            eta = None
            if self.total is not None and speed > 0:
                eta = max(0.0, (self.total - self._downloaded) / speed)
            self.store.update_state(
                status="downloading",
                downloaded_bytes=self._downloaded,
                total_bytes=self.total,
                speed_bps=round(speed, 2),
                eta_seconds=round(eta, 1) if eta is not None else None,
                retries=self._retries,
                error=None,
            )
            self._last_state_write = now

    def _download_range(self, index: int, start: int, end: int, path: Path, base_progress: Callable[[], int]) -> None:
        expected = end - start + 1
        attempt = 0
        while True:
            self._check_control()
            existing = path.stat().st_size if path.exists() else 0
            if existing == expected:
                return
            if existing > expected:
                raise ValueError(f"Segment {index} is larger than expected")
            current = start + existing
            headers = {"User-Agent": USER_AGENT, "Range": f"bytes={current}-{end}"}
            request = urllib.request.Request(self.url, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=self.stall_timeout) as response:
                    status = getattr(response, "status", response.getcode())
                    if status != 206:
                        raise RangeRejected(f"Server returned HTTP {status} for segment {index}")
                    with path.open("ab") as handle:
                        while True:
                            self._check_control()
                            chunk = response.read(CHUNK_SIZE)
                            if not chunk:
                                break
                            handle.write(chunk)
                            self._set_downloaded(base_progress())
                if path.stat().st_size != expected:
                    raise IOError(f"Segment {index} ended early")
                return
            except (PauseRequested, CancelRequested):
                raise
            except Exception as error:
                attempt += 1
                self._record_retry(error, attempt)

    def _segmented_download(self) -> None:
        assert self.total is not None
        segment_count = min(self.connections, max(1, self.total // (8 * 1024 * 1024) + 1))
        parts_dir = self.store.directory / "parts"
        parts_dir.mkdir(parents=True, exist_ok=True)
        segment_size = math.ceil(self.total / segment_count)
        segments: list[tuple[int, int, int, Path]] = []
        for index in range(segment_count):
            start = index * segment_size
            end = min(self.total - 1, start + segment_size - 1)
            segments.append((index, start, end, parts_dir / f"segment-{index:03d}.part"))

        def current_progress() -> int:
            return sum(path.stat().st_size for _, _, _, path in segments if path.exists())

        self._downloaded = current_progress()
        self._started_bytes = self._downloaded
        self._set_downloaded(self._downloaded, force=True)
        self.store.log(f"Downloading {self.total} bytes using {segment_count} ranged connections")
        with concurrent.futures.ThreadPoolExecutor(max_workers=segment_count) as executor:
            futures = [
                executor.submit(self._download_range, index, start, end, path, current_progress)
                for index, start, end, path in segments
            ]
            try:
                for future in concurrent.futures.as_completed(futures):
                    future.result()
            except BaseException:
                self._stop_event.set()
                for future in futures:
                    future.cancel()
                raise

        self._set_downloaded(self.total, force=True)
        self.store.update_state(status="merging", speed_bps=0, eta_seconds=0)
        merge_path = self.output.with_name(self.output.name + ".rdm.merge")
        with merge_path.open("wb") as destination:
            for index, start, end, path in segments:
                expected = end - start + 1
                if path.stat().st_size != expected:
                    raise IOError(f"Segment {index} failed final size validation")
                with path.open("rb") as source:
                    shutil.copyfileobj(source, destination, CHUNK_SIZE)
            destination.flush()
            os.fsync(destination.fileno())
        if merge_path.stat().st_size != self.total:
            raise IOError("Merged file size does not match the server size")
        if self.output.exists():
            raise FileExistsError(f"Refusing to overwrite existing output: {self.output}")
        os.replace(merge_path, self.output)
        shutil.rmtree(parts_dir)

    def _single_stream_download(self, supports_ranges: bool) -> None:
        partial = self.output.with_name(self.output.name + ".rdm.part")
        attempt = 0
        while True:
            self._check_control()
            existing = partial.stat().st_size if partial.exists() else 0
            headers = {"User-Agent": USER_AGENT}
            if supports_ranges and existing:
                headers["Range"] = f"bytes={existing}-"
            request = urllib.request.Request(self.url, headers=headers)
            mode = "ab" if supports_ranges and existing else "wb"
            try:
                with urllib.request.urlopen(request, timeout=self.stall_timeout) as response:
                    status = getattr(response, "status", response.getcode())
                    if supports_ranges and existing and status != 206:
                        raise RangeRejected(f"Server returned HTTP {status} instead of resuming")
                    content_length = response.headers.get("Content-Length")
                    if self.total is None and content_length and content_length.isdigit():
                        self.total = int(content_length) + (existing if status == 206 else 0)
                    self._downloaded = existing if mode == "ab" else 0
                    self._started_bytes = self._downloaded
                    self._started_monotonic = time.monotonic()
                    self._set_downloaded(self._downloaded, force=True)
                    with partial.open(mode) as handle:
                        while True:
                            self._check_control()
                            chunk = response.read(CHUNK_SIZE)
                            if not chunk:
                                break
                            handle.write(chunk)
                            self._downloaded += len(chunk)
                            self._set_downloaded(self._downloaded)
                        handle.flush()
                        os.fsync(handle.fileno())
                actual = partial.stat().st_size
                if self.total is not None and actual != self.total:
                    raise IOError(f"Transfer ended at {actual} of {self.total} bytes")
                if self.output.exists():
                    raise FileExistsError(f"Refusing to overwrite existing output: {self.output}")
                os.replace(partial, self.output)
                self._set_downloaded(actual, force=True)
                return
            except (PauseRequested, CancelRequested):
                raise
            except RangeRejected:
                supports_ranges = False
                attempt += 1
                self.store.log("Server stopped honoring ranges; restarting with automatic full-stream retries")
                self._record_retry(RangeRejected("Range resume rejected"), attempt)
            except Exception as error:
                attempt += 1
                self._record_retry(error, attempt)

    def run(self) -> None:
        self.store.update_state(status="probing", pid=os.getpid(), error=None)
        self.store.log(f"Worker {os.getpid()} started")
        self._start_control_watcher()
        try:
            self._check_control()
            supports_ranges, total, final_url = probe(self.url, self.stall_timeout)
            self.total = total
            self.store.update_state(
                status="downloading",
                pid=os.getpid(),
                supports_ranges=supports_ranges,
                total_bytes=total,
                final_url=final_url,
            )
            if self.output.exists():
                if total is not None and self.output.stat().st_size == total:
                    self.store.update_state(status="complete", downloaded_bytes=total, speed_bps=0, eta_seconds=0)
                    return
                raise FileExistsError(f"Output appeared after the job was created: {self.output}")
            if supports_ranges and total is not None and self.connections > 1:
                self._segmented_download()
            else:
                self._single_stream_download(supports_ranges)
            final_size = self.output.stat().st_size
            self.store.update_state(
                status="complete",
                downloaded_bytes=final_size,
                total_bytes=self.total or final_size,
                speed_bps=0,
                eta_seconds=0,
                completed_at=now_iso(),
                pid=None,
                error=None,
            )
            self.store.log(f"Completed and verified {final_size} bytes: {self.output}")
        except PauseRequested:
            self.store.update_state(status="paused", pid=None, speed_bps=0, eta_seconds=None)
            self.store.log("Paused; partial data was preserved")
        except CancelRequested:
            self.store.update_state(status="cancelled", pid=None, speed_bps=0, eta_seconds=None)
            self.store.log("Cancelled; partial data was preserved")
        except BaseException as error:
            self.store.update_state(status="failed", pid=None, speed_bps=0, eta_seconds=None, error=str(error))
            self.store.log(f"FAILED: {type(error).__name__}: {error}")
            raise
        finally:
            self._stop_control_watcher()


def launch_worker(store: JobStore) -> int:
    state = store.read_state()
    old_pid = state.get("pid")
    if state.get("status") in ACTIVE_STATES and process_alive(old_pid):
        return int(old_pid)
    store.set_action("run")
    command = [sys.executable, str(Path(__file__).resolve()), "_worker", store.job_id, "--state-root", str(store.root)]
    creation_flags = 0
    if os.name == "nt":
        creation_flags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        )
    log_handle = store.log_path.open("a", encoding="utf-8")
    try:
        process = subprocess.Popen(
            command,
            cwd=str(Path(__file__).resolve().parent),
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            creationflags=creation_flags,
            close_fds=True,
        )
    finally:
        log_handle.close()
    store.update_state(status="queued", pid=process.pid, error=None)
    store.log(f"Launched background worker {process.pid}")
    return process.pid


def format_state(state: dict[str, Any]) -> str:
    downloaded = int(state.get("downloaded_bytes") or 0)
    total = state.get("total_bytes")
    percent = "?"
    if total:
        percent = f"{downloaded / int(total) * 100:.2f}%"
    return (
        f"{state.get('id', '?')}  {state.get('status', '?'):11}  {percent:>7}  "
        f"{human_bytes(downloaded):>10} / {human_bytes(total):<10}  "
        f"{human_bytes(state.get('speed_bps'))}/s  ETA {human_duration(state.get('eta_seconds'))}  "
        f"{state.get('output', '')}"
    )


def command_add(args: argparse.Namespace) -> int:
    output = Path(args.output) if args.output else Path.home() / "Downloads" / safe_default_filename(args.url)
    store = create_job(args.url, output, args.connections, args.stall_timeout, Path(args.state_root))
    if args.foreground:
        DownloadWorker(store).run()
    else:
        pid = launch_worker(store)
        print(f"Started {store.job_id} as process {pid}")
    print(format_state(store.read_state()))
    return 0


def command_list(args: argparse.Namespace) -> int:
    states = list_jobs(Path(args.state_root))
    if not states:
        print("No download jobs.")
        return 0
    for state in states:
        print(format_state(state))
    return 0


def command_status(args: argparse.Namespace) -> int:
    store = JobStore(args.job_id, Path(args.state_root))
    state = store.read_state()
    if not state:
        raise SystemExit(f"Unknown job: {args.job_id}")
    print(json.dumps(state, indent=2))
    print(format_state(state))
    return 0


def command_action(args: argparse.Namespace) -> int:
    store = JobStore(args.job_id, Path(args.state_root))
    state = store.read_state()
    if not state:
        raise SystemExit(f"Unknown job: {args.job_id}")
    if args.command == "resume":
        store.set_action("run")
        pid = launch_worker(store)
        print(f"Resumed {args.job_id} as process {pid}")
    else:
        state = request_job_action(store, args.command)
        print(f"{state['status'].title()} {args.job_id}; partial data will be preserved.")
    return 0


def command_log(args: argparse.Namespace) -> int:
    store = JobStore(args.job_id, Path(args.state_root))
    if not store.log_path.exists():
        raise SystemExit(f"No log for job: {args.job_id}")
    lines = store.log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    print("\n".join(lines[-args.lines :]))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rdm", description=APP_NAME)
    parser.add_argument("--state-root", default=str(DEFAULT_STATE_ROOT), help=argparse.SUPPRESS)
    subparsers = parser.add_subparsers(dest="command", required=True)

    add = subparsers.add_parser("add", help="Create and start a persistent download job")
    add.add_argument("url")
    add.add_argument("-o", "--output")
    add.add_argument("-c", "--connections", type=int, default=4)
    add.add_argument("--stall-timeout", type=int, default=30)
    add.add_argument("--foreground", action="store_true")
    add.set_defaults(handler=command_add)

    listing = subparsers.add_parser("list", help="List all jobs")
    listing.set_defaults(handler=command_list)

    status = subparsers.add_parser("status", help="Show detailed job status")
    status.add_argument("job_id")
    status.set_defaults(handler=command_status)

    for action in ("pause", "resume", "cancel"):
        action_parser = subparsers.add_parser(action, help=f"{action.title()} a job")
        action_parser.add_argument("job_id")
        action_parser.set_defaults(handler=command_action)

    logs = subparsers.add_parser("log", help="Show recent worker log lines")
    logs.add_argument("job_id")
    logs.add_argument("-n", "--lines", type=int, default=30)
    logs.set_defaults(handler=command_log)

    worker = subparsers.add_parser("_worker", help=argparse.SUPPRESS)
    worker.add_argument("job_id")
    worker.set_defaults(handler=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "_worker":
        store = JobStore(args.job_id, Path(args.state_root))
        DownloadWorker(store).run()
        return 0
    return int(args.handler(args))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)

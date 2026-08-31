#!/usr/bin/env python3
"""Primary entry point for Resilient Download Manager."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import rdm


class ResilientWorker(rdm.DownloadWorker):
    """Worker variant that retries initial server probes indefinitely."""

    def run(self) -> None:
        self.store.update_state(status="probing", pid=os.getpid(), error=None)
        self.store.log(f"Worker {os.getpid()} started")
        self._start_control_watcher()
        try:
            self._check_control()
            probe_attempt = 0
            while True:
                try:
                    supports_ranges, total, final_url = rdm.probe(self.url, self.stall_timeout)
                    break
                except (rdm.PauseRequested, rdm.CancelRequested):
                    raise
                except Exception as error:
                    probe_attempt += 1
                    self._record_retry(error, probe_attempt)
                    self.store.update_state(status="probing")

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
                completed_at=rdm.now_iso(),
                pid=None,
                error=None,
            )
            self.store.log(f"Completed and verified {final_size} bytes: {self.output}")
        except rdm.PauseRequested:
            self.store.update_state(status="paused", pid=None, speed_bps=0, eta_seconds=None)
            self.store.log("Paused; partial data was preserved")
        except rdm.CancelRequested:
            self.store.update_state(status="cancelled", pid=None, speed_bps=0, eta_seconds=None)
            self.store.log("Cancelled; partial data was preserved")
        except BaseException as error:
            self.store.update_state(status="failed", pid=None, speed_bps=0, eta_seconds=None, error=str(error))
            self.store.log(f"FAILED: {type(error).__name__}: {error}")
            raise
        finally:
            self._stop_control_watcher()


def launch_worker(store: rdm.JobStore) -> int:
    state = store.read_state()
    old_pid = state.get("pid")
    if state.get("status") in rdm.ACTIVE_STATES and rdm.process_alive(old_pid):
        return int(old_pid)
    store.set_action("run")
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--state-root",
        str(store.root),
        "_worker",
        store.job_id,
    ]
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


rdm.DownloadWorker = ResilientWorker
rdm.launch_worker = launch_worker


if __name__ == "__main__":
    try:
        raise SystemExit(rdm.main())
    except KeyboardInterrupt:
        raise SystemExit(130)

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import manager
import rdm


RANGE_DATA = bytes(range(256)) * (18 * 1024 * 1024 // 256)
STREAM_DATA = bytes(reversed(range(256))) * (2 * 1024 * 1024 // 256)


class QuietHandler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return

    def disconnect(self) -> None:
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.connection.close()


class FlakyRangeHandler(QuietHandler):
    failures_left = 4
    lock = threading.Lock()

    def do_GET(self) -> None:
        range_header = self.headers.get("Range")
        if range_header:
            value = range_header.removeprefix("bytes=")
            start_text, end_text = value.split("-", 1)
            start = int(start_text)
            end = int(end_text) if end_text else len(RANGE_DATA) - 1
            payload = RANGE_DATA[start : end + 1]
            self.send_response(206)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(RANGE_DATA)}")
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            if start == 0 and end == 0:
                self.wfile.write(payload)
                return
            should_fail = False
            with self.lock:
                if self.failures_left > 0:
                    type(self).failures_left -= 1
                    should_fail = True
            if should_fail:
                self.wfile.write(payload[: min(65536, len(payload))])
                self.wfile.flush()
                self.disconnect()
                return
            self.wfile.write(payload)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(RANGE_DATA)))
        self.end_headers()
        self.wfile.write(RANGE_DATA)


class FlakyStreamHandler(QuietHandler):
    failures_left = 1
    lock = threading.Lock()

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Length", str(len(STREAM_DATA)))
        self.end_headers()
        if self.headers.get("Range"):
            return
        should_fail = False
        with self.lock:
            if self.failures_left > 0:
                type(self).failures_left -= 1
                should_fail = True
        if should_fail:
            self.wfile.write(STREAM_DATA[:65536])
            self.wfile.flush()
            self.disconnect()
            return
        self.wfile.write(STREAM_DATA)


class BlockingStreamHandler(QuietHandler):
    download_started = threading.Event()
    release = threading.Event()

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Length", str(len(STREAM_DATA)))
        self.end_headers()
        if self.headers.get("Range"):
            return
        type(self).download_started.set()
        type(self).release.wait(timeout=10)
        try:
            self.wfile.write(STREAM_DATA)
        except OSError:
            pass


class ServerContext:
    def __init__(self, handler: type[BaseHTTPRequestHandler]):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        host, port = self.server.server_address
        return f"http://{host}:{port}/payload.bin"

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class DownloadManagerTests(unittest.TestCase):
    def test_segmented_download_recovers_from_dropped_connections(self) -> None:
        FlakyRangeHandler.failures_left = 4
        with tempfile.TemporaryDirectory() as temporary, ServerContext(FlakyRangeHandler) as url:
            root = Path(temporary)
            output = root / "range.bin"
            store = rdm.create_job(url, output, connections=4, stall_timeout=5, state_root=root / "state")
            manager.ResilientWorker(store).run()
            self.assertEqual(output.read_bytes(), RANGE_DATA)
            state = store.read_state()
            self.assertEqual(state["status"], "complete")
            self.assertGreaterEqual(state["retries"], 1)

    def test_single_stream_restarts_after_dropped_connection(self) -> None:
        FlakyStreamHandler.failures_left = 1
        with tempfile.TemporaryDirectory() as temporary, ServerContext(FlakyStreamHandler) as url:
            root = Path(temporary)
            output = root / "stream.bin"
            store = rdm.create_job(url, output, connections=4, stall_timeout=5, state_root=root / "state")
            manager.ResilientWorker(store).run()
            self.assertEqual(output.read_bytes(), STREAM_DATA)
            state = store.read_state()
            self.assertEqual(state["status"], "complete")
            self.assertGreaterEqual(state["retries"], 1)

    def test_pause_exposes_transition_immediately_for_live_worker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = rdm.create_job("https://example.invalid/file", root / "file.bin", state_root=root / "state")
            store.update_state(status="downloading", pid=os.getpid(), speed_bps=1234, eta_seconds=20)

            state = rdm.request_job_action(store, "pause")

            self.assertEqual(state["status"], "pausing")
            self.assertEqual(state["speed_bps"], 0)
            self.assertEqual(store.read_action(), "pause")

    def test_pause_reconciles_worker_that_already_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = rdm.create_job("https://example.invalid/file", root / "file.bin", state_root=root / "state")
            store.update_state(status="downloading", pid=999_999_999)

            state = rdm.request_job_action(store, "pause")

            self.assertEqual(state["status"], "paused")
            self.assertIsNone(state["pid"])
            self.assertEqual(state["speed_bps"], 0)

    def test_pause_interrupts_a_worker_blocked_in_network_read(self) -> None:
        BlockingStreamHandler.download_started = threading.Event()
        BlockingStreamHandler.release = threading.Event()
        with tempfile.TemporaryDirectory() as temporary, ServerContext(BlockingStreamHandler) as url:
            root = Path(temporary)
            state_root = root / "state"
            store = rdm.create_job(url, root / "blocked.bin", stall_timeout=30, state_root=state_root)
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(Path(manager.__file__).resolve()),
                    "--state-root",
                    str(state_root),
                    "_worker",
                    store.job_id,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                self.assertTrue(BlockingStreamHandler.download_started.wait(timeout=5))
                started = time.monotonic()
                rdm.request_job_action(store, "pause")
                process.wait(timeout=3)
                elapsed = time.monotonic() - started

                state = store.read_state()
                self.assertEqual(state["status"], "paused")
                self.assertIsNone(state["pid"])
                self.assertLess(elapsed, 2)
            finally:
                BlockingStreamHandler.release.set()
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)


if __name__ == "__main__":
    unittest.main(verbosity=2)

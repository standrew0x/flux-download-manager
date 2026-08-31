#!/usr/bin/env python3
"""Tkinter interface for Resilient Download Manager."""

from __future__ import annotations

import os
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import manager  # Applies reliability patches to the core module.
import rdm


class DownloadManagerApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Resilient Download Manager")
        self.geometry("1080x610")
        self.minsize(820, 480)
        self.url_var = tk.StringVar()
        self.output_var = tk.StringVar()
        self.connections_var = tk.IntVar(value=4)
        self.status_var = tk.StringVar(value="Ready")
        self._build()
        self.refresh_jobs()

    def _build(self) -> None:
        style = ttk.Style(self)
        if "vista" in style.theme_names():
            style.theme_use("vista")

        entry_frame = ttk.LabelFrame(self, text="New download", padding=12)
        entry_frame.pack(fill="x", padx=12, pady=(12, 8))
        entry_frame.columnconfigure(1, weight=1)

        ttk.Label(entry_frame, text="URL").grid(row=0, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(entry_frame, textvariable=self.url_var).grid(row=0, column=1, columnspan=3, sticky="ew", pady=4)

        ttk.Label(entry_frame, text="Save as").grid(row=1, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(entry_frame, textvariable=self.output_var).grid(row=1, column=1, sticky="ew", pady=4)
        ttk.Button(entry_frame, text="Browse…", command=self.choose_output).grid(row=1, column=2, padx=8, pady=4)
        ttk.Label(entry_frame, text="Connections").grid(row=1, column=3, padx=(12, 4), pady=4)
        ttk.Spinbox(entry_frame, from_=1, to=16, width=5, textvariable=self.connections_var).grid(row=1, column=4, pady=4)
        ttk.Button(entry_frame, text="Start download", command=self.start_download).grid(row=0, column=4, padx=(12, 0), pady=4)

        jobs_frame = ttk.LabelFrame(self, text="Downloads", padding=8)
        jobs_frame.pack(fill="both", expand=True, padx=12, pady=8)
        jobs_frame.rowconfigure(0, weight=1)
        jobs_frame.columnconfigure(0, weight=1)

        columns = ("status", "progress", "downloaded", "speed", "eta", "output")
        self.tree = ttk.Treeview(jobs_frame, columns=columns, show="headings", selectmode="browse")
        headings = {
            "status": "Status",
            "progress": "Progress",
            "downloaded": "Downloaded",
            "speed": "Speed",
            "eta": "ETA",
            "output": "Output",
        }
        widths = {"status": 95, "progress": 80, "downloaded": 145, "speed": 100, "eta": 90, "output": 430}
        for column in columns:
            self.tree.heading(column, text=headings[column])
            self.tree.column(column, width=widths[column], anchor="w")
        scrollbar = ttk.Scrollbar(jobs_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scrollbar.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.tree.bind("<Double-1>", lambda _event: self.open_folder())

        controls = ttk.Frame(self, padding=(12, 4, 12, 8))
        controls.pack(fill="x")
        ttk.Button(controls, text="Pause", command=lambda: self.job_action("pause")).pack(side="left", padx=(0, 6))
        ttk.Button(controls, text="Resume", command=lambda: self.job_action("resume")).pack(side="left", padx=6)
        ttk.Button(controls, text="Cancel", command=lambda: self.job_action("cancel")).pack(side="left", padx=6)
        ttk.Button(controls, text="Open folder", command=self.open_folder).pack(side="left", padx=6)
        ttk.Button(controls, text="View log", command=self.view_log).pack(side="left", padx=6)
        ttk.Button(controls, text="Refresh", command=self.refresh_jobs).pack(side="right")
        ttk.Label(self, textvariable=self.status_var, relief="sunken", anchor="w", padding=5).pack(fill="x", side="bottom")

    def choose_output(self) -> None:
        url = self.url_var.get().strip()
        initial = rdm.safe_default_filename(url) if url else "download.bin"
        chosen = filedialog.asksaveasfilename(initialdir=str(Path.home() / "Downloads"), initialfile=initial)
        if chosen:
            self.output_var.set(chosen)

    def start_download(self) -> None:
        url = self.url_var.get().strip()
        if not url:
            messagebox.showerror("Missing URL", "Paste a download URL first.")
            return
        output_text = self.output_var.get().strip()
        output = Path(output_text) if output_text else Path.home() / "Downloads" / rdm.safe_default_filename(url)
        try:
            store = rdm.create_job(url, output, self.connections_var.get(), 30)
            pid = manager.launch_worker(store)
        except Exception as error:
            messagebox.showerror("Could not start download", str(error))
            return
        self.url_var.set("")
        self.output_var.set("")
        self.status_var.set(f"Started {store.job_id} in background process {pid}")
        self.refresh_jobs()

    def selected_job_id(self) -> str | None:
        selection = self.tree.selection()
        if not selection:
            messagebox.showinfo("Select a download", "Select a download job first.")
            return None
        return selection[0]

    def job_action(self, action: str) -> None:
        job_id = self.selected_job_id()
        if not job_id:
            return
        store = rdm.JobStore(job_id)
        try:
            if action == "resume":
                store.set_action("run")
                pid = manager.launch_worker(store)
                self.status_var.set(f"Resumed {job_id} in process {pid}")
            else:
                state = rdm.request_job_action(store, action)
                self.status_var.set(f"{state['status'].title()} {job_id}; partial data is preserved")
        except Exception as error:
            messagebox.showerror("Action failed", str(error))
        self.after(500, self.refresh_jobs)

    def open_folder(self) -> None:
        job_id = self.selected_job_id()
        if not job_id:
            return
        state = rdm.JobStore(job_id).read_state()
        folder = str(Path(state["output"]).parent)
        try:
            os.startfile(folder)
        except Exception as error:
            messagebox.showerror("Could not open folder", str(error))

    def view_log(self) -> None:
        job_id = self.selected_job_id()
        if not job_id:
            return
        store = rdm.JobStore(job_id)
        if not store.log_path.exists():
            messagebox.showinfo("Log", "No log has been written yet.")
            return
        window = tk.Toplevel(self)
        window.title(f"Download log — {job_id}")
        window.geometry("820x420")
        text = tk.Text(window, wrap="word")
        text.pack(fill="both", expand=True)
        text.insert("1.0", store.log_path.read_text(encoding="utf-8", errors="replace"))
        text.configure(state="disabled")

    def refresh_jobs(self) -> None:
        selected = self.tree.selection()
        states = rdm.list_jobs()
        known = set()
        for state in states:
            job_id = state["id"]
            known.add(job_id)
            downloaded = int(state.get("downloaded_bytes") or 0)
            total = state.get("total_bytes")
            progress = f"{downloaded / int(total) * 100:.2f}%" if total else "?"
            values = (
                state.get("status", "?"),
                progress,
                f"{rdm.human_bytes(downloaded)} / {rdm.human_bytes(total)}",
                f"{rdm.human_bytes(state.get('speed_bps'))}/s",
                rdm.human_duration(state.get("eta_seconds")),
                state.get("output", ""),
            )
            if self.tree.exists(job_id):
                self.tree.item(job_id, values=values)
            else:
                self.tree.insert("", "end", iid=job_id, values=values)
        for item in self.tree.get_children():
            if item not in known:
                self.tree.delete(item)
        if selected and self.tree.exists(selected[0]):
            self.tree.selection_set(selected[0])
        active = sum(1 for state in states if state.get("status") in rdm.ACTIVE_STATES)
        self.status_var.set(f"{len(states)} job(s), {active} active — jobs continue when this window is closed")
        self.after(2000, self.refresh_jobs)


if __name__ == "__main__":
    DownloadManagerApp().mainloop()

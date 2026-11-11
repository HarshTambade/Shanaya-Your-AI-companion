#!/usr/bin/env python3
"""Load the openat tracepoint monitor and forward events to the local API."""

from __future__ import annotations

import json
import os
import signal
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROGRAM = Path(__file__).with_name("main.bpf.c")
SENSES_URL = os.getenv("SHANAYA_SENSES_URL", "http://127.0.0.1:8000/api/senses/events")
running = True


def stop(_signum: int, _frame: object) -> None:
    global running
    running = False


def post_event(event: dict[str, object]) -> None:
    body = json.dumps(event).encode("utf-8")
    request = urllib.request.Request(
        SENSES_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=1.5) as response:
            response.read(256)
    except (urllib.error.URLError, TimeoutError):
        # Keep monitoring if the API is temporarily offline; the event is also printed.
        pass


def main() -> int:
    if not sys.platform.startswith("linux"):
        print("The BCC openat monitor requires Linux.", file=sys.stderr)
        return 2
    try:
        from bcc import BPF
    except ImportError:
        print("Install the OS BCC Python bindings and kernel headers before starting the eBPF monitor.", file=sys.stderr)
        return 2
    if not Path("/proc/self/status").exists() or os.geteuid() != 0:
        print("Run this loader with root privileges so BCC can attach the syscall tracepoint.", file=sys.stderr)
        return 2

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    program = PROGRAM.read_text(encoding="utf-8")
    bpf = BPF(text=program)

    def handle_event(_cpu: int, data: object, _size: int) -> None:
        item = bpf["events"].event(data)
        event = {
            "type": "openat",
            "pid": int(item.pid),
            "uid": int(item.uid),
            "flags": int(item.flags),
            "process": bytes(item.comm).split(b"\0", 1)[0].decode("utf-8", errors="replace"),
            "path": bytes(item.filename).split(b"\0", 1)[0].decode("utf-8", errors="replace"),
        }
        print(json.dumps(event, ensure_ascii=False), flush=True)
        post_event(event)

    bpf["events"].open_perf_buffer(handle_event, page_cnt=32)
    print(f"Watching syscalls:sys_enter_openat; forwarding events to {SENSES_URL}", flush=True)
    try:
        while running:
            bpf.perf_buffer_poll(timeout=250)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

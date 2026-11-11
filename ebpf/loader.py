#!/usr/bin/env python3
"""Load the openat tracepoint monitor and forward events to the local API."""

from __future__ import annotations

import json
import argparse
import ipaddress
import os
import queue
import signal
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

PROGRAM = Path(__file__).with_name("main.bpf.c")
SENSES_URL = os.getenv("SHANAYA_SENSES_URL", "http://127.0.0.1:8000/api/senses/events")
EVENT_QUEUE: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1024)
running = True
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def validate_senses_url(url: str) -> bool:
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "http" or parsed.hostname not in LOCAL_HOSTS or parsed.username or parsed.password:
            return False
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            return False
        if parsed.hostname != "localhost" and not ipaddress.ip_address(parsed.hostname).is_loopback:
            return False
        return True
    except (ValueError, TypeError):
        return False


def stop(_signum: int, _frame: object) -> None:
    global running
    running = False


def post_event(event: dict[str, Any]) -> None:
    body = json.dumps(event, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        SENSES_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with LOCAL_OPENER.open(request, timeout=1.5) as response:
            response.read(256)
    except (urllib.error.URLError, TimeoutError, OSError):
        # Event forwarding is best-effort: monitoring must survive an offline API.
        pass


def forward_events() -> None:
    while running or not EVENT_QUEUE.empty():
        try:
            event = EVENT_QUEUE.get(timeout=0.2)
        except queue.Empty:
            continue
        try:
            post_event(event)
        finally:
            EVENT_QUEUE.task_done()


def main() -> int:
    global running
    parser = argparse.ArgumentParser(description="Optional, metadata-only eBPF syscall monitor.")
    parser.add_argument(
        "--enable-kernel-senses",
        action="store_true",
        help="explicitly enable privileged eBPF monitoring for this run",
    )
    parser.add_argument(
        "--log-events",
        action="store_true",
        help="print process and syscall metadata locally (never file paths)",
    )
    options = parser.parse_args()
    if not options.enable_kernel_senses:
        print("Kernel sensing is disabled. Pass --enable-kernel-senses to opt in.")
        return 0
    if not sys.platform.startswith("linux"):
        print("The BCC openat monitor requires Linux.", file=sys.stderr)
        return 2
    if not validate_senses_url(SENSES_URL):
        print("SHANAYA_SENSES_URL must be an HTTP loopback address; event forwarding was stopped.", file=sys.stderr)
        return 2
    try:
        from bcc import BPF
    except (ImportError, OSError) as exc:
        print(f"BCC is unavailable ({type(exc).__name__}); install the OS BCC bindings and kernel headers.", file=sys.stderr)
        return 2
    if not Path("/proc/self/status").exists() or os.geteuid() != 0:
        print("The eBPF monitor needs root privileges; the rest of Shanaya can run without it.", file=sys.stderr)
        return 2

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        program = PROGRAM.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"Could not read the eBPF program ({type(exc).__name__}).", file=sys.stderr)
        return 2

    try:
        bpf = BPF(text=program)
    except Exception as exc:
        # Compilation, permissions, kernel configuration, and attach errors are
        # reported as a short diagnostic. Never dump the C source or env here.
        print(f"BCC could not load the monitor ({type(exc).__name__}).", file=sys.stderr)
        return 2

    drop_counter = [0]

    def handle_event(_cpu: int, data: object, _size: int) -> None:
        item = bpf["events"].event(data)
        event = {
            "type": "openat",
            "pid": int(item.pid),
            "uid": int(item.uid),
            "flags": int(item.flags),
            "process": bytes(item.comm).split(b"\0", 1)[0].decode("utf-8", errors="replace"),
        }
        if options.log_events:
            # Only syscall/process metadata is collected; open file paths never leave the kernel.
            print(json.dumps(event, ensure_ascii=False), flush=True)
        try:
            EVENT_QUEUE.put_nowait(event)
        except queue.Full:
            drop_counter[0] += 1

    try:
        try:
            bpf["events"].open_perf_buffer(handle_event, page_cnt=32)
        except Exception as exc:
            print(f"Could not attach the openat event buffer ({type(exc).__name__}).", file=sys.stderr)
            return 2

        worker = threading.Thread(target=forward_events, name="shanaya-event-forwarder", daemon=True)
        worker.start()
        print("Watching syscalls:sys_enter_openat; forwarding event summaries to the local API.", flush=True)
        try:
            while running:
                bpf.perf_buffer_poll(timeout=250)
        except KeyboardInterrupt:
            running = False
        except Exception as exc:
            print(f"The eBPF event stream stopped ({type(exc).__name__}).", file=sys.stderr)
            return 2
        finally:
            running = False
            worker.join(timeout=2.0)
            if drop_counter[0]:
                print(f"Dropped {drop_counter[0]} eBPF events because the forwarding queue was full.", file=sys.stderr)
        return 0
    finally:
        cleanup = getattr(bpf, "cleanup", None)
        if callable(cleanup):
            try:
                cleanup()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())

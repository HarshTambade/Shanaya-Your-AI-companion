"""Execute short programs in disposable, network-isolated Docker containers."""

from __future__ import annotations

import asyncio
import io
import os
import tarfile
import threading
import time
from typing import Any

from backend.tools.security import require_tool_authority

_RUNTIMES = {
    "python": ("python:3.11-slim", "/tmp/shanaya_task.py", ["python", "/tmp/shanaya_task.py"]),
    "node": ("node:22-bookworm-slim", "/tmp/shanaya_task.js", ["node", "/tmp/shanaya_task.js"]),
    "shell": ("alpine:3.21", "/tmp/shanaya_task.sh", ["/bin/sh", "/tmp/shanaya_task.sh"]),
}
MAX_CODE_BYTES = 64_000
MAX_OUTPUT_BYTES = 24_000


def _code_archive(filename: str, code: str) -> bytes:
    data = code.encode("utf-8")
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as tar:
        entry = tarfile.TarInfo(filename.removeprefix("/tmp/"))
        entry.size = len(data)
        entry.mode = 0o444
        entry.uid = 65534
        entry.gid = 65534
        tar.addfile(entry, io.BytesIO(data))
    return archive.getvalue()


def _run_in_docker(language: str, image: str, filename: str, argv: list[str], code: str, timeout_seconds: int) -> dict[str, Any]:
    import docker

    client = docker.from_env(timeout=20)
    container = None
    try:
        try:
            client.images.get(image)
        except docker.errors.ImageNotFound:
            client.images.pull(image)
        container = client.containers.create(
            image=image,
            command=["tail", "-f", "/dev/null"],
            detach=True,
            network_mode="none",
            read_only=True,
            user="65534:65534",
            working_dir="/tmp",
            tmpfs={"/tmp": "rw,nosuid,nodev,noexec,size=16m,mode=1777"},
            mem_limit="256m",
            nano_cpus=1_000_000_000,
            pids_limit=64,
            cap_drop=["ALL"],
            security_opt=["no-new-privileges:true"],
            labels={"app": "project-shanaya", "purpose": "approved-code-execution"},
            environment={"HOME": "/tmp", "PYTHONDONTWRITEBYTECODE": "1"},
        )
        container.start()
        if not container.put_archive("/tmp", _code_archive(filename, code)):
            raise RuntimeError("Docker could not place the approved program in the sandbox.")
        exec_id = client.api.exec_create(container.id, argv, stdout=True, stderr=True, tty=False, user="65534:65534")
        stdout_buffer = bytearray()
        stderr_buffer = bytearray()
        output_truncated = [False]
        stream_error: list[Exception] = []

        def keep_tail(buffer: bytearray, chunk: bytes) -> None:
            if not chunk:
                return
            buffer.extend(chunk)
            if len(buffer) > MAX_OUTPUT_BYTES:
                del buffer[:-MAX_OUTPUT_BYTES]
                output_truncated[0] = True

        def consume_stream() -> None:
            try:
                for stdout_chunk, stderr_chunk in client.api.exec_start(exec_id["Id"], detach=False, tty=False, stream=True, demux=True):
                    keep_tail(stdout_buffer, stdout_chunk or b"")
                    keep_tail(stderr_buffer, stderr_chunk or b"")
            except Exception as exc:
                stream_error.append(exc)

        stream_thread = threading.Thread(target=consume_stream, name="shanaya-docker-output", daemon=True)
        stream_thread.start()
        deadline = time.monotonic() + timeout_seconds
        inspected = client.api.exec_inspect(exec_id["Id"])
        while inspected.get("Running") and time.monotonic() < deadline:
            time.sleep(0.05)
            inspected = client.api.exec_inspect(exec_id["Id"])
        if inspected.get("Running"):
            container.kill()
            stream_thread.join(timeout=1)
            return {"exit_code": 124, "stdout": "", "stderr": "Execution exceeded the time limit."}
        stream_thread.join(timeout=2)
        if stream_error:
            raise RuntimeError("Could not capture Docker sandbox output.") from stream_error[0]
        return {
            "exit_code": inspected.get("ExitCode"),
            "stdout": stdout_buffer.decode("utf-8", errors="replace"),
            "stderr": stderr_buffer.decode("utf-8", errors="replace"),
            "output_truncated": output_truncated[0],
            "language": language,
        }
    finally:
        if container is not None:
            try:
                container.remove(force=True)
            except Exception:
                pass
        client.close()


async def execute_code(language: str, code: str, timeout_seconds: int = 10) -> dict[str, Any]:
    arguments = {"language": language, "code": code, "timeout_seconds": timeout_seconds}
    require_tool_authority("run_sandboxed_code", arguments)
    if language not in _RUNTIMES:
        raise ValueError("Language must be python, node, or shell.")
    if not isinstance(code, str) or not code.strip() or len(code.encode("utf-8")) > MAX_CODE_BYTES:
        raise ValueError("Program must contain 1 to 64,000 UTF-8 bytes.")
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int) or not 1 <= timeout_seconds <= 30:
        raise ValueError("Sandbox timeout must be from 1 to 30 seconds.")
    image, filename, argv = _RUNTIMES[language]
    image = os.getenv(f"SHANAYA_{language.upper()}_SANDBOX_IMAGE", image)
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_run_in_docker, language, image, filename, argv, code, timeout_seconds),
            timeout=timeout_seconds + 30,
        )
    except asyncio.TimeoutError as exc:
        raise TimeoutError("Docker sandbox startup or execution exceeded its time limit.") from exc

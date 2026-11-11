"""Workspace-scoped file and read-only system tools; no generic shell execution."""

from __future__ import annotations

import os
import platform
import re
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from backend.tools.security import require_tool_authority

MAX_FILE_BYTES = 1_000_000
MAX_COMMAND_OUTPUT = 24_000
_SERVICE_NAME = re.compile(r"^[A-Za-z0-9_.@:-]{1,128}$")
_SHELL_META = re.compile(r"[;&|<>`$\n\r]")
_SENSITIVE_NAMES = {
    ".git", ".ssh", ".aws", ".azure", ".config", ".kube", ".gnupg",
    ".npmrc", ".pypirc", ".netrc", "credentials", "secrets", "id_rsa", "id_ed25519",
}


def workspace_path(workspace: Path, raw_path: str) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip() or len(raw_path) > 2048:
        raise ValueError("Provide a non-empty relative workspace path.")
    candidate = (workspace / raw_path).resolve()
    if not candidate.is_relative_to(workspace.resolve()):
        raise ValueError("Path must stay inside the configured Shanaya workspace.")
    sensitive = False
    for part in candidate.relative_to(workspace.resolve()).parts:
        lowered = part.lower()
        if (
            lowered in _SENSITIVE_NAMES
            or (lowered.startswith(".env") and lowered != ".env.example")
            or "credential" in lowered
            or "secret" in lowered
            or lowered.endswith((".pem", ".key"))
            or lowered.startswith(("id_rsa", "id_ed25519"))
        ):
            sensitive = True
            break
    if sensitive:
        raise ValueError("Access to credential and repository metadata paths is blocked.")
    return candidate


def read_workspace_file(path: str, workspace: Path) -> dict[str, Any]:
    require_tool_authority("read_file", {"path": path})
    target = workspace_path(workspace, path)
    if not target.is_file():
        raise FileNotFoundError("The requested file does not exist in the workspace.")
    if target.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("The requested file is larger than the 1 MB read limit.")
    return {"path": str(target.relative_to(workspace.resolve())), "content": target.read_text(encoding="utf-8", errors="replace")}


def write_workspace_file(path: str, content: str, workspace: Path) -> dict[str, Any]:
    require_tool_authority("write_file", {"path": path, "content": content})
    target = workspace_path(workspace, path)
    if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_FILE_BYTES:
        raise ValueError("The write is larger than the 1 MB limit.")
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".shanaya-", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return {"path": str(target.relative_to(workspace.resolve())), "bytes_written": target.stat().st_size}


def system_status(workspace: Path) -> dict[str, Any]:
    require_tool_authority("system_status", {})
    disk = shutil.disk_usage(workspace)
    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cpu_count": os.cpu_count(),
        "workspace": str(workspace.resolve()),
        "disk_free_bytes": disk.free,
        "disk_total_bytes": disk.total,
    }


def run_allowlisted_command(command: str, workspace: Path) -> dict[str, Any]:
    """Parse a tiny read-only command language, then use argv (never a shell)."""
    require_tool_authority("execute_shell", {"command": command})
    if not isinstance(command, str) or not command.strip() or len(command) > 1000 or _SHELL_META.search(command):
        raise ValueError("Only a single, plain allow-listed command is accepted; shell operators and expansions are blocked.")
    try:
        argv = shlex.split(command, posix=True)
    except ValueError as exc:
        raise ValueError("The command could not be parsed safely.") from exc
    if not argv:
        raise ValueError("The command is empty.")

    if argv == ["pwd"]:
        output = str(workspace.resolve())
        return {"exit_code": 0, "stdout": output, "stderr": ""}

    if argv[0] == "ls":
        args = argv[1:]
        show_hidden = bool(args and args[0] == "-la")
        if show_hidden:
            args = args[1:]
        if len(args) > 1:
            raise ValueError("Allowed syntax: ls [-la] [workspace-path].")
        target = workspace_path(workspace, args[0]) if args else workspace.resolve()
        if not target.is_dir():
            raise ValueError("The ls path must be a workspace directory.")
        entries = sorted(item.name + ("/" if item.is_dir() else "") for item in target.iterdir() if show_hidden or not item.name.startswith("."))
        return {"exit_code": 0, "stdout": "\n".join(entries[:200]), "stderr": ""}

    if argv[0] == "cat":
        if len(argv) != 2:
            raise ValueError("Allowed syntax: cat workspace-file.")
        target = workspace_path(workspace, argv[1])
        if not target.is_file():
            raise FileNotFoundError("The requested file does not exist in the workspace.")
        if target.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("The requested file is larger than the 1 MB read limit.")
        content = target.read_text(encoding="utf-8", errors="replace")
        return {"exit_code": 0, "stdout": content[-MAX_COMMAND_OUTPUT:], "stderr": ""}

    if argv[:2] == ["systemctl", "status"]:
        if len(argv) != 3 or not _SERVICE_NAME.fullmatch(argv[2]):
            raise ValueError("Allowed syntax: systemctl status SERVICE_NAME.")
        if platform.system() != "Linux":
            raise ValueError("systemctl status is available only on Linux.")
        executable = shutil.which("systemctl", path="/usr/bin:/bin:/usr/sbin:/sbin")
        if not executable:
            raise ValueError("systemctl is not installed on this system.")
        try:
            completed = subprocess.run(
                [executable, "status", "--no-pager", "--full", argv[2]],
                cwd=workspace,
                env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C.UTF-8"},
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError("systemctl status exceeded its 8 second limit.") from exc
        return {"exit_code": completed.returncode, "stdout": completed.stdout[-MAX_COMMAND_OUTPUT:], "stderr": completed.stderr[-MAX_COMMAND_OUTPUT:]}

    raise ValueError("Command is not allow-listed. Allowed: pwd, ls [-la] [path], cat file, systemctl status SERVICE.")

"""Append-only, hash-chained audit records for security-sensitive actions.

The chain makes edits, truncation, and reordering detectable. The file is also
created with owner-only permissions and fsync'd after every record. A local
administrator can still alter the filesystem; export the chain to remote,
write-once storage when stronger immutability is required.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _canonical(value: dict[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _safe_value(value: Any, key: str = "", depth: int = 0) -> Any:
    """Keep credentials and user-entered payloads out of audit logs."""
    if depth > 6:
        return "<depth-limited>"
    lowered = key.lower()
    if (
        lowered.endswith("_key")
        or lowered in {"api_key", "apikey", "token", "password", "secret", "authorization", "credential", "credentials", "session_id", "cookie"}
        or any(part in lowered for part in ("_token", "_password", "_secret", "authorization", "_credential", "_cookie"))
    ):
        return "<redacted>"
    if lowered in {"content", "text", "value", "code", "fields", "form_values", "url"} or lowered.endswith("_url"):
        raw = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
        return {"redacted": True, "length": len(raw), "sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest()}
    if isinstance(value, dict):
        return {str(child_key): _safe_value(child, str(child_key), depth + 1) for child_key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe_value(child, key, depth + 1) for child in value[:100]]
    if isinstance(value, str):
        return value[:2000]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:500]


class AuditLogger:
    def __init__(self, path: str | Path | None = None) -> None:
        requested_path = Path(path or os.getenv("SHANAYA_AUDIT_LOG", "logs/shanaya_audit.jsonl")).expanduser()
        if not requested_path.is_absolute():
            requested_path = Path.cwd() / requested_path
        # Resolve the parent only. Resolving the file itself would silently
        # follow a symlink and could redirect the audit stream elsewhere.
        self.path = requested_path.parent.resolve() / requested_path.name
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.is_symlink():
            raise RuntimeError("Audit log path must not be a symbolic link.")
        try:
            self.path.parent.chmod(0o700)
        except OSError:
            pass
        self._lock = threading.RLock()
        self._sequence, self._head = self._verify_existing_chain()
        descriptor = os.open(self.path, os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(descriptor)
        try:
            self.path.chmod(0o600)
        except OSError:
            pass

    def _verify_existing_chain(self) -> tuple[int, str]:
        if not self.path.exists():
            return 0, "0" * 64
        previous = "0" * 64
        sequence = 0
        with self.path.open("rb") as stream:
            for line_number, line in enumerate(stream, 1):
                if not line.endswith(b"\n"):
                    raise RuntimeError(f"Audit log has a partial record at line {line_number}; refusing to append.")
                try:
                    record = json.loads(line)
                    claimed_hash = record.pop("hash")
                except (json.JSONDecodeError, KeyError, TypeError) as exc:
                    raise RuntimeError(f"Audit log is malformed at line {line_number}; refusing to append.") from exc
                if record.get("sequence") != sequence + 1 or record.get("previous_hash") != previous:
                    raise RuntimeError(f"Audit log chain is broken at line {line_number}; refusing to append.")
                actual_hash = hashlib.sha256(_canonical(record)).hexdigest()
                if not isinstance(claimed_hash, str) or not hmac.compare_digest(actual_hash, claimed_hash):
                    raise RuntimeError(f"Audit log integrity check failed at line {line_number}; refusing to append.")
                previous = claimed_hash
                sequence += 1
        return sequence, previous

    def log(self, action: str, *, tool: str | None = None, status: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            self._sequence += 1
            record: dict[str, Any] = {
                "sequence": self._sequence,
                "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "action": action[:80],
                "tool": tool[:80] if tool else None,
                "status": status[:80],
                "details": _safe_value(details or {}),
                "previous_hash": self._head,
            }
            record_hash = hashlib.sha256(_canonical(record)).hexdigest()
            encoded = _canonical({**record, "hash": record_hash}) + b"\n"
            descriptor = os.open(self.path, os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                view = memoryview(encoded)
                while view:
                    written = os.write(descriptor, view)
                    if written <= 0:
                        raise OSError("Audit log append made no progress.")
                    view = view[written:]
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            self._head = record_hash
            return {**record, "hash": record_hash}


audit_logger = AuditLogger()

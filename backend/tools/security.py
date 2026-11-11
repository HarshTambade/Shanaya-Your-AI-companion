"""Unforgeable-in-the-request-context capability used at each tool boundary."""

from __future__ import annotations

import contextvars
import json
from contextlib import contextmanager
from typing import Any, Iterator

_authority: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar("shanaya_tool_authority", default=None)


def canonical_arguments(arguments: dict[str, Any]) -> str:
    return json.dumps(arguments, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def require_tool_authority(name: str, arguments: dict[str, Any]) -> None:
    if _authority.get() != (name, canonical_arguments(arguments)):
        raise PermissionError(f"The {name} tool requires matching, explicit user approval.")


@contextmanager
def grant_tool_authority(name: str, arguments: dict[str, Any]) -> Iterator[None]:
    marker = _authority.set((name, canonical_arguments(arguments)))
    try:
        yield
    finally:
        _authority.reset(marker)

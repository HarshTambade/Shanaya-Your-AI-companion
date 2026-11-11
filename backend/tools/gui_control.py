"""Small PyAutoGUI surface. Every action requires a matching approval capability."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.tools.security import require_tool_authority
from backend.tools.system_control import workspace_path

_SAFE_KEYS = {"enter", "esc", "tab", "space", "backspace", "delete", "left", "right", "up", "down", "home", "end"}


def click(x: int, y: int) -> dict[str, Any]:
    require_tool_authority("gui_click", {"x": x, "y": y})
    if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, int) or not isinstance(y, int):
        raise ValueError("Mouse coordinates must be integers.")
    import pyautogui

    width, height = pyautogui.size()
    if not 0 <= x < width or not 0 <= y < height:
        raise ValueError("Mouse coordinates are outside the visible screen.")
    pyautogui.click(x=x, y=y, button="left")
    return {"clicked": True, "x": x, "y": y}


def type_text(text: str) -> dict[str, Any]:
    require_tool_authority("gui_type_text", {"text": text})
    if not isinstance(text, str) or len(text) > 500 or any(ord(char) < 32 and char not in "\n\t" for char in text):
        raise ValueError("Text must be at most 500 characters and contain no control characters.")
    import pyautogui

    pyautogui.write(text, interval=0.015)
    return {"typed_characters": len(text)}


def press_key(key: str) -> dict[str, Any]:
    require_tool_authority("gui_press_key", {"key": key})
    if not isinstance(key, str) or key.lower() not in _SAFE_KEYS:
        raise ValueError(f"Key is not allow-listed. Allowed keys: {', '.join(sorted(_SAFE_KEYS))}.")
    import pyautogui

    pyautogui.press(key.lower())
    return {"pressed": key.lower()}


def screenshot(path: str, workspace: Path) -> dict[str, Any]:
    require_tool_authority("gui_screenshot", {"path": path})
    target = workspace_path(workspace, path)
    if target.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
        raise ValueError("Screenshot path must end in .png, .jpg, or .jpeg.")
    target.parent.mkdir(parents=True, exist_ok=True)
    import pyautogui

    image = pyautogui.screenshot()
    image.save(target)
    return {"path": str(target.relative_to(workspace.resolve())), "width": image.width, "height": image.height}

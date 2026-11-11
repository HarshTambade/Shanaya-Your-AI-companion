"""Playwright navigation and form submission with SSRF guards and HITL checks."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit
from typing import Any

from backend.tools.security import require_tool_authority

MAX_PAGE_TEXT = 16_000


async def _validate_public_url(url: str) -> None:
    if not isinstance(url, str) or len(url) > 2048:
        raise ValueError("URL must be a string shorter than 2,048 characters.")
    parsed = urlsplit(url)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Only public HTTP(S) URLs without embedded credentials are allowed.")
    try:
        addresses = await asyncio.to_thread(socket.getaddrinfo, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), 0, socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError("The destination host could not be resolved.") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError("Private, local, link-local, and reserved network destinations are blocked.")


def _origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    return parsed.scheme, (parsed.hostname or "").lower(), parsed.port or (443 if parsed.scheme == "https" else 80)


async def _new_page(playwright: Any, *, submission_origin: tuple[str, str, int] | None = None) -> tuple[Any, Any, dict[str, bool]]:
    browser = await playwright.chromium.launch(headless=True)
    # Disable page scripts so merely opening a page cannot auto-submit a form,
    # invoke a scripted action, or open a socket. Native form submission remains
    # available in the separately approved submit_form tool.
    context = await browser.new_context(service_workers="block", accept_downloads=False, java_script_enabled=False)
    submission_state = {"enabled": False}

    async def guard(route: Any) -> None:
        # Text extraction and native form controls need only document requests.
        # Blocking other resource types limits tracking, downloads, active code,
        # and bandwidth consumed by an arbitrary public page.
        if route.request.resource_type != "document":
            await route.abort("blockedbyclient")
            return
        try:
            await _validate_public_url(route.request.url)
        except ValueError:
            await route.abort("blockedbyclient")
            return
        method = route.request.method.upper()
        if method not in {"GET", "HEAD"}:
            if (
                not submission_state["enabled"]
                or submission_origin is None
                or _origin(route.request.url) != submission_origin
            ):
                await route.abort("blockedbyclient")
                return
        await route.continue_()

    await context.route("**/*", guard)
    page = await context.new_page()
    page.set_default_navigation_timeout(20_000)
    page.set_default_timeout(8_000)
    return browser, page, submission_state


async def navigate_and_extract(url: str) -> dict[str, Any]:
    require_tool_authority("web_navigate", {"url": url})
    await _validate_public_url(url)
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        browser, page, _submission_state = await _new_page(playwright)
        try:
            response = await page.goto(url, wait_until="domcontentloaded")
            text = await page.locator("body").inner_text(timeout=8_000)
            return {
                "url": page.url,
                "status": response.status if response else None,
                "title": (await page.title())[:500],
                "text": text[:MAX_PAGE_TEXT],
            }
        finally:
            await browser.close()


async def submit_form(url: str, fields: dict[str, str], submit_selector: str) -> dict[str, Any]:
    arguments = {"url": url, "fields": fields, "submit_selector": submit_selector}
    require_tool_authority("web_submit_form", arguments)
    await _validate_public_url(url)
    if not isinstance(fields, dict) or not fields or len(fields) > 12:
        raise ValueError("Provide between 1 and 12 form fields.")
    if any(not isinstance(selector, str) or not selector or len(selector) > 300 or not isinstance(value, str) or len(value) > 2000 for selector, value in fields.items()):
        raise ValueError("Form selectors and values exceed their limits.")
    if not isinstance(submit_selector, str) or not submit_selector or len(submit_selector) > 300:
        raise ValueError("Provide a submit-button selector up to 300 characters.")
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        browser, page, submission_state = await _new_page(playwright, submission_origin=_origin(url))
        try:
            await page.goto(url, wait_until="domcontentloaded")
            for selector, value in fields.items():
                await page.locator(selector).fill(value)
            # This function can only be reached after the UI approved the exact URL,
            # selectors, and values shown in the proposal card.
            submission_state["enabled"] = True
            await page.locator(submit_selector).click()
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=10_000)
            except Exception:
                pass
            text = await page.locator("body").inner_text(timeout=8_000)
            return {"url": page.url, "title": (await page.title())[:500], "text": text[:MAX_PAGE_TEXT]}
        finally:
            await browser.close()

"""Test fixtures: a static server over the repo root, and Chromium emulating
the Pixel 7a (412x915 CSS px, DPR 2.625, touch)."""

import functools
import http.server
import socketserver
import threading
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

PIXEL_7A = dict(
    viewport={"width": 412, "height": 915},
    device_scale_factor=2.625,
    is_mobile=True,
    has_touch=True,
    user_agent=(
        "Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36"
    ),
)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D102
        pass

    def end_headers(self):
        # The service worker and module scripts need correct types; the stdlib
        # handler does not know .webmanifest.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        if str(path).endswith(".webmanifest"):
            return "application/manifest+json"
        if str(path).endswith(".js"):
            return "text/javascript"
        return super().guess_type(path)


@pytest.fixture(scope="session")
def server():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def page(browser, server):
    ctx = browser.new_context(**PIXEL_7A)
    pg = ctx.new_page()
    # Fail fast: a hung selector should surface as one quick failure, not stall
    # the whole suite behind Playwright's 30s default.
    pg.set_default_timeout(5000)
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))

    def on_console(m):
        # Offline and expired-token tests deliberately fail requests; the
        # browser logs those. Uncaught exceptions still come through pageerror.
        if m.type == "error" and "Failed to load resource" not in m.text:
            errors.append(m.text)

    pg.on("console", on_console)
    pg.goto(f"{server}/index.html")
    pg.wait_for_function("() => !!window.__todo")
    yield pg
    ctx.close()
    # An uncaught exception anywhere in a flow is a failure even if the
    # assertions happened to pass.
    assert not errors, f"console/page errors: {errors}"


def report(results):
    """Turn a JS results array into a readable pass/fail table + assertion."""
    lines, failed = [], []
    for r in results:
        mark = "PASS" if r["ok"] else "FAIL"
        lines.append(f"  [{mark}] {r['name']}" + ("" if r["ok"] else f"\n         {r.get('detail', '')}"))
        if not r["ok"]:
            failed.append(r["name"])
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    print("\n".join(lines))
    assert not failed, f"{len(failed)} failed: {failed}"

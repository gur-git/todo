"""One-off end-to-end check against the real repo. Not part of the suite: it
needs a live token and mutates the real list.

    py -3.13 tests/live_check.py

Proves the parts a mocked test cannot: that api.github.com really does allow a
cross-origin write from the page, that the token works from a browser, and that
a change made in the app lands in the repo.
"""

import http.server
import functools
import socketserver
import subprocess
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OWNER, REPO = "gur-git", "todo-data"
PROBE = "live end-to-end probe"


def token():
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "$s = Import-CliXml \"$env:USERPROFILE\\.claude\\todo-token.xml\";"
         "[System.Net.NetworkCredential]::new('', $s).Password"],
        capture_output=True, text=True, check=True)
    return out.stdout.strip()


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a: None
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def main():
    tok = token()
    httpd, port = serve()
    failures = []

    def check(name, cond, detail=""):
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + ("" if cond else f"\n         {detail}"))
        if not cond:
            failures.append(name)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 412, "height": 915}, device_scale_factor=2.625,
            is_mobile=True, has_touch=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(f"http://127.0.0.1:{port}/index.html")
        page.evaluate(
            """([owner, repo, tok]) => {
                localStorage.setItem('todo.owner', owner);
                localStorage.setItem('todo.repo', repo);
                localStorage.setItem('todo.path', 'tasks.json');
                localStorage.setItem('todo.token', tok);
            }""", [OWNER, REPO, tok])
        page.reload()
        page.wait_for_function("() => !!window.__todo")
        # Wait on `loaded`, not on status: status is observable but 'idle' is
        # also the pre-fetch value for a local store.
        page.wait_for_function("() => window.__todo.sync.loaded", timeout=20000)

        loaded = page.evaluate("() => window.__todo.sync.state.tasks.length")
        check("the app loads the real list over CORS", loaded > 0, f"loaded {loaded} tasks")
        check("no page errors on load", not errors, str(errors))

        topics = page.evaluate("() => window.__todo.sync.state.topics.map(t => t.id)")
        check("topics come from the repo", "relationships" in topics, str(topics))

        # Write from the app and confirm it reaches GitHub.
        page.select_option("#add-topic", "inbox")
        page.fill("#add-text", PROBE)
        page.click("#add button[type=submit]")
        page.wait_for_function("() => window.__todo.sync.pending.length === 0", timeout=25000)
        check("the app's write is accepted by GitHub",
              page.evaluate("() => window.__todo.sync.status") == "idle",
              page.evaluate("() => window.__todo.sync.status + ' ' + (window.__todo.sync.lastError||'')"))

        browser.close()

    httpd.shutdown()

    # Confirm from the other side, via the PowerShell path.
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"(& '{ROOT}\\tools\\todo.ps1' list -Topic inbox -Json).text"],
        capture_output=True, text=True)
    check("the PowerShell path sees what the app wrote", PROBE in out.stdout, out.stdout.strip() or out.stderr.strip())

    # Clean up the probe.
    ids = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"(& '{ROOT}\\tools\\todo.ps1' list -Topic inbox -Json | Where-Object {{ $_.text -eq '{PROBE}' }}).id"],
        capture_output=True, text=True).stdout.strip()
    if ids:
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"& '{ROOT}\\tools\\todo.ps1' done -Id {ids.splitlines()[0]}"],
            capture_output=True, text=True)
        print(f"  [ok]   cleaned up probe {ids.splitlines()[0]}")

    print()
    if failures:
        print(f"{len(failures)} FAILED: {failures}")
        sys.exit(1)
    print("end-to-end: all checks passed")


if __name__ == "__main__":
    main()

"""Logic and storage suites, executed inside the browser that will actually run
the app. Each JS check is reported individually."""

from pathlib import Path

from conftest import report

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _run(page, server, fn):
    page.goto(f"{server}/index.html")
    return page.evaluate(
        f"async () => {{ const m = await import('/tests/suite.js'); return await m.{fn}(); }}"
    )


def test_logic(page, server):
    report(_run(page, server, "runLogic"))


def test_store(page, server):
    report(_run(page, server, "runStore"))


def test_powershell_and_app_serialize_identically(page, server):
    """A real file written by tools/todo.ps1 must round-trip through the app
    byte for byte. If it doesn't, every alternating write rewrites the whole
    file and the git history stops being a usable record of what changed."""
    page.goto(f"{server}/index.html")
    text = (FIXTURES / "ps-written.json").read_text(encoding="utf-8")
    mismatch = page.evaluate(
        """async (text) => {
            const m = await import('/logic.js');
            const out = m.serialize(m.deserialize(text));
            if (out === text) return null;
            for (let i = 0; i < Math.max(out.length, text.length); i++) {
                if (out[i] !== text[i]) {
                    return { at: i, expected: JSON.stringify(text.slice(i, i + 40)),
                             got: JSON.stringify(out.slice(i, i + 40)) };
                }
            }
            return { at: -1, expected: text.length, got: out.length };
        }""",
        text,
    )
    assert mismatch is None, f"formats diverge: {mismatch}"

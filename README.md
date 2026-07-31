# todo

One list, split by topic. Flag what you're doing today. Nothing else.

A static PWA served from GitHub Pages, storing its data as a single JSON file in
a **separate private repo**. No server, no database, no account beyond GitHub.

**App:** https://gur-git.github.io/todo/ · **Data:** `gur-git/todo-data` → `tasks.json`

## Why two repos

The token that lets the app save lives in your phone's browser. Scoped to
`todo-data`, the worst a leak can do is scribble on your task list. If the app
and the data shared a repo, that same token could rewrite `index.html` — and the
next time you opened the app, your phone would run someone else's JavaScript with
your token already in hand. The split means **the credential can never modify the
code that holds it.**

## A task

One line of text, a topic, and exactly one state. That's the whole model.

| Field | Notes |
|---|---|
| `text` | One line. This is all you see on the list. |
| `topic` | Which section it sits under. Unknown topics fall back to Inbox rather than vanishing. |
| `state` | `flagged` · `waiting` · `normal` — mutually exclusive |
| `note` | Optional detail, hidden behind the row |
| `created` | Drives the quiet age marker after 30 days |

Order within a topic is the order in the file. No due dates, no priority levels,
no subtasks, no tags. Done means deleted — the git history is the archive.

## Using it on the phone

1. Open https://gur-git.github.io/todo/ in Chrome.
2. ⚙ → owner `gur-git`, repo `todo-data`, path `tasks.json`, paste the token.
3. Menu → **Add to Home screen**.

The token is stored only in that browser's localStorage. It is sent to
`api.github.com` and nowhere else.

- **Filter chips** toggle which states are visible, independently — untick Normal
  and Waiting for a flagged-only morning view. The choice sticks.
- **Long-press a row** to arm reorder mode; drag freely; **Done** disarms it, so
  the order can't shift under an accidental swipe.
- **Offline** edits queue in localStorage and flush when you're back.

## Using it from the PC

```powershell
.\tools\todo.ps1 list
.\tools\todo.ps1 list -Topic lab -State flagged
.\tools\todo.ps1 add -Text "review the Session 8 lab prep" -Topic degree -Flag
.\tools\todo.ps1 flag   -Id t_ab12cd34ef
.\tools\todo.ps1 wait   -Id t_ab12cd34ef
.\tools\todo.ps1 done   -Id t_ab12cd34ef
.\tools\todo.ps1 topics
```

The token is read from `~/.claude/todo-token.xml`, DPAPI-encrypted so only your
Windows account on that machine can decrypt it. To (re)store one:

```powershell
ConvertTo-SecureString '<pat>' -AsPlainText -Force |
  Export-CliXml "$env:USERPROFILE\.claude\todo-token.xml"
```

## Concurrency

Both writers use the GitHub Contents API with the file's `sha`, so a stale write
is rejected rather than silently overwriting. The app then re-reads, replays its
queued mutations on top of the fresh copy, and retries — which is why every UI
action is expressed as a mutation rather than a whole-file overwrite. Both
writers emit byte-identical JSON, so the git history shows the change and not a
reformat.

## Tests

```powershell
py -3.13 -m pytest tests/ -q
```

35 tests in real Chromium at the Pixel 7a's viewport with touch enabled: the
logic and storage suites run as modules in the page, the UI tests drive actual
taps, long-presses and drags, and screenshots land in `tests/screenshots/`.

What the tests **cannot** cover: how the long-press drag feels under a real
thumb, and the one-time token paste and install on the device.

## Layout

```
index.html  app.js         UI wiring — holds no task rules of its own
            logic.js       pure functions: mutations, filtering, parsing
            store.js       GitHub Contents API + compare-and-swap
            sync.js        debounced writes, offline queue, status
            sw.js          app-shell cache; never caches the API
tools/      todo.ps1       the PC write path
            make_icons.py  regenerates the PWA icons
tests/      suite.js       logic + storage checks, run in-page
            test_ui.py     real interaction flows
```

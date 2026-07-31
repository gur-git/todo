"""UI flows driven in Chromium at the Pixel 7a's viewport, with touch enabled.

These exercise the real DOM: taps on real buttons, a real long-press, a real
drag. What they cannot do is tell us how the gesture *feels* on glass.
"""

from pathlib import Path

import pytest

SHOTS = Path(__file__).resolve().parent / "screenshots"
SHOTS.mkdir(exist_ok=True)


def add(page, text, topic="inbox"):
    # Wait on the row count, not the text: the app trims input, so matching on
    # the original string is fragile for padded or long titles.
    before = page.locator(".task").count()
    page.select_option("#add-topic", topic)
    page.fill("#add-text", text)
    page.click("#add button[type=submit]")
    page.wait_for_function("n => document.querySelectorAll('.task').length > n", arg=before)


def row(page, text):
    return page.locator(".task").filter(has_text=text).first


def texts(page):
    return [t.strip() for t in page.locator(".task-text").all_inner_texts()]


def visible_tasks(page):
    """Collapsed topics keep their rows in the DOM, so count what's rendered."""
    return page.locator(".task").evaluate_all("els => els.filter(e => e.offsetParent !== null).length")


def set_filter(page, name, on):
    """Tap the chip, not the input — the checkbox itself is visually hidden."""
    if page.is_checked(f"#f-{name}") != on:
        page.click(f".chip-{name} .chip-face")
    assert page.is_checked(f"#f-{name}") is on


def topics_shown(page):
    return page.locator(".topic").evaluate_all("els => els.map(e => e.dataset.topic)")


# --- basics ----------------------------------------------------------------


def test_add_task_lands_in_its_topic(page):
    add(page, "call the bank", "personal")
    assert topics_shown(page) == ["personal"]
    assert texts(page) == ["call the bank"]


def test_topics_render_as_headed_sections_in_file_order(page):
    add(page, "a lab thing", "lab")
    add(page, "a personal thing", "personal")
    add(page, "an inbox thing", "inbox")
    assert topics_shown(page) == ["inbox", "personal", "lab"]
    # Titles are uppercased by CSS, and the header also carries a caret + count.
    heads = [h.replace("\n", " ").strip() for h in page.locator(".topic-head").all_inner_texts()]
    assert "INBOX" in heads[0] and heads[0].endswith("1")


def test_new_task_goes_to_the_top_of_its_topic(page):
    add(page, "first", "lab")
    add(page, "second", "lab")
    assert texts(page) == ["second", "first"]


def test_hebrew_task_renders_right_to_left(page):
    add(page, "לבדוק את המדידה", "lab")
    el = page.locator(".task-text").first
    assert el.evaluate("e => getComputedStyle(e).direction") == "rtl"


# --- states ----------------------------------------------------------------


def test_flag_toggles_on_and_off(page):
    add(page, "flag me", "lab")
    r = row(page, "flag me")
    r.locator(".mark-flag").click()
    assert r.get_attribute("data-state") == "flagged"
    r.locator(".mark-flag").click()
    assert r.get_attribute("data-state") == "normal"


def test_waiting_toggles_and_greys_the_row(page):
    add(page, "wait on someone", "lab")
    r = row(page, "wait on someone")
    r.locator(".mark-wait").click()
    assert r.get_attribute("data-state") == "waiting"
    normal = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--text').trim()")
    greyed = r.locator(".task-text").evaluate("e => getComputedStyle(e).color")
    assert greyed != normal


def test_states_are_mutually_exclusive(page):
    add(page, "conflicted", "lab")
    r = row(page, "conflicted")
    r.locator(".mark-wait").click()
    assert r.get_attribute("data-state") == "waiting"
    r.locator(".mark-flag").click()
    assert r.get_attribute("data-state") == "flagged"


# --- filters ---------------------------------------------------------------


def test_filter_chips_hide_and_show_states(page):
    add(page, "plain one", "lab")
    add(page, "flagged one", "lab")
    row(page, "flagged one").locator(".mark-flag").click()

    set_filter(page, "normal", False)
    assert texts(page) == ["flagged one"]

    set_filter(page, "flagged", False)
    set_filter(page, "normal", True)
    assert texts(page) == ["plain one"]

    set_filter(page, "flagged", True)
    assert sorted(texts(page)) == ["flagged one", "plain one"]


def test_filters_persist_across_a_reload(page):
    add(page, "plain one", "lab")
    set_filter(page, "normal", False)
    page.reload()
    page.wait_for_function("() => !!window.__todo")
    assert page.is_checked("#f-normal") is False


def test_hiding_everything_explains_itself(page):
    add(page, "plain one", "lab")
    set_filter(page, "normal", False)
    assert page.locator("#empty").is_visible()
    assert "hidden by the filters" in page.locator("#empty").inner_text()


def test_counts_track_each_state(page):
    add(page, "one", "lab")
    add(page, "two", "lab")
    row(page, "two").locator(".mark-flag").click()
    assert page.locator("#c-flagged").inner_text() == "1"
    assert page.locator("#c-normal").inner_text() == "1"


# --- topics ----------------------------------------------------------------


def test_topic_collapses_and_expands(page):
    add(page, "hide me", "lab")
    page.click(".topic-head")
    assert visible_tasks(page) == 0
    page.click(".topic-head")
    assert visible_tasks(page) == 1


def test_collapsed_topics_persist_across_a_reload(page):
    add(page, "hide me", "lab")
    page.click(".topic-head")
    page.reload()
    page.wait_for_function("() => !!window.__todo")
    assert page.locator(".topic").first.get_attribute("data-collapsed") == "true"


# --- done + undo -----------------------------------------------------------


def test_done_removes_the_task_and_undo_restores_it(page):
    add(page, "finish me", "lab")
    add(page, "keep me", "lab")
    row(page, "finish me").locator(".done-btn").click()
    assert texts(page) == ["keep me"]

    assert page.locator("#snackbar").is_visible()
    page.click("#undo")
    assert texts(page) == ["keep me", "finish me"]


def test_undo_restores_to_the_original_position(page):
    add(page, "third", "lab")
    add(page, "second", "lab")
    add(page, "first", "lab")
    assert texts(page) == ["first", "second", "third"]
    row(page, "second").locator(".done-btn").click()
    page.click("#undo")
    assert texts(page) == ["first", "second", "third"]


# --- detail sheet ----------------------------------------------------------


def test_detail_sheet_edits_text_note_and_topic(page):
    add(page, "rough draft", "inbox")
    page.click(".task-text")
    page.fill("#d-text", "sharpened")
    page.fill("#d-note", "the long explanation that stays off the list")
    page.select_option("#d-topic", "lab")
    page.click("#d-save")
    page.wait_for_function("() => !document.getElementById('detail').open")

    assert topics_shown(page) == ["lab"]
    assert "sharpened" in texts(page)[0]
    assert page.locator(".has-note").count() == 1


def test_note_stays_off_the_main_list(page):
    add(page, "short title", "inbox")
    page.click(".task-text")
    page.fill("#d-note", "SECRET DETAIL")
    page.click("#d-save")
    page.wait_for_function("() => !document.getElementById('detail').open")
    assert "SECRET DETAIL" not in page.locator("#list").inner_text()


def test_cancelling_the_sheet_changes_nothing(page):
    add(page, "unchanged", "inbox")
    page.click(".task-text")
    page.fill("#d-text", "should not stick")
    page.click('#detail button[value=cancel]')
    page.wait_for_function("() => !document.getElementById('detail').open")
    assert texts(page) == ["unchanged"]


# --- reorder ---------------------------------------------------------------


def long_press(page, locator, ms=700):
    box = locator.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.wait_for_timeout(ms)
    page.mouse.up()
    return x, y


def test_order_does_not_change_without_entering_reorder_mode(page):
    add(page, "bottom", "lab")
    add(page, "top", "lab")
    before = texts(page)
    r = row(page, "top")
    box = r.bounding_box()
    # A plain drag with no long-press: this is the accidental swipe.
    page.mouse.move(box["x"] + 40, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + 40, box["y"] + box["height"] * 2, steps=10)
    page.mouse.up()
    assert texts(page) == before
    assert page.locator("#dragbar").is_hidden()


def test_long_press_arms_reorder_mode(page):
    add(page, "one", "lab")
    long_press(page, row(page, "one"))
    assert page.locator("#dragbar").is_visible()
    assert "reordering" in page.locator("body").get_attribute("class")


def test_drag_reorders_inside_reorder_mode(page):
    add(page, "third", "lab")
    add(page, "second", "lab")
    add(page, "first", "lab")
    assert texts(page) == ["first", "second", "third"]

    long_press(page, row(page, "first"))

    src = row(page, "first").bounding_box()
    dst = row(page, "third").bounding_box()
    page.mouse.move(src["x"] + 40, src["y"] + src["height"] / 2)
    page.mouse.down()
    page.mouse.move(dst["x"] + 40, dst["y"] + dst["height"] * 0.9, steps=12)
    page.mouse.up()

    page.click("#dragdone")
    assert texts(page) == ["second", "third", "first"]


def test_leaving_reorder_mode_disarms_it(page):
    add(page, "bottom", "lab")
    add(page, "top", "lab")
    long_press(page, row(page, "top"))
    page.click("#dragdone")
    assert page.locator("#dragbar").is_hidden()

    before = texts(page)
    box = row(page, "top").bounding_box()
    page.mouse.move(box["x"] + 40, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + 40, box["y"] + box["height"] * 2, steps=10)
    page.mouse.up()
    assert texts(page) == before


def test_reordering_survives_a_reload(page):
    add(page, "second", "lab")
    add(page, "first", "lab")
    long_press(page, row(page, "first"))
    src = row(page, "first").bounding_box()
    dst = row(page, "second").bounding_box()
    page.mouse.move(src["x"] + 40, src["y"] + src["height"] / 2)
    page.mouse.down()
    page.mouse.move(dst["x"] + 40, dst["y"] + dst["height"] * 0.9, steps=10)
    page.mouse.up()
    page.click("#dragdone")
    assert texts(page) == ["second", "first"]

    page.reload()
    page.wait_for_function("() => !!window.__todo")
    assert texts(page) == ["second", "first"]


# --- durability ------------------------------------------------------------


def test_tasks_survive_a_reload(page):
    add(page, "persist me", "lab")
    row(page, "persist me").locator(".mark-flag").click()
    page.reload()
    page.wait_for_function("() => !!window.__todo")
    assert texts(page) == ["persist me"]
    assert row(page, "persist me").get_attribute("data-state") == "flagged"


def test_edits_made_offline_queue_and_survive_a_reload(page):
    """With a token configured but the network down, work must not be lost."""
    page.evaluate("""() => {
        localStorage.setItem('todo.owner', 'gur-git');
        localStorage.setItem('todo.repo', 'todo-data');
        localStorage.setItem('todo.token', 'fake-token-for-offline-test');
    }""")
    page.route("https://api.github.com/**", lambda route: route.abort())
    page.reload()
    page.wait_for_function("() => !!window.__todo")

    add(page, "written on the metro", "lab")
    page.wait_for_function("() => window.__todo.sync.status === 'offline'")
    assert page.locator("#status").get_attribute("data-status") == "offline"

    page.reload()
    page.wait_for_function("() => !!window.__todo")
    assert texts(page) == ["written on the metro"]
    assert page.evaluate("() => window.__todo.sync.pending.length") >= 1


def test_unconfigured_app_says_so_rather_than_looking_empty(page):
    """An unconnected list and an empty list look identical otherwise."""
    assert page.locator("#empty").is_visible()
    assert "Not connected" in page.locator("#empty").inner_text()


def test_settings_prefills_real_values_not_just_placeholders(page):
    """Grey placeholder text reads as 'already filled in'; leaving these blank
    silently produced a local-only list with no sync and no error."""
    page.click("#settings-btn")
    assert page.input_value("#s-owner") == "gur-git"
    assert page.input_value("#s-repo") == "todo-data"
    assert page.input_value("#s-path") == "tasks.json"


def test_a_token_with_no_repo_is_called_out(page):
    page.click("#settings-btn")
    page.fill("#s-owner", "")
    page.fill("#s-repo", "")
    page.fill("#s-token", "some-token")
    page.click("#s-save")
    page.wait_for_selector("#banner:not([hidden])")
    assert "Owner and Data repo are empty" in page.locator("#banner").inner_text()


def test_an_expired_token_says_so_instead_of_failing_quietly(page):
    page.evaluate("""() => {
        localStorage.setItem('todo.owner', 'gur-git');
        localStorage.setItem('todo.repo', 'todo-data');
        localStorage.setItem('todo.token', 'expired');
    }""")
    page.route(
        "https://api.github.com/**",
        lambda route: route.fulfill(status=401, content_type="application/json", body="{}"),
    )
    page.reload()
    page.wait_for_function("() => !!window.__todo")
    page.wait_for_selector("#banner:not([hidden])")
    assert "rejected the token" in page.locator("#banner").inner_text()


# --- appearance ------------------------------------------------------------


@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_screenshot_full_board(page, scheme):
    page.emulate_media(color_scheme=scheme)
    add(page, "renew the lab safety form", "lab")
    add(page, "book the dentist", "personal")
    add(page, "reply to the supervisor about the draft", "lab")
    add(page, "read the BONG paper properly", "explore")
    add(page, "call mum back", "relationships")
    row(page, "reply to the supervisor").locator(".mark-flag").click()
    row(page, "renew the lab safety").locator(".mark-wait").click()
    page.screenshot(path=str(SHOTS / f"board-{scheme}.png"), full_page=True)


def test_screenshot_flagged_only_view(page):
    page.emulate_media(color_scheme="dark")
    add(page, "submit the abstract", "lab")
    add(page, "book the dentist", "personal")
    add(page, "read the BONG paper properly", "explore")
    row(page, "submit the abstract").locator(".mark-flag").click()
    row(page, "book the dentist").locator(".mark-flag").click()
    set_filter(page, "normal", False)
    set_filter(page, "waiting", False)
    page.screenshot(path=str(SHOTS / "flagged-only.png"), full_page=True)
    assert sorted(texts(page)) == ["book the dentist", "submit the abstract"]


def test_screenshot_reorder_mode(page):
    page.emulate_media(color_scheme="dark")
    add(page, "third thing", "lab")
    add(page, "second thing", "lab")
    add(page, "first thing", "lab")
    long_press(page, row(page, "first thing"))
    page.screenshot(path=str(SHOTS / "reorder-mode.png"), full_page=True)


def test_no_horizontal_overflow_with_a_long_task(page):
    add(page, "a task with a very long title " * 6, "lab")
    overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert overflow <= 0, f"page scrolls horizontally by {overflow}px"


def test_tap_targets_are_thumb_sized(page):
    add(page, "measure me", "lab")
    small = page.evaluate("""() => {
        const sel = ['.done-btn', '.mark', '.topic-head', '#add button', '#add input'];
        const bad = [];
        for (const s of sel) for (const el of document.querySelectorAll(s)) {
            const r = el.getBoundingClientRect();
            if (r.height < 26 || r.width < 26) bad.push(s + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
        }
        return bad;
    }""")
    assert small == [], f"targets too small: {small}"

"""Convert the per-repo Drive board into tasks.json.

Two things happen here. The section a task sat under decides its topic, and the
paragraph it was written as becomes a one-line title plus a note — the original
wording is preserved verbatim in the note, so nothing is lost, but the list
becomes scannable.

The 68 open-session markers are not tasks and do not migrate.
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

BOARD = Path(r"G:\My Drive\כללי\דירה\9.Claude\Claude TODO.md")
OUT = Path(__file__).resolve().parent.parent / "data" / "tasks.migrated.json"

TOPICS = [
    ("inbox", "Inbox"),
    ("personal", "Personal"),
    ("lab", "Lab"),
    ("degree", "Degree"),
    ("entrepreneurship", "Entrepreneurship"),
    ("ai-native", "AI Native"),
    ("explore", "Explore"),
    ("relationships", "Relationships"),
]

SECTION_TO_TOPIC = {
    "EE degree": "degree",
    "Research": "explore",
    "AI native research": "ai-native",
    "AI native decision-making": "ai-native",
    "SNN research": "lab",
    "Modem_AI_Equalizer": "lab",
    "model-arena": "ai-native",
    "thoughts": "inbox",
}

# Short titles, keyed by a distinctive fragment of the original bold heading.
# Anything not matched keeps its original bold heading as the title.
TITLES = {
    "Review the EE-degree GOAL.md": "Review the EE degree GOAL.md draft",
    "Finalize BGU EE specialization": "Pick the second specialisation pillar: Control vs EM/RF",
    'Review & commit the Session 8': "Review + commit the Session 8 lab prep (needs C measured at the bench)",
    "Decide the Session 5 formula sheet": "Decide the Session 5 formula sheet + triage the uncommitted tree",
    "Triage two new": "Triage the two new מל\"מ equation-sheet PDFs",
    "Daily": "Run /news and read the digest",
    "Review + commit the new `/news` skill": "Review + commit the /news skill",
    "Review mechanism-sourcing design candidates": "Pick which mechanism-sourcing candidates to promote",
    "Review/merge the `auto/burn-2026-06-11`": "Review or reject the auto/burn-2026-06-11 branch (5 commits)",
    "health-longevity: review pending-integration": "health-longevity: approve folding the sleep subtopic in",
    "methodical-innovation: fill in topic.md": "methodical-innovation: fill in topic.md (blocks gathering)",
    "Pick framing for trust-tier weighting": "Pick the trust-tier weighting framing for synthesis",
    "Confirm gather stop-condition policy": "Confirm the gather stop-condition policy",
    "Decide backlog path convention": "Decide the backlog path convention (flat vs folder)",
    "Approve or reject the DIVERGE inversion": "Approve or reject the DIVERGE inversion+baseline lesson",
    "Approve or reject the secondary-lane": "Approve or reject the secondary-lane fallback lesson",
    "Onboard the professor on the starter": "Onboard the professor on the starter + lock the feedback channel",
    'Flip the "Template repository" toggle': "Flip the Template repository toggle on the starter repo",
    "Pilot the AI-native-research methodology": "Pilot the research methodology on the SNN work + friction log",
    "Get professor consent": "Get professor consent before publicising the research repo",
    "Set up durable read-access": "Set up durable read access to the lab AI-usage survey responses",
    "Decide whether to fold the first-encounter": "Decide whether to fold the first-encounter bet into Q14.1",
    "Review/merge `auto/burn-2026-07-16`": "Review or reject auto/burn-2026-07-16",
    "Decide next learning entry point": "Decide the next SNN learning entry point: U3 vs the T-section sprint",
    "Decide whether to PR `gur-learning`": "Decide whether to PR gur-learning to main (~31 MB of MP3s)",
    "Resolve modem repo's uncommitted state": "Resolve the modem repo's uncommitted state",
    "Decide whether to version model-arena": "Decide whether to git init model-arena + review about-me.md",
}


def parse(text):
    section = None
    items = []
    for line in text.splitlines():
        head = re.match(r"^##\s+(.*?)\s*$", line)
        if head:
            section = re.sub(r"\s*\*\(.*?\)\*\s*$", "", head.group(1)).strip()
            continue
        if not line.startswith("- [ ]"):
            continue
        body = line[5:].strip()
        bold = re.match(r"^(?:[^\w\s]*\s*)?\*\*(.+?)\*\*\s*(.*)$", body)
        heading = bold.group(1).strip() if bold else body
        items.append({"section": section, "heading": heading, "raw": body})
    return items


# Two different repos both have a burn branch of the same name; without the
# source they are indistinguishable on the list.
DISAMBIGUATE = {
    ("AI native research", "Review/merge `auto/burn-2026-07-16`"): "Review or reject auto/burn-2026-07-16 (research repo)",
    ("AI native decision-making", "Review/merge `auto/burn-2026-07-16`"): "Review or reject auto/burn-2026-07-16 (decision-making repo)",
}


def title_for(section, heading):
    for (sec, frag), short in DISAMBIGUATE.items():
        if sec == section and frag.lower() in heading.lower():
            return short
    for frag, short in TITLES.items():
        if frag.lower() in heading.lower():
            return short
    return heading


def main():
    if not BOARD.exists():
        sys.exit(f"board not found: {BOARD}")

    items = parse(BOARD.read_text(encoding="utf-8"))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    tasks = []
    unmatched = []
    for i, item in enumerate(items):
        topic = SECTION_TO_TOPIC.get(item["section"])
        if topic is None:
            unmatched.append(item["section"])
            topic = "inbox"
        title = title_for(item["section"], item["heading"])
        # The note keeps the original wording, including the "(added ...)" dates.
        note = re.sub(r"^\*\*.+?\*\*\s*—?\s*", "", item["raw"]).strip()
        tasks.append({
            "id": f"t_mig{i:04d}",
            "text": title,
            "topic": topic,
            "state": "normal",
            "note": note,
            "created": now,
        })

    state = {
        "version": 1,
        "topics": [{"id": t, "title": n} for t, n in TOPICS],
        "tasks": tasks,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    by_topic = {}
    for t in tasks:
        by_topic.setdefault(t["topic"], []).append(t)
    print(f"{len(tasks)} tasks -> {OUT}\n")
    for tid, name in TOPICS:
        rows = by_topic.get(tid, [])
        print(f"{name} ({len(rows)})")
        for t in rows:
            print(f"   {t['text']}")
        print()
    if unmatched:
        print("NEEDS ATTENTION:")
        for u in unmatched:
            print("  -", u)


if __name__ == "__main__":
    main()

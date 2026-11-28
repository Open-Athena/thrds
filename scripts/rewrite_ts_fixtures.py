"""TS parity fixtures for `thrds.rewrite`: content hashes and a plan, written for the `ts` branch's tests.

    scripts/rewrite_ts_fixtures.py <ts-checkout>/tests/fixtures

Run by `scripts/sync-rewrite-bundle`. `tests/rewrite-slack.test.ts` (ts) checks its `contentHash` against
`rewrite-hashes.json`, its `sameContent` against `rewrite-same.json`, and that planning the same fake channel gives
`rewrite-plan.json`.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tests.test_rewrite import DIGEST, LONG, LONG_IMAGE, LONG_LINE, LONG_SECTIONS, FakeChannel, RICH, SAME_CASES, SECTION  # noqa: E402
from thrds.rewrite import Content, Desired, Sender, find_history, plan, same_content, substitute  # noqa: E402

out = Path(sys.argv[1])
contents = [
    Content("plain"),
    Content(""),
    Content('quotes " and \\ backslash, tab\t, newline\n, nul \x00, bell \x07, del \x7f'),
    Content("unicode: é ü 日本語 🚀     😀", sender=DIGEST),
    Content("blocks", blocks=[{"type": "section", "block_id": "b1", "text": {"type": "mrkdwn", "text": "*x* ✓", "verbatim": False}, "fields": [{"type": "plain_text", "text": "1", "emoji": True}]}]),
    Content("files", files=("F1", "F2"), sender=Sender(username="U", icon_url="https://example.com/a.png")),
    Content("nested", blocks=[{"z": 1, "a": [2, -3, 1234567890123], "m": {"b": None, "a": True}}]),
]
(out / "rewrite-hashes.json").write_text(json.dumps([{"content": c.to_json(), "hash": c.hash} for c in contents], indent=2, ensure_ascii=False) + "\n")

same = [{"live": live.to_json(), "want": want.to_json(), "same": same_content(live, want)} for live, want, _ in SAME_CASES]
(out / "rewrite-same.json").write_text(json.dumps(same, indent=2, ensure_ascii=False) + "\n")

ch = FakeChannel()
ch.add("1.0", ":old: one 🚀")
ch.add("2.0", ":old: two", blocks=[RICH])
ch.add("2.1", ":old: reply", thread_ts="2.0")
ch.add("2.2", "a person's reply :old:", thread_ts="2.0", ours=False)
ch.add("3.0", "nothing to change")
ch.add("4.0", "fallback :old:", blocks=[{"block_id": "s0", **SECTION}])
ch.add("5.0", "a person :old:", ours=False)
ch.add("6.0", "card :old:", metadata={"event_type": "fleet", "event_payload": {"id": 1}})
# Over 4,000 chars of text, planned as `post` / `edit` send it (`sendable`). (Over 50 sections takes 75k+ chars: tested
# on each side, not here.)
for ts in ("7.0", "7.1", "7.2"):
    ch.add(ts, "short")
sub = substitute({":old:": ":new:"})
LONG_RENDERS = {
    "7.0": Desired(LONG),
    "7.1": Desired(LONG, [*LONG_SECTIONS, LONG_IMAGE]),
    "7.2": Desired(LONG_LINE),
}


def render(f):
    if f.ts in LONG_RENDERS:
        return LONG_RENDERS[f.ts]
    d = sub(f)
    return Desired(d.text, d.blocks, sender=DIGEST) if f.ts == "6.0" else d


p = plan(find_history(ch, include_replies=True, include_foreign=True), render)
(out / "rewrite-plan.json").write_text(json.dumps(p.to_json(), indent=2, ensure_ascii=False) + "\n")
print(p.summary())

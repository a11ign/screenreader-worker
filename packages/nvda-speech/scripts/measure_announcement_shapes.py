"""How many rules would a port of NVDA's composition actually need? Answered from the corpus.

    python3 packages/nvda-speech/scripts/measure_announcement_shapes.py

This is the measurement the spike's go/no-go rested on, kept so the decision is re-derivable rather
than remembered. The bar was set BEFORE running it: ten patterns covering 90% of announcements means
the port is a bounded rule set; a long tail means it is `getControlFieldSpeech` in full (332 lines of
edge cases) plus `getTextInfoSpeech` (392 more), and the answer is don't.

Measured: 18,371 announcements, 33 distinct shapes, top 10 covering 94.3%. Go.

It tokenises each announcement against the GENERATED role and state labels, so it is checking real
NVDA vocabulary rather than a guess at it — and it needs no worker, no VM and no network.
"""

import collections
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nvda_speech.labels import NEGATIVE_STATE_LABELS, ROLE_LABELS, STATE_LABELS  # noqa: E402

ROLES = {v.lower() for v in ROLE_LABELS.values() if v}
STATES = {v.lower() for v in [*STATE_LABELS.values(), *NEGATIVE_STATE_LABELS.values()] if v}

# NVDA composes a landmark's announcement as "<name> landmark", so the label alone is not in ROLES.
LANDMARKS = {"banner", "navigation", "main", "complementary", "content info", "region", "search", "form"}

FIELDS = ("headings", "landmarks", "formFields", "links", "lists", "graphics", "tableCells")
CAPTURES = Path("runs/screenreader-dataset/captures")


def classify(token: str) -> str:
    """Which KIND of token is this — the shape is what matters, not the words."""
    text = token.strip().lower()
    if not text:
        return ""
    if text in ROLES:
        return "ROLE"
    if text in STATES:
        return "STATE"
    if re.fullmatch(r"level \d+", text):
        return "LEVEL"
    if re.fullmatch(r"with \d+ items?", text):
        return "COUNT"
    if re.fullmatch(r"\d+ of \d+", text):
        return "POSITION"
    if text.endswith(" landmark") and text[: -len(" landmark")] in LANDMARKS:
        return "ROLE"
    return "NAME"


def main() -> None:
    if not CAPTURES.is_dir():
        raise SystemExit(f"no corpus at {CAPTURES} — this measurement needs the captures on disk")
    shapes: collections.Counter[tuple[str, ...]] = collections.Counter()
    total = 0
    files = [f for f in os.listdir(CAPTURES) if f.endswith(".json")]
    for name in files:
        try:
            captured = json.loads((CAPTURES / name).read_text())
        except (OSError, json.JSONDecodeError):
            continue  # a half-written capture is not a shape; the corpus test owns that complaint
        capture = captured.get("capture", captured)
        for field in FIELDS:
            for announcement in (capture.get("structure") or {}).get(field) or []:
                shape = tuple(kind for kind in (classify(t) for t in str(announcement).split(",")) if kind)
                if shape:
                    shapes[shape] += 1
                    total += 1

    print(f"  captures {len(files)}   announcements {total}   distinct shapes {len(shapes)}\n")
    cumulative = 0
    for rank, (shape, count) in enumerate(shapes.most_common(14), 1):
        cumulative += count
        print(f"  {rank:>2}. {' + '.join(shape):<40} {count:>6} {100 * count / total:5.1f}%"
              f"  cum {100 * cumulative / total:5.1f}%")
    top10 = sum(count for _, count in shapes.most_common(10))
    print(f"\n  top 10 shapes cover {100 * top10 / total:.1f}% of announcements")


if __name__ == "__main__":
    main()

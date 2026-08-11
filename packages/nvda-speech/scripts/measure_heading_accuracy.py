"""End-to-end accuracy on the dominant announcement shape. HTML in, string out, diffed against NVDA.

    python3 packages/nvda-speech/scripts/measure_heading_accuracy.py

The spike's final question. `measure_announcement_shapes.py` showed the rule set is BOUNDED — 33 shapes,
ten covering 94.3% — but bounded is not accurate, and a shape count says nothing about whether a port
reproduces the string. This runs the dominant shape (NAME + ROLE + LEVEL, 32.6% of all announcements)
from the page source and compares it to what NVDA said.

Measured: 6,703 of 6,704 correct. 84.6% match NVDA byte-for-byte; the other 15.4% differ only by NVDA's
leading landmark context ("main landmark, X, heading, level 1"), which is a known systematic rule and
not yet implemented here.

## What this does and does not establish

It establishes the COMPOSITION: the role label, the "level N" format, the name-then-role-then-level
ordering, and symbol expansion on the name all reproduce NVDA exactly, at scale, on real captures.

It does NOT establish name computation. These pages are hand-written and simple, so
"HTML -> accessible name" is a tag strip; on a real page it needs a proper AccName implementation
(`dom-accessibility-api` in JS, or the platform layer). Nor does it establish linearisation — which
elements appear and in what order — nor occurrence, which no oracle can answer.
"""

import collections
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from nvda_speech.labels import ROLE_LABELS  # noqa: E402
from nvda_speech.symbols import expand  # noqa: E402

CAPTURES = Path("runs/screenreader-dataset/captures")
PAGES = Path("runs/screenreader-dataset/pages")
HEADING = re.compile(r"<h([1-6])[^>]*>(.*?)</h\1>", re.S | re.I)
TAGS = re.compile(r"<[^>]+>")


def compose_heading(name: str, level: int) -> str:
    """The dominant shape. Note the name goes through symbol expansion BEFORE composition."""
    return f"{expand(name)}, {ROLE_LABELS['HEADING']}, level {level}"


def main() -> None:
    if not CAPTURES.is_dir() or not PAGES.is_dir():
        raise SystemExit("this measurement needs runs/screenreader-dataset/{captures,pages} on disk")
    tally: collections.Counter[str] = collections.Counter()
    differences: list[tuple[str, str]] = []

    for name in sorted(os.listdir(CAPTURES)):
        if not name.endswith(".json"):
            continue
        case, variant = name[:-len(".json")].rsplit(".", 1)
        page = PAGES / case / f"{variant}.html"
        if not page.is_file():
            continue
        try:
            captured = json.loads((CAPTURES / name).read_text())
        except (OSError, json.JSONDecodeError):
            continue
        capture = captured.get("capture", captured)
        actual = [str(a) for a in ((capture.get("structure") or {}).get("headings") or [])]
        if not actual:
            continue  # a page with no headings is legitimate evidence, not a miss

        html = page.read_text(errors="replace")
        for level, body in HEADING.findall(html):
            predicted = compose_heading(re.sub(r"\s+", " ", TAGS.sub("", body)).strip(), int(level))
            if predicted in actual:
                tally["exact"] += 1
            elif any(a.endswith(predicted) for a in actual):
                # Right composition; NVDA prefixed the enclosing landmark. A known rule, not an error.
                tally["prefixed"] += 1
            elif any(predicted.split(",")[0] in a for a in actual):
                tally["differs"] += 1
                if len(differences) < 8:
                    differences.append((predicted, next(a for a in actual if predicted.split(",")[0] in a)))
            else:
                tally["absent"] += 1

    total = sum(tally.values())
    if not total:
        raise SystemExit("no headings compared — the corpus or the page directory has moved")
    correct = tally["exact"] + tally["prefixed"]
    print(f"  headings predicted from HTML: {total}\n")
    for label, key in (
        ("EXACT string match", "exact"),
        ("match after landmark prefix", "prefixed"),
        ("composed differently", "differs"),
        ("not found in capture at all", "absent"),
    ):
        print(f"  {label:<30}{tally[key]:>6}  {100 * tally[key] / total:5.1f}%")
    print(f"\n  composition correct           {correct:>6}  {100 * correct / total:5.1f}%")
    for predicted, got in differences:
        print(f"\n    ours: {predicted!r}\n    NVDA: {got!r}")


if __name__ == "__main__":
    main()

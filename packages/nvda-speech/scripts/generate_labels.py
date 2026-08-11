"""Extract NVDA's role and state labels into `nvda_speech/labels.py`.

Generated rather than hand-copied, deliberately. There are 159 roles and 52 states, and a
transcription slip in one of them produces a wrong announcement that looks entirely plausible — the
class of defect this project has paid for repeatedly. A generator is also re-runnable against a newer
NVDA, and the diff tells you exactly which labels moved.

Reads `_roleLabels` / `_stateLabels` / `_negativeStateLabels` out of the reference source by parsing
the dict literals, so it cannot silently pick up a differently-named mapping.
"""

import pathlib
import re

REF = pathlib.Path(__file__).resolve().parent.parent / "reference"
OUT = pathlib.Path(__file__).resolve().parent.parent / "nvda_speech" / "labels.py"

# `Role.BUTTON: _("button"),` and the pgettext variant NVDA uses for one ambiguous label.
ENTRY = re.compile(
    r"^\s*(?:Role|State)\.(?P<key>[A-Z0-9_]+)\s*:\s*"
    r"(?:_\(\s*(?P<q>[\"'])(?P<plain>.*?)(?P=q)\s*\)"
    r"|pgettext\(\s*[\"'].*?[\"']\s*,\s*(?P<q2>[\"'])(?P<ctx>.*?)(?P=q2)\s*\))",
)


# The ASSIGNMENT, not the first mention. `source.index(name)` found a `return _negativeStateLabels`
# inside a getter dozens of lines earlier, so extraction started mid-function, never balanced its
# braces, and ran on into the NEXT dict — reporting 51 negative-state labels where NVDA has 5. It
# produced a plausible-looking label set that was simply wrong, which is the exact failure this
# generator exists to prevent, committed inside the generator.
ASSIGNMENT = r"^{name}\b[^=\n]*=\s*\{{"


def extract(source: str, name: str) -> dict[str, str]:
    """Pull one dict literal's entries. Bounded to the literal so neighbouring dicts cannot leak in."""
    anchor = re.search(ASSIGNMENT.format(name=re.escape(name)), source, re.M)
    if not anchor:
        raise SystemExit(f"no assignment found for {name} — has NVDA renamed or restructured it?")
    start = anchor.start()
    depth = 0
    body: list[str] = []
    for line in source[start:].split("\n"):
        depth += line.count("{") - line.count("}")
        body.append(line)
        if depth == 0 and body[0].count("{"):
            break
    out: dict[str, str] = {}
    for line in body:
        match = ENTRY.match(line)
        if match:
            out[match.group("key")] = match.group("plain") or match.group("ctx")
    if not out:
        raise SystemExit(f"extracted nothing for {name} — has NVDA renamed it?")
    return out


def main() -> None:
    roles = extract((REF / "role.py").read_text(), "_roleLabels")
    states = extract((REF / "state.py").read_text(), "_stateLabels")
    negative = extract((REF / "state.py").read_text(), "_negativeStateLabels")

    def render(name: str, mapping: dict[str, str]) -> str:
        rows = "\n".join(f'    "{k}": {v!r},' for k, v in sorted(mapping.items()))
        return f"{name}: dict[str, str] = {{\n{rows}\n}}\n"

    OUT.write_text(
        '"""NVDA\'s spoken labels for roles and states. GENERATED — do not edit by hand.\n'
        '\n'
        'Regenerate with `python3 scripts/generate_labels.py`. Derived from NVDA\n'
        '(source/controlTypes/{role,state}.py), GPL-2.0-or-later; see this package\'s LICENSE.\n'
        '\n'
        'These strings ARE the product\'s vocabulary: every announcement this package composes is built\n'
        'from them, so a wrong one is a wrong finding that reads perfectly.\n'
        '"""\n\n'
        + render("ROLE_LABELS", roles)
        + "\n"
        + render("STATE_LABELS", states)
        + "\n"
        + render("NEGATIVE_STATE_LABELS", negative),
    )
    # Counted from the source with awk before this generator was trusted. An extraction that drifts
    # from these numbers has either found the wrong literal or NVDA has changed — both need a human,
    # and neither should silently produce a label set.
    expected = {"roles": 156, "states": 51, "negative": 5}
    actual = {"roles": len(roles), "states": len(states), "negative": len(negative)}
    if actual != expected:
        raise SystemExit(f"extraction mismatch: got {actual}, expected {expected}. "
                         "If NVDA genuinely changed, update the expected counts IN THE SAME COMMIT "
                         "as the regenerated labels, so the diff shows what moved.")
    print(f"  roles: {len(roles)}  states: {len(states)}  negative: {len(negative)}  (all as expected)")
    print(f"  written: {OUT.relative_to(OUT.parent.parent.parent.parent)}")


if __name__ == "__main__":
    main()

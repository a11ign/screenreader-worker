"""Symbol expansion — why a screen reader says "Logo dot svg" for `alt="Logo.svg"`.

Derived from NVDA (`source/locale/en/symbols.dic`, `source/characterProcessing.py`),
GPL-2.0-or-later; see this package's LICENSE.

This layer is easy to forget and impossible to omit. It is not composition — composition puts role,
name and states in order — it is what happens to the TEXT before any of that. A port that did
composition alone would emit `graphic, Logo.svg`, fail every corpus comparison, and look like the
whole thesis was wrong. It was the first thing I missed when estimating this work.

## The subtlety that makes it correct

`symbols.dic` assigns every symbol a LEVEL, and NVDA speaks a symbol only when its level is at or
below the user's configured level. The default is `some`. So:

    .                    dot            some     <- plain full stop: SPOKEN at default
    . sentence ending    dot            all      <- end of a sentence: SILENT at default

That is why `Logo.svg` is heard as "Logo dot svg" while "It is done." has no audible full stop. Both
are a `.`; the level and the surrounding context decide. Getting this backwards would add a spurious
"dot" to the end of every sentence in a read-through, which is the kind of wrongness that reads as a
page defect.

`complexSymbols` are named regexes (sentence endings, decimal points, in-word apostrophes) and must be
applied BEFORE literal single-character rules, or the literal `.` rule claims a sentence ending first
and the level distinction above never gets a chance to apply.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

# NVDA's symbol levels, lowest to highest. A symbol is spoken when its level is <= the configured one.
LEVELS = ("none", "some", "most", "all", "char")

# NVDA's shipped default (`symbolLevel` = SOME). Every capture in this repo's corpus was taken at the
# defaults, deliberately — "NVDA's defaults are what a real user experiences" — so this is the level a
# comparison against that corpus must use.
DEFAULT_LEVEL = "some"


# Public (not `_`-prefixed) so a caller — a test deciding whether to skip, `fetch_reference.py`'s
# consumers — can ask where this resolves to without restating the path. One computation, not two.
DIC_PATH = Path(__file__).resolve().parent.parent / "reference" / "symbols.dic"


@dataclass(frozen=True)
class Symbol:
    """One rule: what to say instead of a symbol, and how verbose the user must be for it to count."""

    identifier: str
    replacement: str
    level: str
    # `never` drop the character, `always` keep it, `norep` keep it only when nothing was spoken.
    # Ignoring this field turned "3.5" into "3 5": the decimal-point rule has an EMPTY replacement,
    # level `none` and preserve `always` — meaning "keep the character, say nothing about it". Treating
    # an above-level rule as "delete the character" is right for a sentence-ending full stop and wrong
    # for a decimal point, and only this field distinguishes them.
    preserve: str
    pattern: re.Pattern[str] | None  # set for complexSymbols, None for a literal match


def _level_at_most(level: str, ceiling: str) -> bool:
    """Is `level` spoken when the user is configured at `ceiling`?"""
    try:
        return LEVELS.index(level) <= LEVELS.index(ceiling)
    except ValueError:
        # An unknown level must NOT default to "spoken": inventing an announcement is worse than
        # omitting one, and this project's whole position is that the expensive direction to be wrong
        # in is claiming something that is not there.
        return False


def load_symbols(path: Path | None = None) -> list[Symbol]:
    """Parse `symbols.dic` into rules, complex ones first.

    Order is load-bearing rather than incidental — see the module docstring. Returned as a list, not a
    dict, because application order is part of the behaviour.
    """
    text = (path or DIC_PATH).read_text(encoding="utf-8-sig")
    complex_patterns: dict[str, str] = {}
    symbols: list[Symbol] = []
    section = None
    for raw in text.split("\n"):
        line = raw.rstrip("\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.strip() in ("complexSymbols:", "symbols:"):
            section = line.strip().rstrip(":")
            continue
        fields = line.split("\t")
        if section == "complexSymbols" and len(fields) >= 2:
            complex_patterns[fields[0]] = fields[1]
        elif section == "symbols" and len(fields) >= 2:
            identifier, replacement = fields[0], fields[1]
            level = fields[2] if len(fields) > 2 and fields[2] else "all"
            # NVDA's default when the column is absent.
            preserve = fields[3] if len(fields) > 3 and fields[3] else "never"
            pattern = complex_patterns.get(identifier)
            symbols.append(
                Symbol(
                    identifier=identifier,
                    replacement=replacement,
                    level=level,
                    preserve=preserve,
                    pattern=re.compile(pattern) if pattern else None,
                ),
            )
    if not symbols:
        raise RuntimeError(f"no symbol rules parsed from {path or DIC_PATH} — has the format changed?")
    # Complex (regex) rules first, then literals longest-first so "..." beats "." — otherwise the
    # single-character rule fires three times and "dot dot dot" never appears.
    return sorted(symbols, key=lambda s: (s.pattern is None, -len(s.identifier)))


def _render(matched: str, symbol: Symbol, level: str) -> str:
    """What a matched symbol becomes: its spoken form, the character itself, or both.

    Three independent decisions, and conflating any two of them produces a plausible-looking wrong
    announcement. Whether the replacement is SPOKEN is the level's business; whether the character is
    KEPT is `preserve`'s; and a `norep` symbol is kept only when nothing was spoken for it.
    """
    spoken = symbol.replacement if (symbol.replacement and _level_at_most(symbol.level, level)) else ""
    keep = symbol.preserve == "always" or (symbol.preserve == "norep" and not spoken)
    return f"{matched if keep else ''}{f' {spoken} ' if spoken else ''}" or " "


def expand(text: str, level: str = DEFAULT_LEVEL, symbols: list[Symbol] | None = None) -> str:
    """Replace symbols with their spoken form, as NVDA would at `level`.

    Spaces are inserted around each replacement because that is what makes "Logo dot svg" three words
    rather than "Logodotsvg", and then collapsed — NVDA's own output carries single spaces.
    """
    rules = symbols if symbols is not None else load_symbols()
    out = text

    # A complex rule CLAIMS its match whatever the level; the level decides only whether the claim is
    # voiced. Skipping an above-level complex rule outright — which is what the first version did — left
    # the character on the table for the literal rule to take, so a sentence-ending full stop (level
    # `all`, silent by default) was re-claimed by the plain `.` rule (level `some`) and spoken. "It is
    # done." came out as "It is done dot", which would have appended a spurious word to the end of every
    # sentence in a read-through and read as a page defect rather than a porting bug.
    # A claimed span is PARKED behind a sentinel, not written back as text.
    #
    # NVDA tokenises: once a complex rule owns a span, no later rule reconsiders it. Substituting the
    # rendered text straight back re-exposed it — a decimal point preserved by its own rule was then
    # picked up by the plain `.` rule and spoken, so "3.5" became "3 dot 5". Parking the result means
    # "preserve the character" cannot accidentally mean "offer it to the next rule".
    parked: list[str] = []

    def park(rendered: str) -> str:
        parked.append(rendered)
        return f"\x00{len(parked) - 1}\x00"

    for symbol in rules:
        if symbol.pattern is None:
            continue
        out = symbol.pattern.sub(lambda m, s=symbol: park(_render(m.group(0), s, level)), out)

    # Literals only get what the complex rules did not claim.
    for symbol in rules:
        if symbol.pattern is not None or not _level_at_most(symbol.level, level):
            continue
        if symbol.identifier in out:
            out = out.replace(symbol.identifier, _render(symbol.identifier, symbol, level))

    out = re.sub(r"\x00(\d+)\x00", lambda m: parked[int(m.group(1))], out)
    return re.sub(r"\s+", " ", out).strip()

"""Symbol expansion, checked against announcements a real screen reader actually produced.

Every case here is either taken from this repo's corpus or from a live capture of a real website, which
is the point: the acceptance bar for a port is "it reproduces observed behaviour", not "it looks like
the source". Three of these failed in three different ways while the port was being written, and each
failure would have produced a plausible-looking wrong announcement rather than an error.

    python3 -m pytest packages/nvda-speech/tests -q

## Needs `reference/symbols.dic`, which is fetched, not committed

`nvda-speech/README.md` states why: "the repo keeps generated output and the generator, not a vendored
copy" of NVDA's own upstream source — the same principle `.gitignore` applies to `runs/`, stated here for
a different resource. Six of these seven tests call `expand()`/`load_symbols()` with no dictionary of
their own, which reads `nvda_speech.symbols.DIC_PATH` by default and previously raised a bare
`FileNotFoundError` in a checkout that had never fetched it — six failures indistinguishable from a real
porting regression, in a worktree with nothing wrong. `needs_symbols_dic` below skips them honestly
instead, naming the file and the one command that gets it, matching the shape `npm test`'s Python half
and `verify.corpus.test.ts` already use for their own gitignored dependencies.
"""

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from nvda_speech.symbols import DEFAULT_LEVEL, DIC_PATH, expand, load_symbols  # noqa: E402

needs_symbols_dic = pytest.mark.skipif(
    not DIC_PATH.is_file(),
    reason=(
        f"{DIC_PATH} is gitignored and fetched on demand, not committed — run "
        "`python3 packages/nvda-speech/scripts/fetch_reference.py` to get it. Honest skip, not a pass."
    ),
)


@needs_symbols_dic
def test_the_dictionary_parses():
    rules = load_symbols()
    assert len(rules) > 500, "the English symbol dictionary has ~570 rules; a short parse means the format moved"


@needs_symbols_dic
def test_filename_alt_text_is_spoken_as_dot():
    """The finding this whole layer exists for, verified against a live capture.

    `alt="Logo.svg"` on a real site was announced by NVDA as "Logo dot svg". That is not composition —
    role and name ordering happen later — it is the symbol dictionary turning `.` into "dot" at the
    default level. A port without this layer emits "Logo.svg" and fails every corpus comparison.
    """
    assert expand("Logo.svg") == "Logo dot svg"
    assert expand("Riot Games Logo.svg") == "Riot Games Logo dot svg"
    assert expand("IMG_4821.JPG") == "IMG_4821 dot JPG"


@needs_symbols_dic
def test_a_sentence_ending_full_stop_is_NOT_spoken():
    """The same character, silent — because context and level decide, not the character.

    `. sentence ending` is level `all`; the plain `.` is level `some`; the default is `some`. So a full
    stop at the end of a sentence is preserved and unspoken while a mid-word one becomes "dot". The
    first version of this got it backwards and appended "dot" to every sentence in a read-through,
    which would have read as a page defect rather than a porting bug.
    """
    assert expand("It is done.") == "It is done."
    assert expand("Open 9am to 8pm on weekdays.") == "Open 9am to 8pm on weekdays."


@needs_symbols_dic
def test_a_decimal_point_is_preserved_and_silent():
    """`preserve` is a third independent decision, and ignoring it turned "3.5" into "3 5".

    The decimal-point rule has an EMPTY replacement, level `none`, and preserve `always`: keep the
    character, say nothing about it. Treating "above the level" as "delete the character" is correct
    for a sentence-ending stop and wrong here, and only this column distinguishes them.
    """
    assert expand("3.5") == "3.5"
    assert expand("Version 2.10 released") == "Version 2.10 released"


@needs_symbols_dic
def test_a_claimed_span_is_not_reconsidered():
    """NVDA tokenises; a span owned by one rule is not offered to the next.

    Writing a preserved character back as text re-exposed it to the plain `.` rule, so a decimal point
    protected by its own rule was spoken anyway — "3 dot 5". Claimed spans are parked instead.
    """
    assert "dot" not in expand("3.5")
    assert expand("Children's story time") == "Children's story time"


@needs_symbols_dic
def test_ordinary_text_is_untouched():
    """The commonest case, and the one a regression would be loudest in."""
    for text in ("Core components", "Welcome to the City Library", "Sign up", "Email address (required)"):
        assert expand(text) == text, text


def test_an_unknown_level_is_silent_rather_than_spoken():
    """A malformed rule must not invent an announcement.

    This project's position is that the expensive direction to be wrong in is claiming something that is
    not there, so an unrecognised level fails closed.
    """
    from nvda_speech.symbols import Symbol

    made_up = [Symbol(identifier="@", replacement="at", level="nonsense", preserve="never", pattern=None)]
    assert expand("a@b", DEFAULT_LEVEL, made_up) == "a@b"

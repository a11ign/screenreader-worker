# @a11y-witness/nvda-speech

**What NVDA would say about an element, computed without Windows.**

A pure function: accessibility node in, announcement string out. No I/O, no network, no state, no
screen reader. That is the whole point — it is testable against the 2,122 real NVDA announcements in
`runs/screenreader-dataset/`, which is an unusually strong position to port behaviour from.

## Licence boundary — read before importing this

This package is **derived from NVDA**, which is GPL-2.0-**or-later**. "Or later" is what makes this
viable: the port is taken under GPL-3.0, which combines with this repo's AGPL-3.0 engine.

**`@a11y-witness/evidence` is Apache-2.0 and MUST NOT import this package.** That split exists so
third parties can write capture backends without inheriting a copyleft obligation (ADR 0006), and
GPL-derived code reaching it would break the licence, not merely the architecture. There is a test
that fails if it happens.

## The boundary that matters more

**This package predicts. It does not observe.**

The repo's existing rule is that the accessibility tree is "a completeness ORACLE and never
evidence". A predicted announcement is more dangerous than a tree count, because it looks exactly
like the real thing. If one ever reaches the judge as though a screen reader said it, the claim this
product rests on — *a real screen reader announced this* — is gone, and quietly.

So predicted output is structurally distinct from observed output. Different shape, different field
names, and a test that fails if predicted text appears in an evidence field.

### Content, not occurrence

| this package answers | only a real screen reader answers |
|---|---|
| what would NVDA say about this element? | did NVDA actually say it, and when? |
| role labels, states, symbol expansion, ordering | live-region politeness, interruption, buffer staleness |

3.3.1 and 4.1.3 are questions of *occurrence*. They stay with the worker. This package cannot and
must not be used for them.

## Provenance

`reference/` holds NVDA source fetched for porting and is **gitignored** — the repo keeps generated
output and the generator, not a vendored copy. `scripts/` records exactly which upstream files and
symbols each piece came from, so the derivation is auditable.

| ported from | what |
|---|---|
| `source/controlTypes/role.py` | 159 roles + `_roleLabels` |
| `source/controlTypes/state.py` | 52 states + `_stateLabels`, `_negativeStateLabels` |
| `source/locale/en/symbols.dic` | symbol expansion — this is why `Logo.svg` is heard as "Logo dot svg" |
| `source/speech/speech.py` | `getControlFieldSpeech`, `getPropertiesSpeech` |

## Refresh

    python3 scripts/fetch_reference.py     # pull NVDA source into reference/
    python3 scripts/generate_labels.py     # regenerate nvda_speech/labels.py
    python3 scripts/measure_against_corpus.py   # how close are we? prints a number

"""Pull the NVDA source this package is derived from into `reference/` (gitignored).

Kept as a script rather than a vendored copy so the repo holds GENERATED output and the recipe, not
several thousand lines of someone else's source. Re-run it to re-derive against a newer NVDA — and
note that NVDA's version is already treated as evidence by the capture pipeline, so a refresh is an
evidence-affecting change, not a chore.
"""

import pathlib
import urllib.request

BASE = "https://raw.githubusercontent.com/nvaccess/nvda"
REF = "master"

FILES = [
    "source/controlTypes/role.py",
    "source/controlTypes/state.py",
    "source/speech/speech.py",
    "source/characterProcessing.py",
    "source/locale/en/symbols.dic",
]


def main() -> None:
    out = pathlib.Path(__file__).resolve().parent.parent / "reference"
    out.mkdir(exist_ok=True)
    for path in FILES:
        target = out / pathlib.Path(path).name
        with urllib.request.urlopen(f"{BASE}/{REF}/{path}", timeout=60) as response:
            target.write_bytes(response.read())
        print(f"  {target.name}: {len(target.read_text().splitlines())} lines")


if __name__ == "__main__":
    main()

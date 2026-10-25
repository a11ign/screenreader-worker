Refs A11-253

Step 2 of 2 (screenreader-worker): `.github/dependabot.yml` is now the output of `dependabot-config --write` from `@a11ign/toolchain` 0.11.0 (0.10.2 before), not a hand-written file. Every ecosystem runs weekly on Monday at 05:23 UTC, patch and minor updates share one `<ecosystem>-minor-and-patch` group so a major is its own pull request, and the packages frozen by policy are ignored in the npm entry. `@guidepup/guidepup` was ignored here already, with its reason in a comment; the reason now lives once, in the toolchain's frozen list. `scripts/dependabot-config.test.ts` fails when the committed file is not what `--write` produces.

Acceptance:

```bash
pnpm install --frozen-lockfile
# the committed file is exactly the template's output (exit 1 and a diff on drift)
pnpm exec dependabot-config --check
node --test scripts/dependabot-config.test.ts
# weekly at one fixed time, one group per ecosystem
grep -q 'interval: weekly' .github/dependabot.yml
grep -q 'time: "05:23"' .github/dependabot.yml
grep -q 'npm-minor-and-patch:' .github/dependabot.yml
grep -q 'github-actions-minor-and-patch:' .github/dependabot.yml
# every package frozen by policy is ignored
grep -qF 'dependency-name: "@a11ign/screenreader-worker"' .github/dependabot.yml
grep -qF 'dependency-name: "@a11ign/screenreader-fleet"' .github/dependabot.yml
grep -qF 'dependency-name: "@guidepup/guidepup"' .github/dependabot.yml
grep -qF 'dependency-name: "@guidepup/setup"' .github/dependabot.yml
```

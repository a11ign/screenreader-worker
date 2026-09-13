## If you are an agent, start with these

```bash
npm run doctor                  # can I run right now? every check names its own fix
npm run doctor -- --json        # same, machine-readable, with a next_command field
```

**Read `next_command` and do that.** `doctor` exits 0 when a run can proceed, which is not the
same as everything already running:

> **A stopped worker VM is the correct resting state, not a fault.** A run starts what it needs and
> releases it when it is done, so `all stopped` means ready rather than broken. Do not hunt for
> another worker and do not open the UTM GUI — just run the capture.

The only worker states that are actually broken: a VM running but not answering `/health`, or no VM registered at all. `doctor` answers VM state, worker health, page server, judge backend and whether a run was left mid-flight. For local-VM pooling (multiple UTM guests on this Mac, deprecated in favour of the bare-metal fleet) — `training:capture`, `worker:ctl -- pool`, `A11Y_WORKERS`/`A11Y_VM_AFTER`/`A11Y_LOCAL_VM` — see [the pool commands](docs/local-worker-vm.md#for-a-long-run-use-more-than-one-worker-moved-from-claudemd-458).

Local-VM pool sizing was measured before the fleet moved to bare metal (disk-bound negative scaling, ~8 GB/guest, a second guest halving reliability). [Measurements →](docs/fleet-capacity-history.md#update-three-workers-now-scale-and-the-negative-scaling-section-below-is-out-of-date)
## What the screen reader drives

`docs/screenreader-coverage.md` is the map: every user behaviour we drive, the field it lands
in, and — the part that matters — **what we do not drive yet**, with the guidepup command for
each. Read it before adding a probe, and update it when you do. A behaviour missing from that
table is not a missing feature; it is a claim this project cannot currently make.

`probeForms` defaults **ON in the GitHub Action and OFF in the CLI** — the split follows who owns the
page, not what the tool prefers. A workflow runs against your own app, where submitting is intended and
3.3.1/4.1.3 are otherwise structurally unreachable; the CLI can be aimed at any URL, and pressing *Book*
on a stranger's site is not a review. `chooseProbe` is exported and unit-tested for exactly that gate.

Other probes beyond the default set are opt-in over the wire (`probeFocus`) so a capture
never pays for evidence nobody asked for. `focusOrder` costs ~8 s on a ~15 s CORPUS capture; on real pages, 72.5 s and 16.3 s.
## Captures are cached — and the cache is keyed on more than the page

A full run is 1,061 pairs, so `npm run training:capture` reuses evidence on disk when nothing that
shapes it has changed. The key covers the page directory (every file), the capture options,
NVDA and Edge versions, **the Windows build and architecture**, the provisioning revision, and
`CAPTURE_PROTOCOL_VERSION`.

- **The OS is in the key because a fleet can have more than one image** — an ARM64 and an x64 guest must never blend evidence into one corpus. `provisionRevision` is a further guard: unstamped guests report `"unstamped"` rather than assuming a match.
- **`RUNS_ROOT` / `A11Y_RUNS_ROOT`** move where `runs/` itself resolves to, for a machine where it's mounted elsewhere.
[Full detail on the OS key, the recapture cost, and provisionRevision →](docs/capture-cache-incidents.md#the-os-key-provisionrevision-and-runs_root)

A cache-key version memoised on process identity lied for five days while Edge auto-updated underneath it; memoise on file identity instead. [Incident →](docs/capture-cache-incidents.md#a-cache-key-that-was-memoised-and-lied-for-five-days)

A capture survives a lost socket: `POST /capture` names it with a client-minted `captureId`, `GET /capture/<id>` replays the result — 404 means not retained, never "never ran." [Mechanism →](docs/capture-integrity-plan.md#a-capture-survives-a-lost-socket-name-it-then-ask-for-it-again)
## Readiness: `ready`, not `ok`

`/health` reports `ready` alongside `ok`. **Dispatch on `ready`.** `ok` only ever meant "the HTTP
server is answering", and a worker answered it while NVDA could not start — which is how the pool's
dominant failure hid for a day.

**`ready` is about the ENVIRONMENT, not the screen reader**: Edge is resolvable,
`ForegroundLockTimeout` is 0, and the worker is free. `screenReader` and `warmedUp` are **reported
and deliberately not gated on** — gating on them is what produced the NVDA restart loop that put
modal dialogs on guest desktops. (This paragraph used to claim `ready` meant "NVDA is up and
answering". It never did, and believing it is why the cold-start failure below went unnoticed.)

`ready:false` right after a boot is **normal and self-correcting** — it means "not yet", not
"broken". `worker-ctl.sh up` waits for it, and each pool worker waits for its own before taking work.
Warm-up retries are capped (3 attempts, 30 s apart) because retrying on every poll cycles NVDA, and
cycling NVDA destabilises the speech channel.

A worker that fails three captures in a row is **evicted** from the pool and everything it failed goes
back to the queue; the run summary names it.

The browser version is evidence: Edge 152's spec-aligned `form`→`section` role change flipped announcements repo-wide overnight, caught by `check-signals` before it reached a model. [Incident →](docs/capture-cache-incidents.md#the-browser-version-is-evidence-too-and-edge-152-proved-it-by-renaming-a-container)

`guidepup` is pinned at 0.31.0, and `screenReaderSettings` (e.g. `speech.reportLanguage`) is a cache-key input alongside it. See `docs/adr/0033-guidepup-exact-pin-is-evidence-not-dependency-hygiene.md` for the decision, [the incident](docs/capture-cache-incidents.md#guidepup-is-pinned-at-0310-and-the-version-is-evidence) for detail.

Quick navigation cannot reach whatever element the caret sits on — NVDA searches by start position. The default probe order works only because the read-through leaves the caret at the bottom. [Detail →](docs/nvda-behavior-incidents.md#quick-navigation-can-never-reach-the-element-the-caret-is-on)

NVDA consumes the first Escape after a focus probe switches focus mode on — a dialog-escape probe must press twice. [Detail →](docs/nvda-behavior-incidents.md#nvda-eats-the-first-escape-and-anchortotops-escape-does-not-test-what-you-think)

An object-vs-count comparison bug in `evidence:check` made `formChanges`/`stateChanges` always compare SAME regardless of content, fixed 2026-09-01. Grep for the shape everywhere it recurs. [Detail →](docs/nvda-behavior-incidents.md#evidencecheck-compared-the-interaction-channels-by-count-fixed-2026-09-01)

Activating a control turns focus mode ON and it STICKS, so later quick-nav letters get typed into the page instead of navigating — corrupted 353 captures with every check green. Always restore browse mode (`nvda.press("Escape")`) after activating a control. [Detail →](docs/nvda-behavior-incidents.md#focus-mode-makes-quick-nav-keys-type-themselves-into-the-page)

A fact stated in two or more places, with nothing comparing them, caused five incidents in one day. Delete a copy, derive one from the other, or pin them equal with a test. [Table →](docs/operational-lessons.md#a-fact-stated-twice-and-the-copies-drifted-five-of-these-in-one-day)

2.4.1, 2.4.2 and 2.4.3 are markup-valid-at-every-instant failures a static analyser structurally cannot reach. [Detail →](docs/operational-lessons.md#three-criteria-a-static-analyser-structurally-cannot-reach)

A remedy applied at ONE call site when the behaviour is reachable from several is this repo's most expensive recurring shape. Confirm a fix by its diagnostic MARK, never a green result. [Table →](docs/operational-lessons.md#a-fix-applied-at-one-call-site-when-the-behaviour-reaches-several)

A hand-written field list silently skipped `routeChange` (an object, not an array) in two tools. Derive the list from an exhaustive `Record<Union, ...>` instead. [Incident →](docs/operational-lessons.md#a-list-of-fields-to-check-and-the-one-field-with-a-different-shape)

A comment naming an ambiguity, above code that resolves it by assumption, cost real findings three times. Find the signal that is NOT ambiguous instead. [Table →](docs/operational-lessons.md#a-comment-that-names-an-ambiguity-above-code-that-resolves-it-by-assumption)

A 1-in-125 contaminant slipped past `gate:stability` because `repeat-capture` never compared the two interaction-evidence fields. Both gaps are fixed. [Incident →](docs/operational-lessons.md#two-blind-spots-let-a-1-in-125-contaminant-into-the-corpus)

A fixed `sleep()` expiring early once inverted a finding (a correct page read as "nothing announced"). Wait for the real condition; a remaining `sleep()` must only be a poll interval. [Detail →](docs/nvda-behavior-incidents.md#wait-for-the-condition-never-sleep-a-duration)

A half-open speech socket accepts keystrokes but never speaks, and NVDA looks perfectly healthy. `ensureSpeechChannel` probes and force-reconnects before every capture. [Detail →](docs/nvda-worker-runbook.md#the-speech-channel-is-a-socket-and-a-dead-one-looks-exactly-like-a-healthy-nvda)

A guest whose NVDA is broken can produce ZERO failures — the worker's retry absorbs it. Watch `/health.vitals.recoveries`, not `failures`. [Incident →](docs/nvda-worker-runbook.md#a-guest-whose-nvda-is-broken-looks-perfectly-healthy-watch-recoveries)

A freshly booted worker used to fail its first capture, every time, invisibly retried by the run. The worker now retries once itself first. [Fix →](docs/nvda-worker-runbook.md#a-freshly-booted-worker-used-to-fail-its-first-capture-every-time)

NVDA's mute rate is stochastic and tied to host load, not a fixed lifespan — ~45% survive to the 25-capture recycle. Leave `MAX_CAPTURES_PER_NVDA` at 25. [Measurements →](docs/nvda-worker-runbook.md#what-degrades-is-nvdas-speech-channel-not-the-vm-and-it-fails-on-a-survival-curve)

Recovery is keyed on `FAULT.*` codes, never on `error.message` — a reworded comment would silently break message-based matching in production. [Why →](docs/nvda-worker-runbook.md#recovery-is-keyed-on-fault-codes-never-on-message-text)

429 `a capture is already in progress` on every request means a wedged `busy` flag, not a dead machine — restarting NVDA repeatedly is what wedges it. [Detail →](docs/nvda-worker-runbook.md#the-worker-is-dead-is-usually-a-wedge-not-a-death)
## Housekeeping is automated — do not do it by hand

Anything a human has to remember is something that does not happen. What runs itself now:

- **Worker VMs** — a run starts what it needs and puts each back as it found it. Stopped is the
  correct resting state.
- **The dataset page server** is leased and refcounted — a one-case run once killed a server a 48-capture `evidence:check` was still using, silently, because Edge serves its own error page on a dead port. The last holder out stops it; a crashed holder cannot pin it forever. [Incident →](docs/operational-lessons.md#the-page-server-refcounting-incident)

- **NVDA** — the worker cold-starts it when it has gone and recycles it every 25 captures; a failed
  capture always stops it. Nothing may restart it while a worker is *idle* (see above for why).
- **Edge** — `captureWithNvda`'s `finally` closes it unconditionally, which is what stopped failed
  captures leaking eight orphaned processes onto a 4 GB guest.

**Three env vars govern where the page server lives and where a worker fetches from it, all with
sensible defaults you will not need to touch unless something is already using port 5050 or 8765:**

- `A11Y_PORT` — the port a `nvda-worker` instance itself listens on. Defaults to `8765`. Set it when
  running more than one worker process on the same host (each needs its own port), or when 8765 is
  already taken.
- `DATASET_PAGES_PORT` — the port the local page server (above) listens on and the port a worker is
  told to fetch dataset pages from. Defaults to `5050`. Set it alongside `A11Y_PORT` for the same
  reason: more than one concurrent run on one host, or a port collision.
- `DATASET_BASE_URL` — overrides the computed page-server URL outright. `hostPagesBase()` normally works this out itself; set this when that computation is wrong for your network. [Full detail →](docs/lab-cli.md#dataset_base_url-the-full-computation)

`npm run doctor` reports what it cannot fix: strays on the pages port, a VM running but not
answering, a run left mid-flight. It is read-only by design — it never kills anything — so the one
manual step left is acting on what it tells you.

`npm run lab:pipeline` runs the ordered stages of a capture/lab run and stops at the first failing stage. See [Lab Pipeline](docs/lab-pipeline.md#producing-evidence-is-a-pipeline-and-it-is-one-command) for the catalogue and fleet-consistency guards.

Every other `npm run <name>` script moved to [npm Scripts](docs/npm-scripts.md#every-other-command-and-when-you-would-reach-for-it). `docs/commands.md` covers the disjoint `scripts/*.mjs`-with-no-entry population.

`lab:status`, `lab:log` and `lab:fetch` exist because reading a job's own output once took eleven hand-written pipelines. Write reports to `runs/` and fetch them. [Detail →](docs/lab-cli.md#make-the-failure-bubble-up-or-you-will-dig-for-it-every-time)

Audit first, then fix — reasoning about a mechanism instead of measuring evidence cost a needless recapture twice in one evening. [Examples →](docs/lab-cli.md#the-order-that-would-have-saved-the-evening-audit-first-then-fix)

An unused Ansible extra var and an unrecognised CLI flag are the same defect: silently discarded, so the default runs and reports success. Fixed with declared `params` and `refuseUnknownFlags`. [Detail →](docs/guard-population-boundaries.md#a-flag-nobody-reads-and-an-extra-var-nobody-reads)

A cheap pre-check decides whether to bother running the real one; it is never licence to conclude the real one will pass. [Table →](docs/operational-lessons.md#a-guard-that-already-existed-and-a-weaker-check-substituted-for-it)
## Environment facts
- ESM throughout (`"type": "module"`). `.ts` for the control plane, `.mjs` for the capture worker (it runs under plain Node on the VM) — see `docs/adr/0031-the-worker-ships-plain-mjs-with-no-build-step.md` for why, and what was rejected to get there.
- **The judge is our own trained scorer.** `JUDGE_BACKEND` defaults to `local` — the 27 KB of heads in
  `packages/scorer/models/screenreader-scorer/` over a frozen MiniLM encoder. `codex`, `anthropic` and `openai` remain
  available for comparison and are **never** the default.
  > It defaulted to `codex` until 2026-08-04 — a gate that does not exercise what ships is not a gate. `JUDGE_BACKEND=openai` also works against a local server (Ollama, LM Studio, vLLM). See `packages/cli/README.md` for the consumer-facing config, [the incident](docs/operational-lessons.md#judge_backend-defaulted-to-codex-until-2026-08-04) for why it mattered.

- Don't manually `taskkill nvda.exe` — let Guidepup own NVDA's lifecycle, or the speech-capture channel destabilises. Killing the worker with `Stop-Process` orphans its NVDA (still holding port 6837); the next cold start recovers, but expect to see it.
- The worker keeps NVDA alive between captures (recycled every 25). `A11Y_REUSE_NVDA=0` reverts to a fresh NVDA per capture — the first thing to try if captures drift as a run progresses.
- The guest is provisioned as an **appliance**: Windows Update may install but not reboot, and Edge's background mode, startup boost and auto-updater are off. It used to reboot itself mid-run and leak Edge processes.
Capture timing has TWO populations. On the ~12 s CORPUS capture the largest phase is `windowsActivate`, ~10 s / ~37%, and keeping Edge alive is the only real fix. On a REAL page it is ~0.3 s — one tenth of one percent — and `sweep` leads. [Both measurements →](docs/nvda-worker-runbook.md#capture-timing-and-the-windowsactivate-cost-analysis-from-environment-facts)

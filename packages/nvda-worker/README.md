# `@a11y-witness/nvda-worker`

Drives a **real NVDA screen reader** through real navigation on Windows and returns what it announced.

**Windows only, with an interactive desktop session.** Not a limitation to be worked around: NVDA is a real
Windows application, and guidepup needs a logged-on desktop to drive it. A service, an SSH session or
`utmctl exec` all land in session 0, where NVDA reports its own absence as
`nvda.start failed: NVDA is not supported` — which reads like a broken install and is not one.

```bash
npm install @a11y-witness/nvda-worker
npx a11y-nvda-worker            # serves on :8765
```

## The HTTP contract is the API

Almost nobody should import this package. A capture needs Windows, NVDA and a desktop, so the normal shape is
a small Windows worker serving HTTP to a controller running anywhere:

```
POST /capture      { url, task?, probeForms?, probeFocus?, probeTables? }  → the capture
GET  /health       readiness, vitals, environment, code hash
GET  /diagnostics  Edge profile sizes, orphan processes, NVDA config + logs   (on demand — it walks disks)
```

**Dispatch on `ready`, not on `ok`.** `ok` only ever meant "the HTTP server is answering", and a worker
answered it while NVDA could not start — which is how this pool's dominant failure hid for a day. `ready` is
about the *environment*: Edge is resolvable, `ForegroundLockTimeout` is 0, the worker is free. `ready: false`
right after a boot is normal and self-correcting.

Watch **`vitals.recoveries`**. It counts faults the worker papered over. The worst fault this pool has had
produced *zero* failures — one guest's NVDA went mute on 4 of 4 captures, the retry absorbed every one, and the
only symptom was 122.9 s per capture against a healthy peer's 40.6 s.

## `CAPTURE_PROTOCOL_VERSION` is not the package version

It versions the **wire contract and the meaning of the evidence**, independently of semver, and conflating the
two would be expensive in both directions: a package major must not invalidate cached captures, and a protocol
bump must not wait for a major.

Bump it when a change alters what the evidence *means* — a new field a signal reads, a probe that announces
differently. It is a cache key, so a bump forces a full recapture. That is the point, and it is why a refactor
must not touch it.

## guidepup is pinned exactly, and that is deliberate

`"@guidepup/guidepup": "0.31.0"` — no caret. guidepup parses NVDA's speech before this package ever sees it,
so **its version is evidence**. Upgrading 0.29.2 → 0.31.0 fixed an intermittent OBJECT REPLACEMENT CHARACTER
(U+FFFC) appended to form-field announcements: 1 in 15 captures before, 0 in 15 after. A caret range would let
`npm update` silently change what a capture says.

## What the programmatic surface is for

```js
import { captureWithNvda, CAPTURE_PROTOCOL_VERSION, codeVersion } from "@a11y-witness/nvda-worker";
```

`captureWithNvda(url, options)` is the one-shot path, for a controller that already runs on the Windows box.
`codeVersion()` hashes the worker's own files so a deploy can be verified over the channel the worker serves
on — which matters because push-then-restart can fail silently in both halves, and a check that goes through
the same channel as the action verifies nothing.

Everything else — `capture-core` internals, the speech-socket shim, `browser-session`, the diagnostics payload
shapes — is **not public** and will change without a major.

## One behaviour worth knowing before you read a transcript

NVDA has two modes, and in **focus mode** single letters are typed into the page instead of navigating. A
control activation is a focus change, which switches focus mode on and it *sticks* — so a naive sweep after
activating a form types its own quick-nav keys into whatever has focus. This ran here for 2,122 captures with
every check green, and one site search-as-you-typed them and rendered `1 result for FFffGGggKKkkLLll`, which
was read as a page defect. The sweep now detects the echo and escalates out of focus mode, and reports
`focusModeStuck` rather than "this page has no links" when it cannot recover — because "nothing was found" and
"we could not ask" must never be the same evidence.

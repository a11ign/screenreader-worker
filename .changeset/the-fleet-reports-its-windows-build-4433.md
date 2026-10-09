---
"@a11ign/screenreader-worker": minor
---

`/health`'s `environment` carries `windowsBuild`, `"<build>.<ubr>"` (for example `26100.4652`), read from the registry's `CurrentBuild` and `UBR` under `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion`. `windowsVersion` is `Win32_OperatingSystem.Version` and does not move when a monthly cumulative update lands, so two boxes one update apart read the same; the revision does. It is a NEW field and `windowsVersion` is unchanged, because `windowsVersion` is half of the capture cache's `os` key and appending the revision to it would invalidate every cached capture. `windowsBuild` is not in any key. It is sampled on the same timer tick as `windowsVersion`, never on the request path, and an unreadable or half-read value (a key without `UBR`) reports `"unknown"`. The fleet reports it as `REPORTED_ONLY` first, and it graduates to `MUST_MATCH` once the fleet reads one value (#4405).

# CookieGate

CookieGate is a local-first browser privacy extension for cookie visibility and user-controlled cleanup.

## What it does

- Inspect cookies for the active site and across the whole browser (including partitioned cookies)
- Classify cookies into logins/security, preferences, tracking and unknown, with named tracker sources
- Trusted / Balanced / Strict modes, remembered per site; Clean and Wipe only on an explicit tap
- Preserve login and security cookies by default
- Hide cookie-consent banners (can be switched off in Options)
- Hash previews instead of raw cookie values in every export

## Browsers

Chrome, Edge, Opera, Brave (Manifest V3) and Firefox desktop + Android (Manifest V2, AMO id `cookiegate@local.dev`).

## Layout

```text
src/shared/              popup (ui/), options/, icons/, banner_suppression_runtime_v32.js — identical in every browser
src/platform/chrome/     MV3 manifest + service worker
src/platform/firefox/    MV2 manifest + background script
tests/                   all test suites (run_all.mjs runs them)
tools/build/             build_release.mjs — produces release/CookieGate-v<version>/
release/                 store packages (gitignored); LATEST_RELEASE.txt says which one to upload
```

`src/` is the only source of the shipped extension. The older top-level `background/`, `content/`, `ui/`, `ui-core/`,
`adapters/` folders and `manifest.json` are the v0.1.2 code line and are not used by the build.

## Build and test

Requires Node.js 22 or newer.

```text
npm install                                   # once: jsdom for the banner tests
npm test                                      # every suite against src/
node tools/build/build_release.mjs --check    # validate src only
node tools/build/build_release.mjs            # build release/CookieGate-v<version>/ (refuses to overwrite; --force to rebuild)
```

To release a new version, change the version in `src/platform/chrome/manifest.json`, `src/platform/firefox/manifest.json`,
`src/shared/ui/cg_engine.js` (`VERSION`) and `package.json` — the build fails if they disagree.

## Working remotely

The commands above were run on Linux (Node 22) on 2026-10-15 and need nothing from Windows: `npm test` passes all six
suites and the build produces byte-identical packages on every run. Store uploads and real-browser install checks are manual.

## Privacy posture

CookieGate is local-first. It processes cookie metadata inside the browser extension and does not sell user data, export raw
cookie values, or transfer cookie data to third parties. See [`PRIVACY.md`](./PRIVACY.md).

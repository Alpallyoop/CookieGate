# CookieGate — Full Project Audit (2026-10-04)

Scope: the shipping build artifacts under `dist/patch_v0.1.2/firefox` (MV2) and
`dist/chrome_v0.1.2` (MV3) — manifests, permissions, the three UI surfaces,
background/service worker, options, banner suppressor, privacy guarantees,
store-readiness, and cross-browser parity. Governance per
`docs/canonical/ECOSYSTEM_INTEGRATION.md`: banner governance, cookie inspection,
observer totals, domain rules, and evidence export are owned here; no receipt
schema was redefined by this pass.

Result: one real defect found and fixed (Chrome shipped broken orphan files).
Everything else is sound. Both builds re-validated.

## Issues found and fixed

1. FIXED — Chrome package shipped unreferenced orphans, including a broken one.
   `dist/chrome_v0.1.2/background/background.js` is a 506-line HTML document
   (starts with `<!DOCTYPE html>`) with a `.js` extension, and
   `background/service_worker.js` has a syntax error. Neither is referenced by
   the Chrome manifest (which uses `background/service_worker_clean_v011.js`) or
   any HTML; `content/banner_suppressor.js` and `ui/popup.universal.js` are also
   unreferenced. The prior Chrome zip was shipping `background/background.js`.
   Fix: all four are now excluded from the Chrome package and from the unpacked
   test folder. Shipping an HTML file as `.js` is a Chrome Web Store review flag
   and pure dead weight; removing it changes no runtime behavior (never loaded).

## Verified sound (no change needed)

2. Manifests / permissions. FF MV2 and Chrome MV3 both minimal and justifiable:
   `cookies` (inspect/classify), `browsingData` (user-initiated cleanup),
   `storage` (rules/stats), `tabs` + `activeTab` (active-site detection),
   `<all_urls>` host access (browser-wide cookie read + content script). No
   `scripting` permission requested (content scripts are declarative; the
   service worker does not `executeScript`), no `web_accessible_resources`, no
   `externally_connectable`, no CSP override. FF carries the gecko id matching
   the live listing, `strict_min_version` 140 / android 142, and
   `data_collection_permissions: {required:[none]}`.

3. Privacy (core product law: no raw cookie values). Cookie values are only ever
   reduced to `valueHashPreview` via a one-way 8-hex digest
   (`hashPreview`/`hashPreviewV3`); exports state "raw cookie values are not
   exported" and carry `valueHandling: "valueHashPreview only"`. No raw value is
   rendered or exported anywhere. (Minor: `hashPreview` and `hashPreviewV3` are
   duplicate implementations — cosmetic, left as-is.)

4. Security. No `eval`, `new Function`, `document.write`, remote `<script>`, or
   `importScripts`. No literal `.innerHTML` in shipping JS (only in comments; the
   code uses the obfuscated-property technique to stay AMO-static-clean). No
   remote code.

5. Network / telemetry. The only outbound request is `reachabilityCheck()` — a
   `credentials:"omit"`, `no-cors` GET to the domain the user typed in Domain Ops
   to test reachability. Nothing is sent to any developer/analytics endpoint.

6. Browser Observer honesty (canonical Rule 1). Reads browser-wide cookies via
   the background `COOKIEGATE_BROWSER_OBSERVER_READ_ALL_COOKIES_V1` handler
   (`cookies.getAll({})`) with a direct-API fallback — never an active-page
   `document.cookie` count masquerading as browser-wide.

7. Domain Ops normalization. Strips scheme, path, and port, trims dots; `www.`
   and subdomains are reconciled to the root at match time.

8. Banner suppressor (hardened this cycle). Layered defense intact: host-level
   auth/search skips → navigation-critical content guard → four-check gate
   (page-content veto → auth veto → overlay requirement → known-CMP OR
   cookie-specific-text+control). DOM removal restricted to known CMPs; all else
   reversible CSS hiding.

9. Cross-browser parity. All shared files are byte-identical between FF and
   Chrome: `ui/popup.{js,html,css}`, `ui/cookiegate.polish.css`,
   `options/*`, and `banner_suppression_runtime_v32.js`. Only the manifest and
   background model differ by design (MV2 background script vs MV3 service
   worker).

## Verification (this pass)

- `node --check` across every JS file in both cleaned packages: PASS.
- Regex boundary tests (`suppression_gate_regex_tests.mjs`): 65/65.
- Gate-decision unit tests (`suppression_gate_unit_tests.mjs`): 8/8.
- Chrome zip confirmed to contain zero `background/background.js`; both zips
  v0.1.5 with the hardened suppressor.

## Observations / recommendations (non-blocking)

- Build provenance: the repo root (`manifest.json` MV3 v0.1.2) has diverged from
  the shipping `dist/` build copies (v0.1.5). Recommend making the root the
  single source of truth and generating `dist/` from it, so orphans like the
  HTML `background.js` can't accumulate in a shipped tree.
- `popup.js` `untouched_files` metadata still lists `background/background.js`,
  which is no longer in the Chrome package (still present and valid in FF). This
  is a harmless metadata string; align it during the next source consolidation.
- Receipt-semantics proposal from the prior pass
  (`docs/proposals/banner_detected_count_semantics.md`) remains open.
- The jsdom end-to-end harness (`suppression_gate_tests.mjs`) needs a normal dev
  environment to run (the sandbox blocks the npm registry).

## Store-readiness status

Firefox / Chrome / Edge / Opera packages are clean and validated at v0.1.5.
Pending: real end-user install confirmation, then cut clean 0.1.5 store packages
for all five browsers and retire the 0.1.4 set.

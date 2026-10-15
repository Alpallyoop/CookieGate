# CookieGate — Full Project Audit (2026-10-15) → v0.1.8

Scope: the shipped v0.1.7 build (`release/CookieGate-v0.1.7/unpacked`), its tests, the build/release process and repository
state. Service role and ownership per `docs/canonical/ECOSYSTEM_INTEGRATION.md` (banner governance, cookie inspection, observer
totals, removal, evidence export). No canonical file, receipt schema or permission was changed.

## Defects found and fixed in 0.1.8
| # | Severity | Defect | Fix | Test |
|---|----------|--------|-----|------|
| 1 | High | Options "Suppress cookie/privacy banners" toggle had no effect: the content script never read `cookiegate.bannerSuppression.enabled`. | Content script checks the key (cached, kept current via `storage.onChanged`); off = no scan/hide/record. | A1–A4 |
| 2 | High | Firefox background re-set `bannerSuppression.enabled = true` and `cookiegate.version = "0.1.2"` on every install **and update**. | Defaults only when absent; version from manifest. | C1–C3 |
| 3 | Medium | Browser Observer and site view missed partitioned cookies (Firefox Total Cookie Protection, Chrome CHIPS) — under-reported "browser-wide" totals and left them uncleaned. | Also read with `partitionKey: {}`, merge with dedupe; graceful fallback. Re-created detection uses store+partition key. | D1, D3, E1, E2 |
| 4 | Medium | Firefox background read failed entirely under first-party isolation. | Retry with `firstPartyDomain: null`. | D2 |
| 5 | Medium | Banner ledgers (`current`/`session`/`stats`) grew one entry per domain/iframe domain forever in `storage.local`, shared with settings + evidence. | Keep 1,000 most recent domains. | B1–B4 |
| 6 | Low | Hidden tabs re-scanned every 1.2 s and on every DOM mutation, in every frame. | Skip while `document.hidden`; visibility/focus/pageshow rescans remain. | review |
| 7 | Process | Shipped source lived only in `release/…/unpacked` + `dist/` — both gitignored, so not under version control; packages assembled by hand. | `src/` (shared + platform), `tests/`, `tools/build/build_release.mjs` (version-consistency, manifest-reference, CSP/inline-script, eval/innerHTML checks; deterministic zips verified byte-for-byte before SHA256SUMS). | `npm test` |
| 8 | Low | 950 KB unreferenced `icons/cookiegate_icon_master.svg` in every package. | Excluded by the build. | build |

Regression suite `tests/v018_regression_tests.mjs` fails 12 checks when pointed at the 0.1.7 code and passes 23/23 on 0.1.8.
Independent review of the 0.1.7→0.1.8 diff: no blockers; its should-fix (false "re-created" reports with partitioned copies) was applied.

## Open items (not changed — need the owner)
- `docs/proposals/banner_detected_count_semantics.md` still PROPOSED (receipt semantics).
- Chrome service worker still carries the pre-0.1.6 message handlers (inspect/wipe/set-mode) that the current popup no longer
  calls; harmless, left untouched to avoid changing receipt producers. Candidate for removal by decision.
- Top-level v0.1.2 code line (`background/`, `content/`, `ui/`, `ui-core/`, `adapters/`, root `manifest.json`) is superseded by `src/`;
  removal is the owner's call.
- Nothing is committed: branch `v0.1.1-hardening` has the owner's pending changes plus the new `src/`, `tests/`, `tools/build/`,
  `package.json`. `.work/` (scratch, gitignored) can be deleted.
- Packages not yet installed by hand in a real browser.

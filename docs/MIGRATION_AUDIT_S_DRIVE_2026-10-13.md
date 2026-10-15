# Migration audit — C:\dev\cookiegate → S:\Dev\dev-S-path\cookiegate (2026-10-13)

> **Update (same day):** the project then moved again, intact, to
> **S:\Dev\dev-S-path\Constellation\_DevRoot-Systems\cookiegate** — this is the only working and saving location.
> Verified after that move: 9,390 files present (the 9,367 audited below plus today's additions), release checksums 5/5,
> engine parity 122/122, banner suppression 65/65 and 8/8. Governance doc paths need updating — see
> `docs/proposals/governance_paths_after_relocation.md`. Draft workspace rules written earlier at the dev root are kept
> in `docs/workspace/` (inactive).

Working location from now on: **S:\Dev\dev-S-path\Constellation\_DevRoot-Systems\cookiegate** (C: used read-only, only to recover anything missing).

## Result: complete — safe to continue
- File inventory: **9,367 files / 238.4 MB on both drives**. 0 missing on S, 0 extra on S, 0 size differences.
- Content check (SHA-1): **517 files byte-identical**, including all 218 files the current work depends on
  (`release/CookieGate-v0.1.7`, `dist/v0.1.6_firefox`, `dist/v0.1.6_chrome`, `dist/v0.1.6_tests`,
  `dist/patch_v0.1.2/firefox`, `dist/chrome_v0.1.2`, final unpacked builds, `dist/RELEASE_v0.1.6_final`,
  `dist/icon_options`, `docs/`, root `CLAUDE.md`, `AGENTS.md`, `project.contract.json`, `manifest.json`) plus a random
  sample of 300 others. 0 read errors.
- Everything runs from S: engine parity 122/122, real-popup end-to-end 160/160, banner suppression 65/65 and 8/8.
- No current-work file hard-codes a C: path (tests and docs use relative paths).

## Issues found and resolved
1. **Opera release package had been replaced** by Opera's processed copy (Opera adds `developer: "Scrapneedsanap"`, an Opera
   `update_url`, and re-sorts the manifest; changed 19:31 on 2026-10-12, 9 minutes after the build). Not corruption.
   - Kept as `release/CookieGate-v0.1.7/CookieGate-0.1.7-opera_AS-PUBLISHED-BY-OPERA.zip`.
   - Restored the original `CookieGate-0.1.7-opera.zip` (identical to the Chrome package). `SHA256SUMS.txt` verifies 5/5 again.
2. **Icon generator scripts were lost** (they lived only in the sandbox's temporary folder, which reset when the session moved).
   The icon images were never at risk. The shipped generator is restored as `tools/icon/smooth_icon.py` and verified to
   regenerate the shipped icons pixel-for-pixel at 16–512 px. The unused 8-bit generator was not restored; its output is kept in
   `dist/icon_options/8bit/`.
3. **UI design prototypes lived outside the project** (session output folder on C:). Copied into
   `docs/design/v0.1.6_ui_options/` (options A–D, mockup, real-code preview, suppression harness, icon previews).

## Not verifiable from here
- `../Constellation/...` (service map, registry, agent policy, shared invariants referenced by `CLAUDE.md` and
  `project.contract.json`) is outside the connected folder. If it exists at `S:\Dev\dev-S-path\Constellation`, connect it to
  allow the governance reads `CLAUDE.md` requires.

## Where things are
- Upload-ready release: `release/CookieGate-v0.1.7/` (see `LATEST_RELEASE.txt`).
- Up-to-date source of the shipped build: `release/CookieGate-v0.1.7/unpacked/{chrome,firefox}`.
  Note: `dist/v0.1.6_chrome/ui` and the `icons/` folders in `dist/v0.1.6_*` still hold the previous popup/icon; the release build
  pulls the new UI and icon at packaging time. Consolidating into one source tree is recommended before the next version.
- Tests: `dist/v0.1.6_tests/` and `dist/patch_v0.1.2/suppression_gate_*.mjs`.

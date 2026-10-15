# Hard-coded C:/AppData path scan across the dev root (2026-10-13, read-only)

Scanned before projects were regrouped under `Constellation\`; project names are unchanged.
Live scripts/config only (excluded: node_modules, .git, builds, dist, release, proofs, backups, archives, runtime,
generated, reports). `pie` was only partially scanned (time limit). JSON hits are mostly recorded receipts, logs and
snapshots — historical records that should be left as they are.

**Totals:** 2,003 code/script/config files and 5,061 JSON data files in 61 projects. In code, almost every hit is a
`C:\dev\...` path; about 30 reference `%LOCALAPPDATA%`, `$env:LOCALAPPDATA`, `%APPDATA%` or `C:\Users\...`.

CookieGate status: its live `scripts\` and `tools\` were fixed (resolve paths from their own location). Its 21 remaining
hits are inside `cookiegate_recovery_worktrees\` and `cookiegate_visual_recovery\` (old snapshot copies, left as-is).

| Project | Code/script/config files | JSON data files |
|---|---:|---:|
| pie | 779 | 3179 |
| bountygate | 235 | 256 |
| recognition | 170 | 0 |
| atlas-update | 120 | 114 |
| nfl | 82 | 27 |
| covenant-gate | 61 | 32 |
| assemblelink | 58 | 38 |
| observatory | 40 | 1 |
| privacy-sector | 38 | 23 |
| proteusops | 35 | 1 |
| rooted-live | 34 | 0 |
| dod-witness-kit | 31 | 389 |
| homegate | 31 | 0 |
| core-platform | 26 | 2 |
| index-lens | 26 | 0 |
| clarity | 25 | 1 |
| cookiegate | 21 | 0 |
| shadowprofile | 19 | 59 |
| contract-registry | 15 | 15 |
| infrabound | 13 | 0 |
| echo-transport | 12 | 1 |
| anchormark | 11 | 0 |
| triad | 10 | 461 |
| watchtower | 10 | 21 |
| relaymesh | 10 | 2 |
| legacy-player | 10 | 0 |
| sitegate | 10 | 0 |
| lastsignal | 7 | 59 |
| legacy-doctor | 7 | 2 |
| covenant-courier | 7 | 0 |
| neverlost | 6 | 0 |
| archive-recall | 5 | 1 |
| runledger | 3 | 30 |
| csl | 3 | 11 |
| rebound | 3 | 8 |
| covenantworks | 3 | 0 |
| dsse | 3 | 0 |
| hashcanon | 3 | 0 |
| shutterwall | 2 | 7 |
| lawvm | 2 | 6 |
| haai | 2 | 1 |
| convergence-suite | 2 | 0 |
| packetpuncture | 2 | 0 |
| _workspace | 2 | 0 |
| _cli_standard | 1 | 0 |
| _devenv | 1 | 0 |
| bridgekit | 1 | 0 |
| dodwk-workbench | 1 | 0 |
| formal-spec-layer | 1 | 0 |
| nfl-explorer | 1 | 0 |
| policy-migration-protocol | 1 | 0 |
| themeforge | 1 | 0 |
| veritas-engine | 1 | 0 |
| rie | 0 | 190 |
| cg-ai-model-live-target | 0 | 103 |
| gos-runtime | 0 | 6 |
| contribution-ledger | 0 | 5 |
| global-adapter | 0 | 4 |
| cg-init-demo-project | 0 | 3 |
| Constellation | 0 | 2 |
| arbiter | 0 | 1 |

Notes: `_workspace` and `_devenv` hits are path-checking tools that mention these patterns on purpose.
Constellation's `scripts\push_*.cmd` and `.witty\scope.v1.json` also hard-code `C:\dev\...` (outside this scan's file
filters); they `cd` into and `git push` the old `C:\dev\<project>` folders.

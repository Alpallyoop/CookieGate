# Workspace rules — S:\Dev\dev-S-path (applies to every project below this folder)

This is the dev root. Every project lives in its own folder here (for example `S:\Dev\dev-S-path\cookiegate`).
These rules add to — never replace — each project's own `CLAUDE.md` / `AGENTS.md` and the Constellation ecosystem
policy (`Constellation\ecosystem\AGENT_POLICY.md`, `SHARED_INVARIANTS.md`, `SERVICE_MAP.md`, `registry\services.json`).
If a project's rules are stricter, follow the project.

## Where things go
1. **Work only inside the project's own folder** on S:. Source, builds, release packages, reports, logs, test output,
   generated assets, design files and backups all live inside `S:\Dev\dev-S-path\<project>\`.
2. **Scratch / temporary files go in `<project>\.scratch\`** (create it if missing; it is disposable). Do not use the
   system temp folder, `%TEMP%`, `%LOCALAPPDATA%`, `%APPDATA%`, the user profile, or an agent's own output folder for anything
   that must be kept. If a tool can only write to a temp location, copy anything worth keeping back into the project.
3. **Deliverables are saved in the project** (e.g. `release\`, `docs\`, `dist\`) and shared from there.
4. **Shared, non-project items** (workspace tooling, tool caches) go in `S:\Dev\dev-S-path\_workspace\`.
5. **C:\ is read-only.** The old location `C:\dev\...` may only be read to recover something missing on S:. Never write,
   build, or save there. Copy recovered files into the project on S: and record what was recovered.
6. **AppData / Program Files / the registry** are touched only when an installed application genuinely requires it
   (for example a browser profile or an app's own settings), never as a convenience location.

## Paths in code and config
- Never hard-code a drive or absolute path (`C:\dev\...`, `S:\Dev\...`, `C:\Users\...`). Resolve paths relative to the
  script or project: PowerShell `$PSScriptRoot`, Node `__dirname`/`import.meta.url`, Python `Path(__file__)`.
- Machine paths, usernames and timestamps must not leak into canonical or reproducible outputs
  (Constellation shared invariants).
- Projects are identified by folder name relative to this dev root (as in the Constellation registry), not by drive.

## Before changing a project
- Read that project's `CLAUDE.md`/`AGENTS.md` and its canonical documents first, as they require.
- Moving, deleting, relocating or cleaning across the dev root is a governed operation in Constellation; make bounded,
  reversible changes (rename or copy to a backup rather than delete) and report what changed.

Setup kit and guide: `_workspace\README.md`.

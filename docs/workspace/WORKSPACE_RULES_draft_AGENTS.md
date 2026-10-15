# Agent workspace rules — S:\Dev\dev-S-path

Same rules as `CLAUDE.md` in this folder (kept identical in substance for agents that read `AGENTS.md`).

- This is the dev root. Each project lives in `S:\Dev\dev-S-path\<project>\`; all of its files stay there.
- Temporary files: `<project>\.scratch\` — not `%TEMP%`, `%LOCALAPPDATA%`, `%APPDATA%`, the user profile, or an agent output folder.
- Shared workspace tooling and tool caches: `S:\Dev\dev-S-path\_workspace\`.
- `C:\` is read-only: read `C:\dev\...` only to recover missing files, then copy them into the project on S:.
- AppData / Program Files / registry only when an installed application truly requires it.
- Never hard-code drive or absolute paths; resolve relative to the script/project (`$PSScriptRoot`, `__dirname`, `Path(__file__)`).
- Project `CLAUDE.md`/`AGENTS.md` and Constellation policy (`Constellation\ecosystem\AGENT_POLICY.md`, `SHARED_INVARIANTS.md`)
  still apply; follow the stricter rule.
- Guide and setup kit: `_workspace\README.md`.

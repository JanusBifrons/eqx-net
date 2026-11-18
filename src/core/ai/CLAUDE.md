# CLAUDE.md — src/core/ai (AI pilots)

Zone rules: [src/core/CLAUDE.md](../CLAUDE.md). Where each kind of change goes: [god-file-extension-points](../../../docs/architecture/god-file-extension-points.md#core-ai-hostiledronebehaviourts-srccoreaiclaudemd).

- `HostileDroneBehaviour.ts` is at its size cap (`scripts/audit-god-files.mjs`). New behaviour goes in a new file under `ai/`, never in that file.
- Tuning numbers for hostile pilots (ranges, gains, tick counts, pilot params) and their pure-data types go in `hostileDroneTuning.ts`, never inline in `HostileDroneBehaviour.ts`. It holds values only, no logic.
- A new combat move is an `IManoeuvre` in `tactics/` (`manoeuvre.ts`), picked by the utility layer (`tactics/utility.ts`). Never a new branch in `tickCombat`.

# Lessons Learned — EQX Peri

Chronological log of non-obvious findings discovered while implementing the phased plan. Append-only; each entry dated, referencing phase and commit.

Use this file for findings that would cost a future Claude (or human) time to re-derive: gotchas, benchmark surprises, failure modes the blueprint didn't anticipate. Do **not** use this file for general architecture — that belongs in CLAUDE.md.

Entry format:

```
## YYYY-MM-DD — <Phase N> — <short title>
Commit: <sha or PR>
What we hit, how we diagnosed it, how we resolved it, and what downstream phases need to know.
```

---

## 2026-04-18 — Phase 0 — Foundation seeded
Commit: initial scaffolding.

Phase 1 is expected to surface the first real gameplay findings (Rapier WASM async init timing, Colyseus schema types under strict TS, pixi-viewport v8 with React's mount lifecycle).

## 2026-04-18 — Phase 0 — better-sqlite3 not installed at Phase 0
Commit: initial scaffolding.

`better-sqlite3` 11.x has no prebuilt binaries for Node 24, and `node-gyp` requires Python to build from source, which this Windows dev machine lacks. Rather than introduce a Python dependency or downgrade Node, we deferred installing `better-sqlite3` until Phase 7 (when it is actually used). The Technology Stack Matrix in the root CLAUDE.md still lists it as the server zone's persistence layer — only the `package.json` dependency was removed.

**Action at Phase 7**: evaluate whether to pin to `better-sqlite3@^12` (which ships Node 24 prebuilts), downgrade the project's Node engine, or switch to another SQLite binding. Decide at that boundary, not now.

## 2026-04-18 — Phase 0 — ESLint `no-undef` disabled globally
Commit: initial scaffolding.

TypeScript already checks for undefined identifiers with full type information, including `process`, `__dirname`, `document`, etc. under the right `lib`/`types` settings. ESLint's `no-undef` was double-checking the same thing and fighting against Node-context config files (`vite.config.ts`, `vitest.config.ts`). Disabled project-wide; TS is the authority. If a genuine "undefined identifier" slips through, `tsc -b` will catch it.

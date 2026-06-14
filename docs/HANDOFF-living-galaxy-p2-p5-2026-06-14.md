# HANDOFF — Living Galaxy P2 (director scaling) + P5 (landing-flow merge)

**Date:** 2026-06-14
**Branch to work on:** `feat/living-galaxy-p2-p5` (cut from `main` @ `a381b2c` — the PR #76 merge).
**Authoritative scope doc:** [`docs/architecture/living-galaxy.md`](architecture/living-galaxy.md) — Workstream **D** (→ Phase 2) and Workstream **C** (→ Phase 5), plus the "Phased roadmap" section. Read those two workstreams in full before starting; this handover is the *delta* + the gotchas, not a replacement.

---

## Where we are

Living Galaxy **P1 + P3 + P4 are MERGED** to `main` (PR #76, merge commit `a381b2c`):

- **P1** — galaxy grown 7 → **21 sectors** (a home `core` + 3 chokepoint-gated frontier regions: Verdant Reach / Crimson Expanse / Azure Deep), **generated** by `scripts/generate-galaxy.ts` and baked into `src/core/galaxy/galaxy.ts`.
- **P3** — `GET /galaxy/snapshot` live endpoint (director-aggregated, cached on the control tick, null-guarded).
- **P4** — living map render: faction-tinted contiguous territories, hover-shrink, feature glyphs, live counts, **bold faction-coloured outer-territory outline**; centre-to-centre connection lines removed.

**P2 (director scaling)** and **P5 (landing-flow merge)** were deliberately de-selected from PR #76 by the user and are the remaining work. They are **independent of each other** — do them in either order, or in parallel commits. P2 is a server change gated by the netgate; P5 is a client change gated by E2E.

### Topology facts P1 established (both phases depend on these)

- **Entry (drone-warp-in) sectors are now baked:** `greenfall`, `ashfront`, `abyssal-gate` — one per frontier region. `ENTRY_SECTOR_KEYS` in `galaxy.ts`; read via `getEntrySectors()` / `isEntrySector()` (signatures unchanged).
- **`sol-prime` is no longer a 6-way hub** — its neighbours are `vega-reach`, `lyra-fringe`, `cygnus-arm`.
- **Never hand-edit the `GALAXY_SECTORS` / `GALAXY_FACTIONS` / `ENTRY_SECTOR_KEYS` literals.** Edit the spec in `scripts/generate-galaxy.ts` and re-run `pnpm tsx scripts/generate-galaxy.ts > src/core/galaxy/galaxy.ts`. The generator validates every structural invariant at bake time; `galaxy.test.ts` re-locks them.

---

## Phase 2 — Director / roaming-group scaling (server; **netgate-gated**)

**Goal:** scale ambient drone presence proportionally to the bigger galaxy without exploding the tick budget. (Design: `living-galaxy.md` → Workstream D.)

**The lever (one constant):**
- `src/server/livingworld/director/SquadPool.ts:26` → `LIVING_WORLD_SQUAD_COUNT = 3` → bump to **~7** (tune 7–8). `SQUAD_SIZE = 8` stays. `LIVING_WORLD_BOT_COUNT` (`LivingWorldDirector.ts:63`) derives from these → 24 → **~56 bots**.
- The wave / roam / dispatch machinery is **size-invariant** (BFS over the graph) — only the count moves. Squads will home spread across the three entry sectors at boot.

**What to verify / touch:**
- `src/server/livingworld/population.ts` — confirm apportion + entry-pick handle more squads across more sectors (it's size-invariant; **add/extend a test** that proves it at the new count).
- `SquadPool.test.ts` / `WaveDirector.test.ts` already parametrise off `LIVING_WORLD_SQUAD_COUNT` — they should follow the bump automatically; eyeball them.
- The integration specs in `tests/integration/sectorRoom/livingWorld*.test.ts` boot their *own* small sector sets + bot counts (e.g. `greenfall`/`emerald-span`), so they are independent of the global constant — but re-run them.

**Gates (from the roadmap):**
1. **Bench the idle-galaxy server tick at the new bot count.** Capture `tick_budget` (via `POST /diag/capture`) for an idle 56-bot / 21-room galaxy; confirm each room stays well under the 16.67 ms budget. The design's cost math predicts ample headroom (≈2.3× current 24 bots, spread across independent room ticks) — **confirm it, don't assume it**.
2. **`pnpm e2e:netgate` baseline-green** — the director touches the swarm broadcast, so root-CLAUDE invariant #8 applies. ⚠️ **The netgate is a CI-only gate — do NOT run it locally** (user standing instruction). Validate it by pushing and reading the CI `netgate` / `netgate-run` job results, not by running it on the dev box.
3. Living-world unit + integration tests green; `pnpm dev:server` 8 s boot smoke prints 21 `galaxy room created` lines, clean start.

**Risk:** idle-galaxy CPU at 56 bots across 21 rooms is the thing the bench must confirm before merge. If a room exceeds budget, TiDi will engage — that's the safety valve, but the bench is to ensure steady-state idle never gets there.

---

## Phase 5 — Landing-flow merge (client; **E2E-gated**)

**Goal:** show the living galaxy map **front-and-centre on page load** as the first screen; clicking a sector routes to login (logged out) or ship-select (logged in), collapsing today's standalone "Join the fight!" `MetaLandingScreen` into the map. (Design: `living-galaxy.md` → Workstream C.)

**The lever (initial phase):**
- `src/client/state/store.ts:158` → `phase: 'meta'` → change initial phase to **`galaxy-map`**. The map (GameSurface idle + `GalaxyMapLayer` selector + `GalaxyPickerChrome`) already renders with no Colyseus room (today's idle branch), so first paint shows the live map.

**Auth-gate on PICK, not on entry** (`App.tsx` / `PhaseRouter.tsx`):
- `handleSelectorPick(sectorKey)`: if `!user` → stash the picked sector, `setPhase('auth')`; on `onAuthSuccess` → return to `galaxy-map` and auto-open the ship picker for the stashed sector. If `user` → open `ShipPickerModal` as today.
- Fold `MetaLandingScreen`'s useful bits (server-health banner, live player count) into a light HUD/banner over the map. **Keep the `MetaLandingScreen` component** (don't delete) but take it out of the default flow.

**Preserve (regression-critical):** `AppHeader` (login/profile/settings), renderer idle-boot, `GalaxyPickerChrome` roster/picker, limbo handling, the `?room=` / `?galaxy=` deep-link skip-to-`game` escape hatches, and the DEV `__eqxGalaxyPick` hook.

**Gates / test impact:**
- **`tests/e2e/layout-slots.spec.ts`** — has meta-landing-visibility / "Join the fight!" assertions that WILL break with the phase change; update them alongside. (Note: this exact spec flaked once in PR #76's CI on a corrupted-ZIP artifact — unrelated to its assertions, but it's the spec P5 must edit.)
- **`tests/e2e/boot.spec.ts`** — first-screen heading assertion changes.
- Any auth-flow spec; the phase-machine note in `src/client/CLAUDE.md` ("initial phase is `meta`").
- **New E2E** (the gate): map-on-load renders; logged-out pick → login → returns and auto-opens ship picker; logged-in pick → ship picker; deep-links (`?galaxy=`, `?room=`) still skip straight to `game`.
- **No raw ids in any new UI** — owner/sector readouts resolve to display names (user standing instruction; see the P4 owner-overlay precedent).

---

## Suggested first steps for the next session

1. Confirm you're on `feat/living-galaxy-p2-p5` @ `a381b2c` (or rebase on latest `main`).
2. Pick a phase (they're independent). **P2 is the smaller, lower-risk one** (one constant + a bench + a netgate CI check) — good warm-up. **P5 is the bigger UX change** (phase machine + auth-gate-on-pick + several spec rewrites).
3. Inner loop per change: `pnpm typecheck && pnpm lint && pnpm test`, then the targeted E2E / integration for the phase. Commit each phase as its own green milestone (root-CLAUDE commit cadence).
4. **Confirm the phase works with the user before moving to the next** (user standing instruction).
5. Push and let **CI be the source of truth** — and **verify `git rev-parse origin/<branch>` actually advanced after pushing** (in PR #76 a prior session *believed* it had pushed but origin was stale, so every CI run ran on un-fixed code — don't repeat that).

Each phase ships with its CLAUDE.md / `docs/` updates per the repo's phase-gate ritual, and a test that would have caught the regression (root invariant #9).

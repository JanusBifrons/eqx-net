# Handoff — Real loading screen + dispose-audit + sector-pick responsiveness (2026-05-30 EOD)

## TL;DR

Session ended on `feat/pixi-heap-bisect` with a **planned, hostile-reviewed, user-approved** 7-commit roadmap to fix the death-respawn cascade. Plan file lives at `docs/plans/real-loading-screen-rippling-hellman.md`. **No implementation code yet** — picks up tomorrow.

## What this session produced

### Diagnosis (data-driven)

User's smoke capture `diag/captures/2026-05-30T20-40-44Z-7cm12w/` reproduced the wb1al4 cascade **locally** on `feat/pixi-heap-bisect` HEAD:

| Metric | Smoke value | wb1al4 baseline |
|---|---:|---:|
| Damage events / sec | 3.5 | 3.4 (same) |
| Heap peak (120-150 s) | 76.6 MB | ~65 MB mean |
| RAF Hz cratered | 90 → 33 Hz | 90 → 58 Hz |
| Stutters in 30 s window | 284 | (similar) |
| Cascade trigger time | ~120 s | ~120 s (same) |

Critical reframe (user's own): **not a retained leak — phone is overwhelmed by allocation pressure, GC falls behind a threshold cascade.** Confirmed by loaf data showing 50-110 ms frames where JS scripts only account for 18-30 ms, gap = GC pauses.

**The cascade trigger is a death + respawn**, NOT a transit. At t=100.5s the user clicked `galaxy_sector_click {mode: 'spawn'}` (only the death/respawn flow uses spawn mode). The cascade fired ~20 s after the respawn.

### Three user-confirmed bugs identified

1. **Load curtain is purely cosmetic.** `WarpFilterChain.ts:144 setLoadCurtain()` only tweens alpha. Behind it: physics runs, HUD updates, input flows, **drones can kill the player through the curtain.** User reported personally experiencing this.
2. **Death/respawn is completely untracked.** Zero `logEvent('died'|'respawn'|...)` calls in the client. Future smoke captures will continue reconstructing death from indirect breadcrumbs.
3. **Dispose audit is incomplete.** `ColyseusGameClient.dispose()` clears 14 fields, misses 20+ surfaces (ghostManager, hudDispatcher, _damageFlashFrames, _scheduledDamageSpawns, mirror.ships, mirror.liveBeams, 8+ other mirror Maps/Sets, bus subscriptions).

### Bonus finding (sector-pick lag)

User asked why selecting a sector to spawn feels ~1 s sluggish. Traced to:
- `PICKER_OPEN_DELAY_MS = 200 ms` (`GalaxyOverviewScreen.tsx:29`) — commit `41117cfc` 2026-05-12, **load-bearing** touch-bleed fix. Do NOT touch.
- MUI `<Dialog>` `Grow` transition ~225 ms — **unjustified polish**, safe to remove (commit 7 in the plan).

## What's in the plan

**7 commits, each independently revertible**:

1. `feat(state)` — loading-state foundation + kill-switch `?loading=cosmetic` (no behaviour change yet)
2. `feat(server)` — spawn invulnerability grace (`DEFAULT_GRACE_TICKS = 300`, testMode default `0`)
3. `feat(diag)` — full death/respawn/loading lifecycle events
4. `feat(client)` — the pause boundary (RAF early-return + input gates + audio suspend + damage-event queue)
5. `feat(client)` — HUD components hidden during loading (`useShouldRenderHud()` gate on 10 components)
6. `fix(client)` — complete dispose audit + audio ownership + GameSurface cleanup ordering
7. `perf(ui)` — drop MUI Dialog animation on ShipPickerModal (~225 ms saving)

**Hostile review applied** — 6 release blockers + 5 data-integrity must-fixes incorporated:
- Pixi ticker NOT paused (would freeze warp curtain animation) — early-return skips game work only
- `Howler.ctx.close()` removed (irreversible global state) — uses `Howl.unload()` instead
- Server grace = 300 ticks (5 s) to MATCH curtain duration (eliminates the 4 s window where player was vulnerable)
- Damage events queue (not drop) during curtain, drain on lift
- `unloadComplete` has exactly ONE ownership site (WarpScreen's useEffect on `useGameReady()`)
- RAF re-arm mandatory on early-return path
- `setGameClient(null)` BEFORE `dispose()`
- Dispose audit test uses runtime reflection on `mirror` properties (catches new fields automatically)
- Bus subscription tracking + unsub in dispose
- HyperspaceOverlay carve-out (renders during transit even when loading)

## Repo state (commit + ready to start)

**Branch**: `feat/pixi-heap-bisect`
**HEAD**: `ab4713b` (mobile-emu V8 heap constraints addition — landed earlier in session)
**Status**: clean
**Working tree**: clean (no uncommitted changes after this handoff is added)

Today's session also shipped (UNRELATED to this plan, in case it's relevant):
- `082b27b` WarpScreen RAF self-terminate + sx hoist
- `ed747bb` SectorInfoPanel sx hoist
- `c048881` ShieldHullBar sx hoist
- `7ebce35` Damage-number per-target accumulator
- `28748fa` Damage-number heap-delta lock
- `b27df0a` Pixi Text free-list pool
- `6324a56` tickPhysics + Reconciler input-literal pool
- `f64fb94` GhostManager render-state pool
- `62ca6fb` joystickToInput pool
- `db45fd6` tickPhysics sentinel input-send pool
- `7c9f55a` mobile-emu heap-snapshot-diff spec + evidence
- `978ce3f` 3-min retention evidence (desktop)
- `ab4713b` V8 heap constraints in mobile-emu

These are all alloc-pressure reductions — they helped (heap recovered post-cascade in user's smoke where wb1al4 didn't) but didn't prevent the cascade trigger. **The respawn loading-screen fix is what closes the loop.**

## Where to start tomorrow

1. **Read** `docs/plans/real-loading-screen-rippling-hellman.md` end-to-end. The "Hostile review — issues incorporated" section near the top calls out the deltas from the initial draft.
2. **Start with Commit 1** (state foundation + kill-switch). No behaviour change yet — pure additions + kill-switch so you can verify the URL escape hatch works independently before Commit 4 wires gates.
3. **Commit 2 (server grace) can ship in parallel** with Commits 1-7 — even partial rollout fixes "drones kill me during loading" if 2 lands and 4 doesn't.
4. After each commit: `pnpm typecheck && pnpm lint && pnpm test --reporter=dot` should be green.
5. After Commit 6 (the dispose-audit landing): do a fresh smoke capture, compare against `diag/captures/2026-05-30T20-40-44Z-7cm12w/`. Pass criteria spelled out in the plan's "On-device smoke verification" section.

## Key files to be aware of

| File | Why it matters |
|---|---|
| `docs/plans/real-loading-screen-rippling-hellman.md` | **THE PLAN** — full details, file-by-file changes, test plan, rollback paths |
| `diag/captures/2026-05-30T20-40-44Z-7cm12w/` | Baseline capture — every metric the smoke verification compares against |
| `src/client/state/store.ts` | Where Commit 1 adds the new selectors + flags |
| `src/client/components/WarpScreen.tsx` | **Single ownership site** for `setUnloadComplete(true)` per the plan |
| `src/client/app/gameRafLoop.ts` | The pause boundary (Commit 4) |
| `src/client/net/ColyseusClient.ts` | dispose audit target (Commit 6) |
| `src/server/rooms/DamageRouter.ts` | Server grace gate (Commit 2) |

## Risks I'm leaving on the table

- **`graceUntilServerTick` wire field is decorative** for the initial commit set. A HUD chip showing "INVULNERABLE FOR N TICKS" is a follow-up if user feedback requests it.
- **Living World hunter bots do NOT receive grace** (different spawn path). PvB balance complaint route: director-level fix.
- **Progress bar may visibly stall at 80%** on fast LAN (5 s minimum-display floor is the last 20 %). Mitigated by animated `…` ellipsis in status text below the bar. Acceptable per plan trade-off.

## Cleanup before leaving the session

- ✓ Plan saved to `docs/plans/real-loading-screen-rippling-hellman.md`
- ✓ This handoff written to `docs/HANDOFF-real-loading-screen-2026-05-30.md`
- ⏳ Will kill dev servers (ports 2567 + 5173) so they don't stale overnight

Tomorrow: start with `git status` to confirm clean tree, then `pnpm dev:server:nowatch` + `pnpm dev:client` to boot fresh.

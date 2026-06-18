# Handoff — drone flocking: VISUAL verification still open (2026-06-18)

## TL;DR
The flocking rework **merged to `main` (PR #110)** with all CI green (typecheck, lint, unit, integration, e2e-smoke, **netgate PASS**). But the thing the user actually asked for — *seeing* a tight roaming herd — is **NOT visually verified**. My screenshots were unreadable (drones are 2px specks at the zoom that fits the herd), and the user's verdict was "I can't even see the ships… I don't think it's working." Treat the herd as **UNCONFIRMED in-game** until a clear visual (or on-device smoke) proves it.

## What shipped (PR #110, on main @ `d297418`)
Follow-up to #109. Three changes, all **server-only** (drones are snapshot-interpolated → no wire/client change):
1. **Removed the follower BOOST** (#109's full player-boost impulse overshot and flung the herd apart). Followers now move only at the calm `ai.thrust` cruise; `addCohesion` got an **arrival ramp** (pull fades to 0 near `FLOCK_FOLLOW_DISTANCE` = "slow down once close"); `resolveFlock` caps thrustScale at 1.
2. **Leader waits/throttles** — `setFlockLeaderCourse` hook → brain `_flockLeaderCruise` throttles the leader to `LEADER_CRUISE_THROTTLE` (0.55); `flockStep` holds the leader at its own pose when the squad is spread beyond `FLOCK_GATHER_RADIUS` (500).
3. **Spawn-clustering** — NEW `squadEdgePose(squadKey, sectorKey, botKey)` (`src/server/livingworld/population.ts`): every member of a squad shares one anchor bearing (deterministic hash) so the squad warps in as a ~±300u cluster. Wired into BOTH spawn paths: `respawnStep` (`LivingWorldDirector`) and the roam-hop `HunterBotWarpController.arrive` (via injected `squadKeyOf`).

Files: `src/core/ai/flocking.ts`, `HostileDroneBehaviour.ts`, `contracts/IAiBehaviour.ts`, `src/server/livingworld/{LivingWorldDirector,LivingWorldRoom,population}.ts`, `director/HunterBotWarpController.ts`, `rooms/SectorRoom.ts` + tests + both CLAUDE.md.

## What IS proven (logic)
- **Integration trace** (`tests/integration/sectorRoom/livingWorldFormation.test.ts`, real room + real physics, no roam churn): clustered spawn `gap0 = 449` → flocking tightens max-follower-gap to **~127–130 and holds** (the separation-floor equilibrium). Pre-cluster the same trace started at `gap0 = 9066` (sector diameter) and crawled in at ~80 u/s — that was the root cause of the loose live herd: `sectorEdgePose` gave each bot an independent random edge bearing.
- Unit locks: `flocking.test.ts` (arrival ramp), `HostileDroneBehaviour.flock.test.ts` (no boost / cruise-capped, leader throttle + hold), `population.test.ts` (`squadEdgePose` clusters ≪ scatter).

## What is NOT proven (the open item)
- **No clear in-game visual of a tight moving herd.** The integration test measures `getBotPose` (SAB) in a *controlled* room. It does NOT prove the LIVE galaxy looks right, and does NOT prove the herd is *moving as a group* convincingly vs. a tight-but-near-stationary blob (leader is "gathered" almost always since settled gap ~130 ≪ `FLOCK_GATHER_RADIUS` 500, so it cruises at 0.55× — need to confirm followers at 1.0× don't overshoot past it; there is **no overshoot brake**, thrust is along facing only).
- Live confounders the test doesn't exercise: roam re-warps every 45s (squad is `warping`, not `idle` → `flockStep` doesn't run mid-roam), multiple squads sharing an entry sector, staggered hop arrivals.

## NEXT SESSION — make it visible, then judge honestly
The screenshot approach failed because the observer is pinned at origin while the herd roams ~2000u out. **Don't squint at the game render again.** Build a **god's-eye plot of the actual drone poses**:

1. **Get per-drone world (x,y) cleanly.** Was mid-investigation (workflow `flock-verify-investigate`, stopped). Two viable sources:
   - **Client runtime** via a headless probe `page.evaluate` reading the decoded swarm render mirror (use `?worker=0` for main-thread render). Need to confirm the exact reachable expression (window global / mirror object) — that was Agent A's task; re-run it or grep `src/client/render` + `state` for a swarm-pose array exposed on `window`.
   - **Server** — add a temporary NODE_ENV-gated `GET /dev/squad-poses` returning `[{squadId, sectorKey, state, leaderId, members:[{id,x,y}]}]` (the director has `getBotPose` + `squadPool`). Cleanest, unambiguous, and a genuinely useful dev endpoint.
2. **Render a clear diagram** (SVG/PNG): big dots, leader highlighted, a scale bar/grid, one panel every few seconds — show the herd tighten + translate. This removes the "can't see the ships" problem entirely.
3. **Judge honestly against that plot** (and/or the user's on-device smoke). If it's a tight *moving* herd → done. If it's loose / stationary / overshooting → there's a real bug (candidates below).

### If it IS still broken — likely suspects (from the planned audit, not yet completed)
- Squad spends most of its life mid-roam (`warping`) so `flockStep` rarely runs → followers fall back to `tickPatrol` (orbit origin) = the loose ring. Check how much wall-clock a squad is actually `idle`.
- `resolveEntityInto` not populated on the LIVE `AiWorldView` (only the test) → followers can't see the leader → `tickPatrol` fallback. Verify `src/server/rooms/aiTickRunner.ts` wires it on the real server tick.
- Followers (1.0× cruise) overshoot the 0.55× leader (no brake) → oscillation.

## Repo state
- `main` @ `4e17670` (merge #110). Working tree clean of tracked changes; branch `fix/flocking-boost-overshoot` merged.
- Dev servers (2567/5173) **stopped**, ports clear.
- Diagnostic artifacts (untracked): `diag/_formation-probe2.mjs`, `diag/_herd-*.png`, `diag/_pr-body-flocking-overshoot.md`, `diag/_server-boot*.log`.
- The stopped workflow's partial transcript: `…/subagents/workflows/wf_dc3b027c-545`.

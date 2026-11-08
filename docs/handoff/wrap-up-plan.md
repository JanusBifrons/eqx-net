# Wrap-up plan (full copy for the handoff)

Copied from `~/.claude/plans/prancy-squishing-donut.md` on the first machine, so the plan travels with the branch. Delete this file in the PR that finishes the plan.

## Status at handoff (2026-11-08)

| Step | State |
|---|---|
| W0 housekeeping | Done. `docs/SHELF.md` has the dropped and parked items (#347). PR #346 merged; #330 closed as superseded. Worktree removal and the memory-note refresh were done on the first machine. |
| W1a warp picker | First version merged (#348). The user chose to **keep both views: list on touch, map on desktop**. That work is on this branch; finish it from `docs/handoff/warp-picker-keep-both.md`. |
| W1b transit pads | Done (#349): rare, 6 of 21 systems. |
| W1c solar sectors on by default | Not started. |
| W1d solar-sectors architecture doc | Not started. Picker and pads are written up in `docs/features/warp-to.md`. |
| W2 – W7 | Not started. |

Also merged: #350, the CLAUDE.md rule to clean up memory before every recording.

---


## Context

The user asked for a stock-take of every plan, PR and thread, then one plan that finishes what's left. My status notes were stale (I listed Phase 4 as "not started" when #331–#337 had landed from the other machine), so this list is verified against `main` @ `c705f747` by reading code, commits and docs, not memory.

Already done and **not** in this plan:
- GPU-lit art: #344–#346; on by default; levels in Settings.
- Shields on collisions: #342.
- Warp spool-up: #343.
- Art budget and travel fixes: #338–#341.
- Phase 4 core: #331–#337. Limits, pockets, convoys in open space, warp-to mechanic, client and visuals, travel state, the system sky.
- Capitals Phases 0–3: #312–#327.
- Perf scenes and the phone-proxy A/B.
- Incursion robots shown as enemies, and harvesters raiding haulers.
- Blueprint trades.
- Account identity: radar PR 3a.
- The edge radar: radar PR 2.

User decisions (2026-11-08):
- **Pocket pads:** keep them, but make them rarer. "Instant and safe for starters"; warp-to doesn't replace them.
- **Radar:** drop the settings database and the config window (close that plan).
- **Ship munitions:** not now.
- **Old robot-merge-clusters worktree changes:** discard.

Standing rules apply throughout:
- One PR per piece, cut from a fresh `origin/main`, re-synced before push, auto-merge on.
- Netgate on live-loop changes.
- Failing test first for bugs.
- Hostile review before any clip is shown.
- Foreground runs only (8 GB laptop).
- Phone-class checks use `--device phone-proxy`, never the user's phone.
- Don't stop between steps unless there's a real decision.

## W0. Housekeeping (first, small)
1. **PR #346** (GPU lighting presets): it auto-merges.
2. **PR #330** (bake only needed art; free sealed atlas canvases): stale since 2026-11-07. Re-sync with `main`, which now has GPU-lit art, data pages and `PageBudget`. Resolve, run the inner loop, measure tab memory again, merge. Close it if GPU-lit art made it moot, with the reason in the PR.
3. **Worktrees:**
   - Remove `.claude/worktrees/living-world-factions`; the user approved discarding it, and #251 is merged.
   - Remove `eqx-net-pwa`: clean, and #93 is merged.
   - Use the junction-safe removal from memory.
4. **Record every dropped or parked item in the repo, with its reasoning (user: "I want to revisit potentially").** Each gets a `docs/SHELF.md` entry: what it was, which plan it came from, why it was dropped or parked and by whom, what exists today, and what reviving it would take.
   - Radar settings saved per account/ship (database) and the radar config window (plan `sparkling-wondering-rose`, PR 3b/4): dropped; the edge radar works.
   - Ship weapons drawing munitions (economy v2): not now.
   - The blind perf-threshold rating test (perf plan P3b): parked; it needs the user to rate clips.
   - Pocket pads: kept but rarer. Record the rule and its reason in the solar-sectors doc.
5. **Notes:**
   - Refresh the stale memory notes: capitals, art direction, living world, procedural bases, ship scale. Collapse each finished plan to one line.
   - Mark the plan files `sparkling-wondering-rose`, `eager-sauteeing-curry` and `iridescent-seeking-rainbow` as closed in their headers.
   - `docs/architecture/off-screen-indicators.md`: set its status to "Wave 2 shipped (edge radar); settings persistence and config window dropped (user, 2026-11-08)".

## W1. Finish solar-system sectors (Phase 4)
**1a. Warp destination picker (two prototypes, the user picks).**
- **Data** (pure, unit-tested): `src/client/components/warpDestinations.ts`, built on `sectorSites`, `warpDropPoint` and `nearestSite` (`src/core/galaxy/sectorSites.ts`).
  - Each pocket gets a name: Home, "Gate to <sector name>" (via `GalaxyRegistry` sector names), Asteroid belt, the base's name, Battle zone.
  - Distance in km from the local ship, and "you're here".
  - Near pockets are listed one by one; far ones are grouped.
- **Prototype A, list:** EVE-style, with distances.
- **Prototype B, system map:** a mini SVG map of the ±200 km system with pocket icons and the ship. Tap a pocket, then Warp.
- **Shared behaviour:**
  - Both open from a **Warp** action in `SpeedDialMenu` (touch and desktop), shown only in a solar sector.
  - Both call `ColyseusClient.requestWarp(dropX, dropY)`.
  - While spooling, the action becomes Cancel (`cancelWarp`).
  - Switch: `?warpui=list|map`.
- **Tests:**
  - a component test (picking calls `requestWarp` with the drop point);
  - an E2E in a solar test room: open, pick, spool starts, arrive at the rim.
- **Film:** both prototypes, by extending the `warp-to` showcase shot, hostile-reviewed. **Decision point:** the user picks one and the other is deleted.

**1b. Pocket pads, rare** (user: instant and safe, not on every pocket).
- NPC teleporter pads paired across the sector at a seeded few pockets: home and at most one other per sector, some sectors with none. Rarity is a constant.
- Reuse `TeleporterSubsystem` and pairing (`pairTeleporters`).
- Pads are neutral, free to use, and safe. The pocket's existing protection applies; no toll.
- Shown in the picker as "Pad to X (instant)".
- **Tests:**
  - an integration test: a pad pair links two pockets, a ride moves the pilot, and placement is deterministic per seed;
  - a test that the rarity holds across all sectors.

**1c. Solar sectors on by default.**
- `sectorBounds.ts`: default on, with `EQX_SOLAR_SECTORS=0` and `?solar=0` as the way out. Existing bases stay in the home pocket (already the design).
- **Before flipping:**
  - fix any test that assumed ±5,000 u;
  - run the netgate;
  - run a **10-minute soak** on the populated galaxy (server tick, snapshot bytes, interest-grid cost), re-running the round-3 measurement at ±200k;
  - run perf scenes A/B, desktop and phone proxy.

**1d. Docs:** `docs/architecture/solar-system-sectors.md` (pockets, pads, warp, travel state, limits) and a showcase shot or registry entry.

## W2. Capitals
- **2a. Flagship fleets (Phase 5).**
  - `FlagshipDirector` in the Living World keeps `FLEET_COUNT` (default 1) fleets alive galaxy-wide. A fleet is one capital leader plus escort squads (`SquadPool` / `SquadLayout.memberKind`), with `flagship-` ids (add to `isDirectorBotId`), persisted like the robot director.
  - It roams pocket to pocket. The capital spools slowly and its escorts warp with it.
  - It is never load-shed (`shedImmune`).
  - It shows as "capital sighted" in `SectorLiveState`; the snapshot is the source of truth (#16).
  - Its tier comes from region power.
  - Test: an integration test where a fleet spawns at a pocket with escorts flocked round it, is never shed, and survives a persistence round trip.
- **2b. Hull style per ship.**
  - Each capital instance gets style A, B or C, seeded from its entity id (the user kept all three for variety).
  - The style travels in the bake job and key, the art, and the collider/geometry lookup (`capitalConfig.ts` becomes a per-instance resolver).
  - The `?capStyle=` override stays for testing.
  - Test: two battleships render different styles.
- **2c. Capitals warping:** film a capital spooling and warping (the user was curious). Fix what the film shows.
- **2d. Phase 6:**
  - `docs/features/capital-ships.md`;
  - delete the `rnd/capital-ships` branch;
  - add a capital-fleet and capital-duel perf scene to the catalogue (P5 baseline).

## W3. Art and lighting leftovers
- **Per-sector sun.** Wire `ArtService.setSector(sectorKey)` from `PixiRenderer.setSector`. Nothing calls it today, so every sector uses the default sun.
  - GPU-lit art re-lights instantly with no re-bake.
  - The Baked level re-bakes per sun, which the cache key already handles.
  - Test: two sectors give different light directions on the same hull.
- **Lit-art heap +33%** (phone proxy): find the source, likely per-mesh `UniformGroup`/arrays and data pages. Then trim: share uniform tables, free CPU copies of uploaded data pages. Re-measure with the phone proxy.
- **Classic-look asteroid tint bug:**
  - write a failing test first;
  - find the bug and fix it.
- **"A6 optional fx":** decide from code whether anything is still missing. Build the remainder or close it with a note in `art-direction.md`.

## W4. Perf lock-down leftovers
- **Budget files.** `perf/budgets.desktop.ts` and `perf/budgets.phone-proxy.ts`, each limit citing the ledger that set it (like `structureBudgets.ts`). The runner fails a scene that exceeds an absolute ceiling, alongside the relative A/B.
- **`perf/select-scenes.mjs`** maps changed paths to scenes and fails closed. CLAUDE.md gets the rule.
- **Prune (P4):**
  - delete the print-only netgate scenarios `structures-load` and `scrap-load`;
  - apply part 2 of `docs/refactors/test-coverage-audit.md`: delete superseded jitter/drift specs and investigations, merge the smoothness family, list each deletion with what replaces it.
- **The blind threshold test (P3b)** needs the user to rate clips, and the user doesn't want manual tests. Park it in `docs/SHELF.md` with that reason.

## W5. Test health
Fix the three smoke flakes with real causes, not retries:
- `join-art-ready`;
- `persistence-kill`;
- `combat-lifecycle` (plus its `test.fixme` respawn case).

For each, reproduce, find the cause, and lock it. The CI quarantine list stays honest.

## W6. Living world
Robot harvesters mine asteroids (`robot-territory.md` lists it as "Next"). The harvester AI targets resource asteroids and banks ore into the nexus hold, reusing `LootCollector.npc` and the miner yield rules. Integration test.

## W7. Showcase wrap
- **Shots for the open `SHOWCASE_PENDING` entries where a staged room exists or is cheap:**
  - `gpu-lit-ships`: the existing capital and defence shots, with lighting now default;
  - solar sectors and warp picker (W1);
  - flagship fleet (W2);
  - `research-lab` and `blueprints` where a room exists.
  - The rest keep a reason.
- **Then compose the reel and run `--catalogue` once.**
- **Publish:** a single "what's new" artifact page with the clips, each hostile-reviewed.

## Order
W0 → W1 (1a until the pick; 1b and the 1c prep meanwhile) → W2 → W3 → W4 → W5 → W6 → W7.

The only stop is the W1a picker choice. Other user-visible looks (flagship fleet, per-ship styles) go out as reviewed clips without waiting.

## Verification
- Every PR:
  - typecheck, lint, unit, `test:authored-scale`;
  - integration where it touches the server;
  - targeted E2E;
  - CI with auto-merge;
  - the netgate on live-loop PRs (W1c, W2a, W2b if it touches colliders).
- W1c: the 10-minute soak numbers and the perf scenes A/B (desktop and phone proxy), recorded in the PR and ledgers.
- Looks: showcase clips, hostile-reviewed, shown to the user.
- Docs: each feature page updated or added; `showcaseCoverage.test.ts` green; CLAUDE.md updated where a rule changes.

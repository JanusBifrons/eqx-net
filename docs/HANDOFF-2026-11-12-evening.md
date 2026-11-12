# Handoff — 2026-11-12 evening (capitals, gunnery, destruction)

Picks up from [HANDOFF-2026-11-11.md](HANDOFF-2026-11-11.md). This session ran the **film → hostile review → send** loop on the capital clips. Most of what it found were real game bugs, each fixed with a failing test first. It also built capital destruction (dynamic ship splitting) through to a filmed break-up.

## Owner decisions made today (all recorded in the docs they affect)

- **Clips:** every reviewed clip goes to the owner straight away. A clip that passes review is presented as finished; one that fails is shared as WIP with its caveats (CLAUDE.md, hostile reviewer rule).
- **Recording coordination:** the recording lock is retired. Before a take or a heavy run, check for at least 4 GB free RAM.
- **Capitals UI:**
  - a green RTS move marker at the helm course;
  - small ships get a constant-size icon at far zoom;
  - zoom-in is capped so your whole hull fits on screen;
  - capitals don't shadow each other;
  - a small lock pin on a capital that has you locked.
- **Capitals combat:**
  - capitals collide solidly;
  - NPCs keep shooting a ship parked by Spectate;
  - an attacking NPC stays hostile (its own lock and hits refresh it);
  - capital bows get detail.
- **Destruction:** see `docs/architecture/capital-destruction.md` §6, and the damage model parked in `docs/SHELF.md`.
  - The last hit's impact sets the split.
  - Chunk count is random, driven by hull size, the killing blow and the damage rate.
  - A clean snap at the impact is a chance.
  - Wrecks stay forever and block shots.
  - Player capitals break up too.
  - Pieces don't re-break for now.
  - Small ships fracture later.
  - Catastrophic area damage comes later.

## Merged

#474–#480, #482–#484, #486–#488, #490–#497, #499–#501, #503, #514, #516, #519. Trains: #483, #501.

## Open, auto-merge on — land these first tomorrow

| PR | What | Notes |
|---|---|---|
| #512 | Train c: #502 collision, #504 ghost copy, #505 grid hairlines, #506 wrecks S2a, #507 bow detail, #508 turrets shot, #509 shield hugs hull, #510 capital closes range, #511 spectator turret angles, CLAUDE.md clip rule | Integration failure fixed (stale spawn assumption); re-running CI. When it lands, its member PRs close as merged. |
| #481 / #485 | Released quarantined specs; CI uploads failure traces | 7 specs still quarantined (CI-only timeouts). |
| #489 | Far-zoom icons: one leftover merge-resolution commit | Its code already shipped in #501. |
| #498 | Spawn clearance | |
| #513 → #518 → #521 | Destruction S2b (wire v5 + client), S3 (art, glow, burst), break-follows-hit + drift | Stacked; each includes the previous. Wrecks stay behind `capitalWrecks` / `EQX_CAPITAL_WRECKS=1`. |
| #515 | Showcase caption sits above the spectator build bar | |
| #517 | An attacking NPC stays hostile | |
| #520, #522, #523, #526 | Camera: `'local'` follows the parked hull; no phantom own ship after Spectate (#522 includes #504); `frame all` counts culled structures; the line-up pull-back finishes (smoothMs 3500) | |
| `feat/wreck-money-shot` (helper was finishing its final test run at handoff) | Fracture v6 (cracks fan from the hit), pieces fly apart 3× faster and spin, glow cools in ~6 s, pieces keep hull art (GPU-lit), real explosion at the kill point, a wreck descriptor no longer dropped by snapshot coalescing, the explosion where it broke | If no PR exists, the commits are on the LOCAL branch `feat/wreck-money-shot` in worktree `.claude/worktrees/agent-a45a8d23f8a5f37ca`: push it and open a PR against main (it includes #521). |
| `showcase/capital-breakup` | The break-up shot (32 s, held on the cruiser) | |

If a PR goes `DIRTY`, it is almost always `docs/LESSONS.md` or a `CLAUDE.md` with two appended entries; keep both. Use a merge train when several are queued (see trains #501/#512).

## Clips sent today (all WIP except where noted)

- capital-pilot (wheel zoom) and guns-up-close (real fight; the hull overlap is now fixed).
- bystander, turrets (take 6: gunnery correct), line-up (two takes).
- Destruction:
  - fracture renders;
  - wreck-art stills;
  - break-up v1–v5. v4/v5 is the "money shot": the hull shatters at the hit and the pieces start to drift.

Latest files are in the session scratchpad, not the repo.

## Next (in order)

1. Land the open PRs (above). Then set `capitalWrecks` on in normal play only after the owner has seen the polished money shot.
2. **Money shot:** v3 was filmed at 22:40 with all the polish (`film/breakup-art` in worktree `train-1112c`, `EQX_CAPITAL_WRECKS=1`) and sent to the owner. It has not had a hostile review yet. Review it first, check the pieces don't fly too fast and far, then decide on switching wrecks on in play.
3. **Line-up re-film:** after #520/#522/#523, check it opens on the fighter model and pulls back to the fleet and base.
4. **Destruction next slices:**
   - S2c: persist wrecks with the sector and remove the temporary 768-piece cap (the owner wants wrecks forever);
   - S4: delayed secondary breaks and the catastrophic flash.
5. **Broadside:** re-stage it; four of the five capitals are out of range in that room.
6. The 7 CI-only quarantined specs (traces now upload, #485).

## Known flaky tests

- `teleporter.test.ts`: port collision on a busy box.
- `missileLifecycle` "detonates on an asteroid": fails about 1 in 3.
- The capital-wreck E2E `wreckBreaks === 1` check: 2 of 4.
- `asteroidShape.test.ts.snap` shows as modified after test runs on this box. That is CRLF noise, not a real change: revert it, never commit it.

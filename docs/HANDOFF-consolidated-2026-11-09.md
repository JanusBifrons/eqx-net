# Outstanding work: consolidated handoff (2026-11-09)

This is every task still left in EQX Peri after the 2026-11-06 → 11-08 weekend, when agents on two machines merged about 70 PRs and each left its own handoff.
It supersedes those scattered handoffs (listed in the Sources appendix): start here, and follow a source link only for detail.
It lives in git (`docs/HANDOFF-consolidated-2026-11-09.md`), so it works on both machines. Tick or delete items in the PR that finishes them.

**How to read an item:** `**Name.** what to do. *Status:* … *Who:* … *Source:* …`. Status is *not started*, *partial* or *blocked on user*. *Who* is Claude (can do it alone) or user (needs a person, a device or a decision). Sources are PR numbers, repo paths (links are relative to `docs/`), branch blob URLs for files that exist only on a branch, or local plan files (this machine only; not in git).

**Scope.** The ~25 older `docs/HANDOFF-*.md` files (May–June) are out of scope: they predate the weekend, and the wrap-up plan already swept them. Parked and dropped ideas live in [`docs/SHELF.md`][SHELF] (friendly fire, whole-game time dilation, radar settings, ship munitions, blind perf test, atlas CPU-copy release); they are not repeated here.

**Landed (2026-11-09).** Every weekend PR is on `main`: #376, #377, #359, #356, #360, #371, #379 (warp picker), then #369, #375, #362, #365 and #367 together through merge train #380. No weekend PR is left open. Their follow-ups are listed below. **No filming, re-recording or clip review was done during landing** (user, 2026-11-09): every such item is in the Showcase section and can start now.

**Found while landing** (details in "Tests & CI" and "Perf"): the advisory feature-spec failures on the PRs were specs already broken or flaky on plain `main`, not PR regressions; two real merge interactions were fixed in the train (the ship catalogue version lock, 23 → 24, and #365's turret test, which assumed instant traverse).

**Decisions (user, 2026-11-09 evening).**
- **Lock-to-fire is the rule, not an experiment.** Nobody fires without a completed lock: players, NPC drones, NPC capitals and defence/structure turrets alike. Fire Control's opt-in (`?ui=d`, the `fireControl` join flag, `LockSubsystem.hasLocked()` passing untracked players) goes away. See "Fire Control & HUD".
- **HUD D is the only HUD.** Legacy and variants A–C are retired with the `?ui=` switch.
- **No PvP flag.** The failsafe (slower locks on friendlies and players, logged as a hostile act) already guards against locking a friendly by accident.
- **Housekeeping deletions approved** (branches marked "Delete", the stash, untracked scratch).

---

## Waiting on the user

- **Other-machine check: done 2026-11-09.** The desktop has no commits missing from the remote and no stash; its dirty worktrees held only regenerated screenshots and snapshots. The open items in its local plans `machine-independent-perf` and `synchronous-hippo` are already in this list. *Status:* done. *Source:* [tidy-wiggling-frost]
- **Answered 2026-11-09: "does the warp map only fly right?"** No. The pick in the clip was the Vega Reach gate, which is due east of Home in Sol Prime (gates sit on the bearing to their neighbour, here (170000, 0)). `warpTo.test.ts` "flies any direction: a south-west pocket, not just east" proves warps go any way. *Status:* done (told the user 2026-11-09). *Source:* [warp-picker-handoff], [tidy-wiggling-frost]
- **Which advisory CI jobs become required.** `gc-tests`, `perf-counts` (after #356), `e2e-feature-affected`, and possibly the weekly full `@feature` run. Suggestion: after a week green. *Status:* blocked on user. *Who:* user. *Source:* [DV-handoff] step 5, #351, #310, [audit]
- **GPU lighting on a real phone.** Plug the phone into the laptop (USB debugging, unlocked, long screen timeout, Chrome command-line flag on) so Claude can run `pnpm perf:phone` baked vs `medium`, then vs `low`, 8 reps with `--noise-check`. This is also the phone lane's first live test (#354 was built without a device). *Status:* blocked on user. *Who:* user + Claude. *Source:* [gpu-lit], [DV-handoff] step 2, #354
- **Phone default lighting level.** After the phone and phone-proxy runs: the agreed rule is RED at Medium → phones default to Low or baked; RED at Low → baked; GREEN → defaults stand. Confirm the call. *Status:* blocked on runs. *Who:* user. *Source:* [gpu-lit] "Decision rule", #346
- **Older phone runs never done.** 2× B ship scale (#295), `?fx=new` vs classic turrets (#292), per-sector sun "not yet checked on device" (#368), Fire Control lock tuning "untested on a real device". Most fold into the phone session above; say which still matter. *Status:* blocked on user. *Who:* user. *Source:* #292, #295, #368, [fc-handoff]
- **Fire Control design calls.** Decided 2026-11-09: D replaces the legacy HUD, locking is universal, and there is no PvP flag (the failsafe covers friendlies). Still open, for later: whether pilot skills feed `PilotLockMods`. *Status:* blocked on user (pilot skills only). *Who:* user. *Source:* [fc-handoff] "Later", "Missing feedback"
- **Coastal design values.** Accept or replace: quad AA traverse 0.45 rad/s (copied from the ship AA; real Bofors quad rate unconfirmed); German casemate arcs 120° (design value; only the US 16" 145° arc is sourced); bastion crowding fix (seat by buy priority, or add bastions). *Status:* blocked on user. *Who:* user (Claude can propose). *Source:* #365
- **Stale branches and local leftovers.** Approved 2026-11-09. On the desktop the untracked scratch is gone (the one capture `living-world.md` cites is kept) and `stash@{0}` no longer exists. Removing worktrees and branches still needs the session doing it to be granted permission. *Status:* partial. *Who:* user. *Source:* [tidy-wiggling-frost]
- **Network-feel roadmap: continue or retire?** Stages 5b, 6 and 7 of the May roadmap were never done (see Netcode). Decide whether they still matter after the weekend's netcode work. *Status:* blocked on user. *Who:* user. *Source:* [nf-roadmap]

## Netcode & prediction

- **Melee residual corrections.** Browser melee still shows 14 / 6 / 2 corrections per flight (was 20 / 17). Likely source: client drone bodies coast at their last server velocity between anchors (no damping, no AI thrust). Investigate after #360 lands. *Status:* not started. *Who:* Claude. *Source:* [DV-handoff] "From #360", #360
- **Scrap angular velocity.** Scrap now takes the server's spin; a June A/B found that harmful under the old per-frame re-pose. Check spin on its own. *Status:* not started. *Who:* Claude. *Source:* [DV-handoff]
- **Gate melee on correction count.** `melee-drone-corrections.spec.ts` prints corrections and gates only peak drift; gate the count once it is stable. *Status:* not started. *Who:* Claude. *Source:* [DV-handoff], #360
- **Catch-up after the curtain lifts.** The first frames after the loading curtain can still catch up a few ticks (~0.1 s) while the server activates the ship. *Status:* not started. *Who:* Claude. *Source:* #302
- **`lock_track` is trusted / lock messages unlimited.** See Fire Control; both are server-trust netcode gaps. *Status:* done (PR 1b+1c: `lock_track` carries the line bearing and is checked with the shared `lockLineScore`; the four lock messages share a 3-per-tick cap). *Who:* Claude. *Source:* [fc-handoff]
- **Network-feel roadmap Stage 5b.** Write `cadence-fairness.spec.ts` + bench before any multi-cadence snapshot design; the 30 Hz close tier is shelved until then. *Status:* not started (May plan; check relevance). *Who:* Claude. *Source:* [nf-roadmap] Stage 5
- **Network-feel roadmap Stage 6 (packet loss and reordering).** Input seq + drop counter, stale-snapshot guard, post-gap spring, `request_keyframe`, `packet-loss.spec.ts`, `network-resilience.md`. *Status:* not started (May plan). *Who:* Claude. *Source:* [nf-roadmap] Stage 6
- **Network-feel roadmap Stage 7 (wire format).** Keyframe/delta round-trip properties, angle wrap, wire-version hard-fail, `wire-format.md`. Partly overtaken (the swarm wire is already v4). *Status:* not started (May plan). *Who:* Claude. *Source:* [nf-roadmap] Stage 7
- **Server-perf follow-ons from the roadmap.** TiDi trigger misses spike-driven slowdowns (fires on `avgMs` only); SAB-read cost at 3,200+ entities; mobile tab-pause resilience (3.1 s rAF gap). *Status:* not started (May; check relevance). *Who:* Claude. *Source:* [nf-roadmap] "Follow-on workstreams"

## Tests & CI

- **Feature specs broken on plain `main` (found while landing).** They fail the same way on `main` locally and on CI, so they are rot, not PR regressions. `laser-falloff-probe:77` (first test times out on a cold join, 30 s cap; `:98` also fails on CI), `structure-build-placement:48/:82/:152`, `structure-grid-web:41` and `speed-dial:91/:177` (the build / dial flow hits its 30 s cap; on `main` locally `:48` stalls waiting for the placement banner to hide after Confirm), `laser-smoothness:71`, `configurable-arrival:84` (mobile out-of-bounds X stays 200000 instead of clamping to 5000; also fails on main at 071ad183). Fix each with a failing run first, or quarantine it with a reason. *Status:* not started. *Who:* Claude. *Source:* #360, #365, #380 CI
- **`scrap-collision-stress` is flaky on CI.** Plain `main` on CI (throwaway #378) read 123.7 u and 101 u peak drift, then 24.9 u on retry (limit 30). Locally it reads 0.8–27.8 u. CI flights run ~3× more snapshots (110–140 v ~45), so the spike comes from slow hosts. Find the spike mechanism; don’t widen the margin. *Status:* not started. *Who:* Claude. *Source:* #360, #378
- **`fire-control-lock:105` fails on CI** (hands-off: LOCK in the info box runs to the end; CANCEL stops it). Likely the same bug as "Info-box LOCK didn’t start a lock" in Fire Control; start from this failing spec. *Status:* not started. *Who:* Claude. *Source:* #380 CI
- **Finish the quarantined specs.** Run each 6×, remove from `QUARANTINE` when green: `missile-frigate-homing` (:414, :562), `machined-art` (nebula :162; its speed-effects case also timed out on the laptop, #299), `fence-hits`, `fx-turrets` (:63), plus `gate-fly-through` (fixed in #359, not yet verified 6/6). Then run the full feature tier once. *Status:* partial. *Who:* Claude. *Source:* [DV-handoff], #359, `tests/e2e/featureTriggers.mjs`, [audit], #299
- **Triage 4 flaky specs.** `sector-alpha:424` (playerId reload), `fx-weapons:65`, `galaxy-drawer-rich:48`, `sync-health:17` (now in `tests/perf/`). They may share the curtain race where they join with their own `page.goto`. *Status:* not started. *Who:* Claude. *Source:* [DV-handoff], #363
- **Interceptor beam active-frames question.** With the curtain wait it went 4 → 16 of 40 coast frames (test wants > 20): pulsed by cooldown, energy-limited, or a sampling artefact? Re-check once #359 lands (its fix changed the test). *Status:* partial. *Who:* Claude. *Source:* [audit] table
- **`waitForInPlay` for the remaining specs.** Apply the helper wherever a spec still joins with its own `page.goto` and acts before the curtain lifts. *Status:* partial. *Who:* Claude. *Source:* [audit], [DV-report] F4
- **Warp picker E2E.** The plan asked for an E2E in a solar test room: open the picker, pick, spool starts, arrive at the rim. Only component and integration tests exist. *Status:* not started. *Who:* Claude. *Source:* [prancy] W1a
- **E2E renders on software WebGL.** `playwright.config.ts` has no GPU flags (SwiftShader on the desktop). Check the laptop and CI renderer strings; treat E2E timings as non-GPU. *Status:* not started. *Who:* Claude. *Source:* [DV-report] F1, [hostile-review] 10
- **Decide which feature specs earn per-PR CI.** Today only smoke gates; feature specs run advisory. Pairs with the CI-required decision above. *Status:* blocked on user. *Who:* user + Claude. *Source:* [audit] "Next decisions"
- **`TickBudgetTelemetry` "no hitch" asserts are wall-clock.** Convert to counts like #356 did for the others. *Status:* done (the test now drives `performance.now()` from a scripted clock: injected durations, exact event counts, no busy-wait). *Who:* Claude. *Source:* [DV-handoff] "From #356"
- **`NETGATE_PORT_OFFSET` to main.** So parallel sessions can each run a netgate. *Status:* not started. *Who:* Claude. *Source:* [DV-handoff]

## Perf

- **`perf-counts` sees art uploads mid-scene since #365/#367.** On #380 `fleet-fight/baked` uploaded 20.9 M texels (5 pages) and `fleet-fight/high` 8.4 M against the one-page floor; on #365 alone, `wide-view/high` uploaded 12.6 M in one of two runs. New art (coastal guns, weapon-group art) likely bakes after the curtain. Bake it before the curtain, or prove it is noise, before making `perf-counts` required. *Status:* not started. *Who:* Claude. *Source:* #365, #380 CI
- **Capital scenes have no work budget.** `capital-fleet` / `capital-duel` (#371) gate rx and busyness only. One local run on 2026-11-09: capital-fleet bodies 20.7, AI 19.7, swarm records 3.3, bytes 115 per tick; capital-duel 1.95 / 0.95 / 0.06 / 3. Calibrate (4 runs + CI) and add `work` budgets. *Status:* not started. *Who:* Claude. *Source:* #371
- **Count-budget gaps.** Close-up fleet-fight draw-call budget is loose (175) from battle randomness: seed the battle or gate on p50. Display-object budgets are wide for the same reason. `teleport-raid` and `idle` have no client count budgets; `idle` has no server budget. *Status:* not started. *Who:* Claude. *Source:* [DV-handoff] "From #356"
- **Per-frame / per-tick allocation counter.** No harness counts allocations per frame or tick yet (needs heap profiling). *Status:* not started. *Who:* Claude. *Source:* [DV-handoff], [`docs/architecture/perf-scenes.md`][perf-scenes]
- **Physics-worker thread CPU.** Node 22 lacks `threadCpuUsage`; event-loop utilisation is the proxy. Revisit on a newer Node. *Status:* not started. *Who:* Claude. *Source:* [DV-handoff]
- **WS7.2: art upload budget.** Upload new art in small pieces instead of whole atlas pages: a 769 ms stall on `sector-travel` was seen even on an RTX 5070 Ti; 0.25–0.6 s stalls on integrated graphics. #356's upload counter is the hook. *Status:* not started. *Who:* Claude. *Source:* [DV-handoff], [DV-report] Phase 5, #337, [`docs/architecture/travel-state.md`][travel-state] "Known gap"
- **GPU lighting on weak hardware (phone proxy).** Run the 8-rep laptop phone-proxy A/B, baked vs `medium` and vs `low`; record verdicts in `gpu-lit-ships.md`. The real-phone half is in "Waiting on the user". *Status:* not started. *Who:* Claude. *Source:* [gpu-lit], [DV-handoff] step 2, [hostile-review] 6
- **Fleet-fight hitches with GPU lighting.** The extra hitches come from the per-mesh path, not any lighting feature; the next lever is batching lit meshes (plan R3). Do it only if the runs above go RED. *Status:* not started. *Who:* Claude. *Source:* #344, #345, [gpu-lit] "Status", [gpu-lit-memory]
- **Server tick p99 rose with GPU lighting.** 2.03 → 3.62 ms (p = 0.16) on the desktop, unexplained; re-run on a quiet host. *Status:* not started. *Who:* Claude. *Source:* [DV-report] H4, [hostile-review] 7
- **Measure GPU shader cost.** Current metrics see CPU and main-thread time only. Add GPU timer queries (`EXT_disjoint_timer_query`) or run headed `worker=0` uncapped. *Status:* not started. *Who:* Claude. *Source:* [hostile-review] 3, [DV-report] H4
- **Lit-mesh garbage (only if GC pauses show on a phone).** GPU lighting allocates ~18 % more garbage via Pixi's per-mesh uniform updates; update a mesh's uniforms only when its lighting changed. *Status:* not started (conditional). *Who:* Claude. *Source:* [gpu-lit] "Memory", #372
- **Coastal fire-control cost.** #365 now gathers every hostile in reach per defence structure each 100 ms turret tick (citadels have more guns). Run perf scenes and check against #356's count budgets; add the verdict table. *Status:* not started. *Who:* Claude. *Source:* #365, [tidy-wiggling-frost]
- **Fire Control cost.** Bench `NpcLockSubsystem.step` (O(drones × fire-control pilots) at 10 Hz) and the player-capital turret cost before Fire Control leaves the experiment. *Status:* not started. *Who:* Claude. *Source:* [fc-handoff]
- **Perf scene selection.** `perf/select-scenes.mjs` (changed paths → scenes, fail closed) and absolute per-device ceilings (`perf/budgets.*.ts`) were planned in W4 and never built; #356's count budgets may cover the need. Decide, then build or drop. *Status:* not started. *Who:* Claude. *Source:* [prancy] W4
- **Capital gun-effect hitches (300–800 ms) on some takes.** Seen on the laptop after the naval effects grew; the desktop didn't reproduce them (likely host load). Re-check with the `capital-fleet` scene once #371 lands. *Status:* not started. *Who:* Claude. *Source:* #321, [DV-report] H6/H11
- **Desktop verification leftovers.** Not run: the bigger-muzzle A/B (H12), the swarm-tidi 4,000-entity case, scripted gameplay sessions (Phase 3). Low priority. *Status:* not started. *Who:* Claude. *Source:* [DV-report] "Not done"

## Art & lighting

- **gpu-lit-ships review findings (game side).** Muzzle-flash light lasts 1–2 frames (add a short decay after the sprite ends); 5" turret flashes cast no light on the deck; a thin dark rod sticks out behind each 5" turret; far shell streaks run nearly vertical while their barrels point south-east. *Status:* not started. *Who:* Claude. *Source:* #376, [gpu-lit] "Showcase review findings"
- **Gunhouse recoils with its barrels.** One sprite, so the casing kicks too (same in baked art). *Status:* not started. *Who:* Claude. *Source:* [gpu-lit] "Status and next steps"
- **Big-surface recipe.** Very large hulls (Crossguard, El test ships) and the huge pads (large teleporter, alien gate) come out flat; the verification reel called the gate/pads "flat placeholder blocks". *Status:* not started. *Who:* Claude. *Source:* [art-direction] "Known gaps", [soft-leaping-truffle], [DV-report] Phase 5
- **Ship shadows on decks.** Ships don't shade the structures they fly over. *Status:* not started. *Who:* Claude. *Source:* [art-direction], [soft-leaping-truffle]
- **Per-sector nebula bake.** The nebula is not baked per sector. *Status:* not started. *Who:* Claude. *Source:* [art-direction], [soft-leaping-truffle]
- **WS7.3: damage numbers smear.** Overlapping damage numbers render as dark/red blocks inside fireballs (new-effects ~5.4 s, missiles, robots). Repro on the `damage-number-probe` page first, then fix the z-order or blend. *Status:* not started. *Who:* Claude. *Source:* [DV-handoff], [DV-report] Phase 5
- **Super-gun shells hard to see.** The 40.6 cm and 80 cm shells read as specks at long zoom; give `naval_xxl` / `naval_siege` a bigger tracer or trail. *Status:* not started. *Who:* Claude. *Source:* #365
- **Hostile drones draw in their own colours.** Next to red lock rings they often read green; hostility should read at a glance (Fire Control HUD, may apply more widely). *Status:* not started. *Who:* Claude. *Source:* [fc-handoff]

## Capitals & coastal defences

- **Coastal plan tracker is stale.** Stages 6 (docs) and 7 (showcase) are on `main` (#380) but unticked in `plans/coastal-defences.md`; tick them, leaving "filmed review + artifact" for after landing. *Status:* not started. *Who:* Claude. *Source:* [coastal-plan]
- **Reconcile the ship research doc.** Its formulas (√weight, rate^0.75) don't match the shipped naval numbers; the coastal doc follows the shipped curves. *Status:* not started. *Who:* Claude. *Source:* #365, [coastal-plan] decision log
- **Reload and arc UI.** Casemate arcs and reload timers aren't shown in the inspector or the placement ghost. *Status:* not started. *Who:* Claude. *Source:* #365
- **Bastion crowding.** Small light guns are sometimes dropped when big batteries take the bastion slots (a citadel losing its second AA). Fix once the user picks the approach (see "Waiting on the user"). *Status:* blocked on user. *Who:* Claude. *Source:* #365
- **Quad AA traverse and German casemate arcs.** Research or accept the design values (see "Waiting on the user"). *Status:* blocked on user. *Who:* Claude. *Source:* #365
- **NPC capitals' turret fire isn't lock-gated.** Gate `AiFireResolver.fireMount` with the NPC lock (today only the hull-aimed `resolve` path is). Fire Control only. *Status:* not started. *Who:* Claude. *Source:* [fc-handoff]
- **Player capital turrets split across locks.** Generalise `WeaponMountTicker.tickCapitalMounts` so each turret picks among its group's up to 3 locks, not just the first (`aimKeyFor`). *Status:* not started. *Who:* Claude. *Source:* [fc-handoff]
- **Capital fly-by-wire layer.** Vertical speed telegraph (Astern / Stop / ⅓ / ⅔ / Full) replacing the HelmPanel buttons; course line + destination marker; heading ghost; orders chips (Hold, Come about, Face target, Broadside), client-side in `core/helm/helm.ts`. *Status:* not started. *Who:* Claude. *Source:* [fc-handoff] "Still to do" 4

## Solar sectors & warp

- **Picker polish.** Tap feedback in the list (hover highlight sticks on the row under the cursor); the pad hint shows on both ends (Home row and far row); the warp status chip pushes the Pilot/Spectate toggle down ~40 px. *Status:* not started. *Who:* Claude. *Source:* [warp-picker-handoff] step 3
- **Speed-dial open hitch.** ~150–250 ms long frame when the speed dial opens (`dispatchDiscreteEvent` 30–45 ms twice; maybe the SpeedDial `tooltipOpen` labels), plus ~35 ms for the picker. Profile it. *Status:* not started. *Who:* Claude. *Source:* [warp-picker-handoff], #348
- **NAV button and status band.** Rebuild the picker as a NAV button in the top rail (list on touch, system map on desktop) with the spool ring + Cancel in a fixed status slot, replacing the speed-dial "Warp ▸". Planned under Fire Control HUD D. *Status:* not started. *Who:* Claude. *Source:* [fc-handoff] "Still to do" 3
- **Per-sector sun on device.** `ArtService.setSector` is wired (#368) but not checked on a phone. Folded into the phone session. *Status:* blocked on user. *Who:* user + Claude. *Source:* #368

## Fire Control & HUD

Fire Control is on `main` (#367 via #380). **Since PR 1b+1c (feat/lock-to-fire-universal) lock-to-fire is universal for players and HUD D is the only HUD** (`?ui=`, the legacy HUD, A/B/C and the auto-fire toggle are gone). What remains is PR 1d (NPCs and structures lock too). The full list with context is [fc-handoff]; delete that file in the PR that finishes it.

- **Make lock-to-fire universal.** In order:
  1. Fix the bugs below while the feature is still opt-in.
  2. One PR for the server and client switch:
     - drop the `fireControl` join flag and have `LockSubsystem` track every player;
     - remove the legacy pass-throughs (`hasLocked`, `mountBearsOnLock`, `isFireControl`, `lockAimTarget`);
     - close the `lock_track` and rate-limit gaps;
     - collapse the client to HUD D: delete `uiVariant` legacy/a/b/c, `installMouseAim`, the auto-fire toggle and the legacy slot bar.
  3. NPCs and structures lock too:
     - generalise `NpcLockSubsystem` to any target;
     - replace the 0.45 rad cone gate with "locked on the target it fired at";
     - gate `AiFireResolver.fireMount` and `StructureMountTicker`.

  Tests (about 50 files):
  - add `lockTarget` (integration) and `lockOn` (e2e) helpers instead of editing each spec by hand;
  - flip `fireControlLocks.test.ts:80` and the `npcLocks` legacy case to assert refusal;
  - make the netgate `strafe-fire` scenario lock first.

  Docs: remove the opt-in sections, and add a root CLAUDE.md invariant "no weapon fires without a completed lock".

  *Status:* partial: step 1 done (#383, #384); step 2 done (PR 1b+1c: every player tracked, `fireControl` flag and pass-throughs removed, `lock_track` verified + rate limits, client collapsed to HUD D; helpers `harness.lockTarget`, testMode `instantLock`, E2E `lockOn`; `fireControlLocks` flipped, the `npcLocks` legacy case removed, netgate `strafe-fire` locks first). Step 3 (PR 1d) not started. *Who:* Claude. *Source:* user 2026-11-09

- **Info-box LOCK didn't start a lock (bug, check first).** In the 1v3 clip the button still read LOCK after a tap and a retry; the E2E passes in `auto-fire-test`. Suspects: the world-anchored info box slides so taps miss; or the target was out of reach and dropped silently after the 1.5 s grace. Failing test first. *Status:* done (#383). *Who:* Claude. *Source:* [fc-handoff] "Still to do" 0, "Bugs"
- **"Can't lock" feedback.** An out-of-reach or untrackable target sits at 0 % and drops after 1.5 s with nothing shown. Add OUT OF RANGE on the LOCK button and a broken ring. *Status:* done (#383: OUT OF RANGE on the lock wire, `c: 1`). *Who:* Claude. *Source:* [fc-handoff]
- **MAN doesn't cancel an AUTO lock in progress.** Switching a group to MAN leaves AUTO's building lock running, so both groups end up on one target. *Status:* done (#384). *Who:* Claude. *Source:* [fc-handoff] "Bugs"
- **Ghost bolts from off-target mounts.** Capital multi-mount groups can show a predicted bolt from a mount that isn't on target (server refuses it); `sendFire` gates per group, not per mount. *Status:* done (#384: shared `barrelBearsOn`). *Who:* Claude. *Source:* [fc-handoff]
- **Verify `lock_track` server-side.** The server trusts the client's lock line; check the target is within a cone of the pilot's last guide bearing or the group's arc. Required before this leaves the experiment. *Status:* done (PR 1b+1c: shared `lockLineScore` cone on the claimed line bearing). *Who:* Claude. *Source:* [fc-handoff] "Gameplay / server gaps"
- **Rate-limit lock messages.** `lock_request`, `lock_track`, `lock_cancel`, `set_group_mode` have no server cap. *Status:* done (PR 1b+1c: `MAX_LOCK_MSGS_PER_TICK` = 3 per session per tick). *Who:* Claude. *Source:* [fc-handoff]
- **NPC fire gate is a 0.45 rad cone.** A shot aimed elsewhere that then hits a tracked pilot isn't gated. *Status:* not started. *Who:* Claude. *Source:* [fc-handoff]
- **Edge-radar lock marks.** Tint HaloRadar wedges for off-screen ships locking you (red) and your own locked targets (group colour). NPC locks start from beyond the screen edge, so this is how they read. *Status:* not started. *Who:* Claude. *Source:* [fc-handoff] "Still to do" 1
- **Legacy weapon-slot bar shows in D.** PRIMARY / EMPTY / EMPTY still shows at the bottom on desktop; the weapon strip replaces it. *Status:* done (PR 1b+1c: the legacy HUD is gone). *Who:* Claude. *Source:* [fc-handoff]
- **Info box moves with its ship.** Its buttons are a moving target on touch; pin it while a finger is down, or dock it. *Status:* done (#384: `app/inspectorHold.ts` holds it still under the pointer). *Who:* Claude. *Source:* [fc-handoff]
- **Pilot/Spectate toggle in portrait.** Last in the top-centre column; with both lock bands up on a short screen it can sit close to the ship. *Status:* not started. *Who:* Claude. *Source:* [fc-handoff]
- **Tech debt.** `updateLockGuide` builds a key string per candidate (precompute keys; invariant #14); `_fcInfo.allFixed` is unused on the client. *Status:* done (PR 1b+1c: cached lock keys + shared `lockLineScore`; `allFixed` deleted). *Who:* Claude. *Source:* [fc-handoff]
- **Tuning untested on a device.** Base lock 1.5 s, failsafe 1.75×, drain 1.5×, sticky cone 1.6×, fire tolerance 0.2 rad, fixed-gun AUTO ±0.3 rad, lock-line cone 70 u + 0.12 u/u. *Status:* blocked on user (device). *Who:* user + Claude. *Source:* [fc-handoff] "Tuning"
- **Before Fire Control leaves opt-in.** Netgate, perf scenes, full lint and feature-tier E2E, CLAUDE.md rules for src/server and src/client (lock-gated fire, `lock_track`, the `groups` / `lockedBy` slices; invariants #12/#15 now cover lock-gated fire). *Status:* not started. *Who:* Claude. *Source:* [fc-handoff] "Before any PR"
- **HUD D beyond piloting.** Drawer, main menu, spectator mode and building keep the old UI; fonts and tokens are ready. D replaces legacy (decided 2026-11-09). *Status:* not started. *Who:* Claude. *Source:* [hud-variants] "Not in scope", [fc-handoff] "Later"
- **PR 1d, in small slices (one change + tests each, ~10–20 min; user 2026-11-09):**
  1. NPC drones fire only with a completed lock on the target they fire at (replaces the 0.45 rad cone gate).
  2. NPC capital turrets (`AiFireResolver.fireMount`) go through the same lock gate.
  3. Structure / coastal turrets (`StructureMountTicker`) lock before firing.
  4. Player capital turrets: each turret its own reload, and split across the group's up to 3 locks (`tickCapitalMounts` / `aimKeyFor`). User rule: separate turrets fire independently when on target and share the group's target(s); one multi-barrel turret fires all barrels together.

  Slices 1 and 3 can run in parallel. *Status:* not started. *Who:* Claude.
- **Follow-ups found finishing PR 1b+1c.**
  - Test option to start every weapon group in MAN (e.g. testMode `groupMode=manual`). Then `missile-frigate-homing`'s drone test can use `instantLock` and drop its 15 s deadline back to 4 s (today the PD laser on AUTO would kill the target first).
  - `?instantLock=1` also widens AUTO to ANY target (`anyTarget`, test-only). Consider splitting it so "instant lock" and "target anything" are separate options.
  - `laser-falloff-probe:77` (fire into empty space) is `test.fixme`: there's no firing without a target now. Rework it to fire at a locked target at long range, or retire it.
  - Dead code: the `aim` wire field and `manualAimMountBearing` are unused since manual aim went.
  - Stale docs: `showcase-pipeline.md:249`; `docs/handoff/fire-control-to-be-continued.md` (delete it in the PR that finishes PR 1d).
  *Status:* not started. *Who:* Claude.

## Showcase (landing is done: these can start)

Every item here waits until all PRs are merged (user, 2026-11-09). Before each recording: clean up ports, leftover node / headless Chrome / ffmpeg, and check free RAM (root CLAUDE.md). Every clip gets a hostile review before the user sees it.

- **Lock-to-fire in combat takes.** The `SURVIVE` params (13 shots) now carry `instantLock`, which also lets AUTO target ANY NPC or structure in reach. In the re-films, check no take shows the pilot firing on a neutral structure; where one does, drop `instantLock` and lock the intended target. *Status:* not started. *Who:* Claude. *Source:* PR 1b+1c
- **gpu-lit-ships clip.** Re-film after the game-side fixes in Art & lighting; fix the framing (hull near the left edge, caption over the stern; the follow camera beat two scripted track cameras). Publish only after a clean review. *Status:* partial. *Who:* Claude. *Source:* #376, [gpu-lit]
- **Warp picker map view.** Re-film `pnpm showcase --shot warp-picker` with the label fix (the interrupted clip in `showcase-out/clips/warp-picker/` may be incomplete: ignore it). Review: labels by their dots and readable, Home dot visible, Warp button readable. Send the user the clip with the "only flies right" answer. *Status:* not started. *Who:* Claude. *Source:* [warp-picker-handoff]
- **Fleet warp final review.** The last re-film from #368/#369 never had its final hostile review. *Status:* not started. *Who:* Claude. *Source:* #368, #369
- **Coastal shots.** `coastal-catalogue` and `coastal-aa` were flagged by the pilot-wobble gate (60 fps, pilot barely in frame): re-take, or make the gate skip shots where the local ship is off-screen. Then the filmed review + artifact (coastal Stage 7). *Status:* partial. *Who:* Claude. *Source:* #365, [coastal-plan]
- **pack-battle / new-effects re-takes.** Re-run on a port offset to confirm the pose gate (≤ 2 corrections) in real footage after #360. *Status:* not started. *Who:* Claude. *Source:* [DV-handoff] "From #360", #360
- **trade-deal re-record.** Confirm footage behind menus is live after #362 (expect `DrawFrame` gaps ~17 ms, not 1.2–1.5 s). *Status:* not started. *Who:* Claude. *Source:* [DV-handoff] step 3, #362, #363
- **WS8.2: re-stage the 10 cut shots.** galaxy-landing (static map, captions over hexes), alien-gate and teleporter-ride (mostly frozen, toasts over the subject), npc-citadel (8 s of empty space, citadel clipped at top), grid-alive (caption and hotbar cover miner and turret), capital-broadside (show gunfire), warp, scrap, garrison-patrol, pack-battle. Rules: action within 1 s, subjects ≥ 40 px at 1080p, caption and HUD off the subject. *Status:* not started. *Who:* Claude. *Source:* [DV-handoff], [DV-report] Phase 5
- **WS8.3: `staticFrames` QA gate.** Fail a take with more than 3 s frozen (ffmpeg `freezedetect`). *Status:* not started. *Who:* Claude. *Source:* [DV-handoff]
- **WS8.1: one recorder at a time.** Refuse to start a showcase recorder while another recorder's ports are live (#353's host-load sampler is the hook). *Status:* not started. *Who:* Claude. *Source:* [DV-handoff]
- **machined-turrets re-record.** Recorded at 53–55 fps on a starved laptop (just under the 55 fps bar); the desktop recorded it at 60 fps. Re-take for the reel. *Status:* not started. *Who:* Claude. *Source:* #292, [DV-report] H6/H11
- **Fire Control shots.** Retire or re-script `fc-phone-landscape` / `fc-desktop` (predate two-way locking and the held line); the review page's 1v3 and failsafe clips predate the sticky line. *Status:* not started. *Who:* Claude. *Source:* [fc-handoff] "Tech debt"
- **SHOWCASE_PENDING shots.** Each needs a staged room: `allegiances` (two-faction fight on cue), `factions` (non-zero standings both ways, a turret firing on a disliked pilot), `blueprints` (loot → install), `research-lab` (base with blueprints + fast-pulse room), `ship-scale` (dedicated shot). *Status:* not started. *Who:* Claude. *Source:* [`showcase/registry.ts`][registry], [prancy] W7
- **Reel and catalogue.** After the above: compose the reel, one shot at a time on the laptop; the full `--catalogue` run was deferred (user W7: a what's-new page from existing clips instead, https://claude.ai/artifact/7cpAR69HzgRp5MfxMxnEpH). Update that page with the new clips. *Status:* not started. *Who:* Claude. *Source:* [prancy] W7, [wrap-up-memory], [hazy-cerf]

## Living world & economy

- **Blueprint contracts on the Contracts tab.** Economy v2 W6 planned blueprint contracts there; the blueprint market (#230) shipped, but no blueprint contract code was found on main. Confirm, then build or drop. *Status:* not started (unverified). *Who:* Claude. *Source:* [peppy] W6
- **Ship weapons using munitions.** Parked, see [`docs/SHELF.md`][SHELF]. *Status:* parked. *Who:* user (to revive). *Source:* [peppy] W5, [SHELF]

## Housekeeping

- **Leftover worktree folders.** Leftover worktree folders (~90 GB under .claude/worktrees: agent-*, wf_*, coastal-defences, composite-ships-havok, desktop-verify, fire-control, handoff; plus ../eqx-net-hud) are unregistered from git but still on disk: deleting them was refused by the session's auto-mode safety check. Delete them from a session with permission, or by hand. *Status:* deferred. *Who:* user or Claude (with permission). *Source:* PR 1b+1c session 2026-11-09
- **Local stash.** `stash@{0}`: "WIP on worktree-agent-ac64581410ab73096: fix(warp): 5s minimum-display floor absorbs the first-correction teleport" (old worktree-agent warp WIP). Inspect, then keep or drop with the user's yes. *Status:* blocked on user. *Who:* user + Claude. *Source:* [tidy-wiggling-frost]
- **Modified tracked file.** `diag/adb-shots/phone-stall-capture.mjs` has uncommitted edits. Commit or revert. *Status:* not started. *Who:* Claude (ask first). *Source:* `git status`
- **Untracked scratch.** ~60 untracked `diag/adb-shots/*.mjs` scripts (35 named `_*.mjs`: old PR create/poll scripts), plus `diag/_cap-still.mjs`, `diag/_measure-hull.mjs`, `diag/_clip-jitter/`, `diag/_tmp/`, art-lab rounds, e2e screenshots and ~120 June capture dirs under `diag/captures/`. Delete the scratch (CLAUDE.md "Clean up at every stage"); keep any capture a doc cites. *Status:* blocked on user. *Who:* Claude. *Source:* `git status`
- **This checkout is on a merged branch.** `chore/w7-showcase` (#376 merged); switch to main and delete it locally. Remove `.claude/worktrees/land-*` once their PRs merge; remove `perf-base` if no task above needs it; keep `netgate-baseline` / `netgate-head`. *Status:* not started. *Who:* Claude. *Source:* [tidy-wiggling-frost] Phase C
- **Old phase-1 HUD worktree.** `../eqx-net-hud` couldn't be moved under `.claude/worktrees/` (Permission denied); remove it once #367 merges. *Status:* not started. *Who:* Claude. *Source:* [fc-handoff]
- **Banner the old weekend handoffs.** Add "superseded by HANDOFF-consolidated-2026-11-09" to `docs/HANDOFF-desktop-verification-2026-11-08.md`; delete `docs/handoff/fire-control-to-be-continued.md` and `docs/handoff/warp-picker-keep-both.md` in the PRs that finish their work. *Status:* not started. *Who:* Claude. *Source:* [tidy-wiggling-frost] Phase B
- **Memory notes.** Collapse `wrap-up-plan-status` to one line pointing here; `gpu-lit-art-status` is stale (says "off by default"; the +33 % heap reading was garbage, #372). Keep `MEMORY.md` under 24 KB. *Status:* not started. *Who:* Claude. *Source:* [wrap-up-memory], [gpu-lit-memory]
- **Old plan files.** `prancy-squishing-donut` (wrap-up) is executed apart from the items above: mark it closed with a pointer here. The economy plan `peppy-jumping-pinwheel` and art plan `soft-leaping-truffle` v5 likewise. *Status:* not started. *Who:* Claude. *Source:* [prancy], [peppy], [soft-leaping-truffle]

## Parked / stale branches

No branch below has an open PR. "Ahead" counts non-merge commits not on `main`. Nothing is deleted without the user's yes.

| Branch | Ahead | Last commit | What it is | Suggest |
|---|---|---|---|---|
| `rnd/fx-environment` | 9 | 2026-11-04 | FX lab round 2: depth ladder, sector landmarks, nebula volumes, speed effects, shield-fence prototype, `?play=1` | Keep (R&D reference; per-sector nebula idea lives here) |
| `rnd/engine-fx` | 2 | 2026-11-04 | Exhaust lab (today / flame / ribbon / both) + capture script; the pick shipped as #288 | Delete |
| `rnd/turrets` | 2 | 2026-11-05 | Turret lab rounds 1–2; shipped as #289–#292 | Delete |
| `rnd/art-direction` | 0 | 2026-11-04 | Art lab rounds 1–2; fully on main | Delete |
| `perf/client-art-memory` | 1 | 2026-11-07 | #330 (closed): bake only needed art, free sealed atlas canvases; parked in SHELF | Keep (SHELF revive path) |
| `feat/shipyard` | 0 | 2026-11-01 | Shipyard (economy v2 W5); only a merge of main is left | Delete |
| `feat/bases-city` | 1 | 2026-10-31 | "city archetype + city kit + showcase 3 (PR-K2)"; check whether D3 colonies (#240) replaced it | Ask / likely delete |
| `feat/bases-vertical-slice` | 0 | 2026-10-31 | Bases vertical slice; only a merge of main is left | Delete |
| `feat/cinematic-camera` | 0 | 2026-10-31 | Cinematic camera; only a merge of main is left | Delete |
| `fix/showcase-encode-timeline` | 1 | 2026-11-07 | Screencast settle fix; already in main's `showcase/recorder.ts` (#326) | Delete |
| `claude/cleanup-merge-branches-XT8nJ` | 6 | 2026-05-25 | May wrap-up-known-issues fixes + GC discipline merge (506 files differ) | Ask (likely superseded) |
| `claude/codebase-review-plan-qwv0p0` | 1 | 2026-06-09 | Plan doc: codebase health + security remediation (`squishy-canyon`) | Ask |
| `claude/colyseus-refactor-plan-XEAuw` | 1 | 2026-05-26 | Plan doc: client god-file decomposition | Ask |
| `claude/game-object-polymorphism-BvyED` | 1 | 2026-06-04 | Plan doc: generic entity pipeline refactor | Ask (GEP shipped) |
| `claude/handoff-issues-plan-aopm6` | 1 | 2026-06-07 | CI: netgate auto-retry up to 3× (superseded by `auto-retry.yml`, once) | Delete |
| `claude/test-coverage-audit-qfT03` | 1 | 2026-06-02 | Plan doc: test-coverage audit (now `docs/refactors/test-coverage-audit.md`) | Delete |
| `feat/warp-picker-keep-both` | 0 | 2026-11-08 | Warp picker keep-both; merged as #379 (branch auto-deleted) | Done |
| `archive/rnd-capital-ships` (tag) | — | — | The deleted `rnd/capital-ships` branch, archived by #371 | Keep |

## Suggested priority order

1. **Feature specs broken on `main`** (found while landing): laser probe, build placement / speed dial / grid web, laser smoothness, the CI-only scrap drift spike and `fire-control-lock`. They stop the advisory feature job meaning anything.
2. **Lock-to-fire universal** (decided 2026-11-09): Fire Control bug fixes first, then the universal switch, then NPCs and structures.
3. **Quarantined specs:** verify 6/6, un-quarantine, run the feature tier, triage the 4 flaky specs.
4. **GPU lighting on weak hardware:** the 8-rep phone-proxy runs now; the real-phone runs when the user plugs in; then the default-level call.
5. **Coastal follow-ups that touch correctness:** netgate byte deltas and perf against count budgets for #365.
6. **Fire Control server trust:** verify `lock_track`, rate-limit lock messages, fix the info-box LOCK bug (before anyone suggests making D the default).
7. **WS7.3 damage-number smear and WS7.2 art upload budget.**
8. **Melee residual corrections** after #360, then gate the melee spec on count.
9. **gpu-lit-ships game-side fixes** (flash light decay, 5" turret light, stray rod, shell streak direction).
10. **Showcase pass** (after landing): WS8.1 / WS8.3 gates first, then the re-takes and re-stages, each hostile-reviewed; then update the what's-new page.

---

## Appendix: Sources

Items per source = bullets that cite it. An item with several sources counts once for each, so the column sums to more than the 110 items.

| ✓ | Source | Items |
|---|---|---|
| ✓ | PR bodies #288–#376 (89 PRs; scratchpad dump `pr-bodies.md`). Follow-ups came from #292, #295, #299, #302, #321, #330, #337, #344, #345, #346, #348, #351, #354, #356, #359, #360, #362, #363, #365, #367, #368, #369, #371, #372, #375, #376. Already resolved by later PRs and skipped: #298 speed-fx (→ #299), #312 hull styles (→ #366), #338 phone art budget (→ #339–#341), #335 warp visuals (→ #336/#343), #344 ledger params (→ #352), #348 delete-one-prototype (→ keep both). | 48 |
| ✓ | [`docs/HANDOFF-desktop-verification-2026-11-08.md`][DV-handoff] | 22 |
| ✓ | [`diag/measurements/2026-11-08-desktop-verify/desktop-verification-report.md`][DV-report] (incl. Phase 5 per-shot problems) | 11 |
| ✓ | [`diag/measurements/2026-11-08-desktop-verify/hostile-review.md`][hostile-review] | 4 |
| ✓ | [fc-handoff] `exp/fire-control:docs/handoff/fire-control-to-be-continued.md` ("Still to do" + "Known issues") | 26 |
| ✓ | [warp-picker-handoff] `feat/warp-picker-keep-both:docs/handoff/warp-picker-keep-both.md` | 5 |
| ✓ | [coastal-plan] `feat/coastal-defences:plans/coastal-defences.md` (tracker + decision log) | 3 |
| ✓ | [`plans/network-feel-roadmap.md`][nf-roadmap] (Stages 5b/6/7 open; follow-on workstreams) | 5 |
| ✓ | [`docs/architecture/gpu-lit-ships.md`][gpu-lit] ("Open question", "Memory", "Status and next steps") | 8 |
| ✓ | [`docs/architecture/perf-scenes.md`][perf-scenes] (allocation-count follow-up) | 1 |
| ✓ | `docs/architecture/solar-system-sectors.md`: read; no open items | 0 |
| ✓ | [`docs/architecture/travel-state.md`][travel-state] ("Known gap": upload stalls) | 1 |
| ✓ | `docs/architecture/off-screen-indicators.md`: read; remaining steps dropped to SHELF | 0 |
| ✓ | `docs/architecture/perf-device-capture.md`: read; no open items | 0 |
| ✓ | [`docs/architecture/art-direction.md`][art-direction] ("Known gaps") | 3 |
| ✓ | `docs/features/capital-ships.md`, `docs/features/warp-to.md`: read; no open items | 0 |
| ✓ | `showcase/README.md`: read; no open items | 0 |
| ✓ | [`showcase/registry.ts`][registry] (`SHOWCASE_PENDING`: 5 entries) | 1 |
| ✓ | [`docs/refactors/test-coverage-audit.md`][audit] + `QUARANTINE` in `tests/e2e/featureTriggers.mjs` (7 entries on main) | 5 |
| ✓ | Branch docs: [coastal-defences] + [military-bases] (`feat/coastal-defences`, no open items beyond #365); [robot-territory] (`feat/harvesters-mine`, "Next" closed by #375); [hud-variants], [weapon-groups] and [fire-control-arch] (`exp/fire-control`, open work points to fc-handoff) | 2 (robot-territory 1, hud-variants 1) |
| ✓ | [`docs/SHELF.md`][SHELF]: referenced, not duplicated | 1 |
| ✓ | [prancy] local plan `prancy-squishing-donut.md` (wrap-up W0–W7; checked against git: W0–W3, W5 done; W1a E2E, W4 select-scenes/budget files and W7 reel open; W6 merged #375) | 5 |
| ✓ | [peppy] local plan `peppy-jumping-pinwheel.md` (economy v2: W1–W6 merged; blueprint contracts unverified; munitions on SHELF) | 3 |
| ✓ | [soft-leaping-truffle] local plan (art v5: patrol tint fixed #269; big surfaces, deck shadows, nebula left) | 4 |
| ✓ | [hazy-cerf] local plan `i-want-you-to-hazy-cerf.md` (catalogue run deferred) | 1 |
| ✓ | Closed plans `eager-sauteeing-curry`, `iridescent-seeking-rainbow`, `sparkling-wondering-rose`: pointer only; headers say leftovers moved to the wrap-up plan and SHELF | 0 |
| ✓ | [tidy-wiggling-frost] local plan (the landing plan, done 2026-11-09) | 13 |
| ✓ | Auto-memory [wrap-up-memory] `wrap-up-plan-status.md`, [gpu-lit-memory] `gpu-lit-art-status.md` | 4 (2 + 2) |
| ☐ | Other machine: `machine-independent-perf` and `synchronous-hippo` local plans, unpushed work | pending user |
| ✓ | `git status` / `git stash list` / `git worktree list` on this machine | 3 |

Older `docs/HANDOFF-*.md` (May–June, ~25 files): out of scope, see Scope above.

[SHELF]: SHELF.md
[DV-handoff]: HANDOFF-desktop-verification-2026-11-08.md
[DV-report]: ../diag/measurements/2026-11-08-desktop-verify/desktop-verification-report.md
[hostile-review]: ../diag/measurements/2026-11-08-desktop-verify/hostile-review.md
[nf-roadmap]: ../plans/network-feel-roadmap.md
[gpu-lit]: architecture/gpu-lit-ships.md
[perf-scenes]: architecture/perf-scenes.md
[travel-state]: architecture/travel-state.md
[art-direction]: architecture/art-direction.md
[registry]: ../showcase/registry.ts
[audit]: refactors/test-coverage-audit.md
[fc-handoff]: handoff/fire-control-to-be-continued.md
[warp-picker-handoff]: https://github.com/JanusBifrons/eqx-net/blob/7ff8e159/docs/handoff/warp-picker-keep-both.md
[coastal-plan]: ../plans/coastal-defences.md
[coastal-defences]: features/coastal-defences.md
[military-bases]: features/military-bases.md
[robot-territory]: features/robot-territory.md
[hud-variants]: features/hud-variants.md
[weapon-groups]: features/weapon-groups-and-locking.md
[fire-control-arch]: architecture/fire-control.md
[prancy]: <~/.claude/plans/prancy-squishing-donut.md (local, first machine)>
[peppy]: <~/.claude/plans/peppy-jumping-pinwheel.md (local, first machine)>
[soft-leaping-truffle]: <~/.claude/plans/soft-leaping-truffle.md (local, first machine)>
[hazy-cerf]: <~/.claude/plans/i-want-you-to-hazy-cerf.md (local, first machine)>
[tidy-wiggling-frost]: <~/.claude/plans/tidy-wiggling-frost.md (local, first machine)>
[wrap-up-memory]: <~/.claude/projects/…/memory/wrap-up-plan-status.md (local auto-memory)>
[gpu-lit-memory]: <~/.claude/projects/…/memory/gpu-lit-art-status.md (local auto-memory)>

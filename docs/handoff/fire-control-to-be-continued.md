# To be continued: Fire Control HUD (branch `exp/fire-control`)

> **Superseded 2026-11-09** by [HANDOFF-consolidated-2026-11-09](../HANDOFF-consolidated-2026-11-09.md), the single list of outstanding work. This file keeps the detail; track and tick items there.

Paused 2026-11-08 at the user's request: "wrap up and close out this unit of
work… the other work we had planned will have to go into a markdown file and
committed as to be continued and picked up at a later date." Delete this file in
the PR that finishes the work.

## How to pick this up (any machine)

```
git fetch origin
git worktree add .claude/worktrees/fire-control -b exp/fire-control-2 origin/main   # once the PR has merged
# or, while the PR is still open:
git worktree add .claude/worktrees/fire-control origin/exp/fire-control
cd .claude/worktrees/fire-control && pnpm install
```

- Read [weapon-groups-and-locking.md](../features/weapon-groups-and-locking.md) and
  [fire-control.md](../architecture/fire-control.md) first, then the lists below.
- Try it: `/?room=fc-duel&startHostile=1&shipKind=gunship&ui=d` (1v3), or
  `room=feel-test` without `startHostile` for the failsafe.
- Re-film: `EQX_SHOWCASE_PORT_OFFSET=<free> pnpm showcase:fc` (clean video);
  `FC_STILLS=1 …` for stills (screenshots stall a take, so keep them separate).
- Lock-related tests: `src/server/rooms/LockSubsystem.test.ts`,
  `tests/integration/sectorRoom/{fireControlLocks,npcLocks,fireControlArc}.test.ts`,
  `tests/e2e/fire-control-lock.spec.ts`, `tests/e2e/hud-variants.spec.ts`.

## Where things stand

- **Branch:** `exp/fire-control`, pushed and opened as one PR (it contains
  phase 1, `exp/hud-mobile-first`, too). Synced with `origin/main` on
  2026-11-08. Everything is opt-in behind `?ui=a|b|c|d`, so default players are
  unaffected.
- **Plan:** `i-d-like-you-to-synchronous-hippo.md` (in `~/.claude/plans/` on the
  first machine). Summary of what it covers is below, so this file stands alone.
- **Review page:** https://claude.ai/artifact/T6jfa4pAhHScbvz3C2NPxd (private):
  phase 1 HUDs A–C, and D · Fire Control with the 1v3, failsafe and warp clips.
- **Docs:** [weapon-groups-and-locking.md](../features/weapon-groups-and-locking.md),
  [fire-control.md](../architecture/fire-control.md).

### Done (in commit order)

1. P0: per-group fire plumbing (weapon field widened, mount-angle index fix,
   per-group cooldowns).
2. P1: `lockTime` / `lockState` / `lockProfile` (data-driven lock time).
3. P2: `LockSubsystem`, lock messages, snapshot `groups`, the fire gate.
4. P3: client fire loop + predicted turret aim per group.
5. P4: catalogue groups (gunship, missile frigate + PD, crossguard, capitals),
   catalogue version 24.
6. P5 (part): variant D: weapon strip, lock line, inspector LOCK button, Pixi
   lock visuals, top lock band.
7. Locks both ways: `NpcLockSubsystem`, `lockedBy` slice, threat visuals.
8. User feedback 2026-11-08:
   - no firing out of arc (server + client);
   - arc-aware AUTO;
   - the held lock line that drains when let go;
   - LOCK / CANCEL / UNLOCK in the info box;
   - "HAVE YOU LOCKED" wording;
   - the Pilot/Spectate toggle moved off the ship;
   - a sticky lock line (a held target isn't stolen by a ship drifting across
     the line).

## Still to do (from the approved plan, in rough priority)

0. **Bug to check first: the info-box LOCK press in the 1v3 clip didn't start
   a lock** (the button still read LOCK after a tap and a retry). The e2e
   "hands-off" test passes in `auto-fire-test`. Suspects:
   - the info box is world-anchored and slides as the ship moves, so taps miss;
   - the target was out of the group's reach, and an unreachable lock is
     dropped after the 1.5 s grace with no feedback.

   Either way, add feedback: an "OUT OF RANGE" state on the button and on the
   ring. Also: the review page's 1v3 and failsafe clips predate the sticky
   line; its stills show it.
1. **Edge radar for locks.** Tint HaloRadar wedges for off-screen ships that
   are locking you (red) and for your own locked targets (group colour).
2. **Capitals:**
   - Player capitals: generalise `WeaponMountTicker.tickCapitalMounts` so each
     turret picks among its group's (up to 3) locks, not just the first.
   - NPC capitals: gate `AiFireResolver.fireMount` with the NPC lock (today only
     the hull-aimed `resolve` path is gated).
3. **Top status band + nav panel**, rebuilt from the warp picker (prior art on
   `main`, #348/#349):
   - list on touch, system map on desktop;
   - spool ring + Cancel in a fixed status slot;
   - a NAV button in the top rail instead of the speed-dial "Warp ▸".
4. **Capital fly-by-wire layer:**
   - a vertical speed telegraph (Astern / Stop / ⅓ / ⅔ / Full) replacing the
     HelmPanel buttons;
   - a course line + destination marker for tap-to-move;
   - a heading ghost;
   - orders chips: Hold, Come about, Face target, Broadside (client-side in
     `core/helm/helm.ts`, no new netcode).
5. **Polish seen in the footage:**
   - hostile drones still draw in their own (often green) colours next to red
     lock rings;
   - the legacy weapon-slot bar (PRIMARY / EMPTY / EMPTY) still shows at the
     bottom on desktop in D;
   - capital multi-mount groups can show a predicted bolt from a mount that
     isn't on target (the server refuses it).
6. **Gates before any PR:**
   - `pnpm e2e:netgate`: required (live loop: fire path, snapshot slices, mount
     aim); use a free port offset after checking owners;
   - perf scenes for the player-capital turret cost;
   - full `pnpm lint`, `pnpm e2e` feature tier;
   - a hostile review of the clips;
   - CLAUDE.md updates (fire-control rules under src/server + src/client;
     invariants #12/#15 now cover lock-gated fire).
7. **Later (not in this plan):** D replacing the legacy HUD, drawer/menu
   restyle, pilot skills feeding `PilotLockMods`.

## Known issues and polish

Everything known to be wrong, rough or unfinished on this branch, beyond the
planned features above. Tick items off (or move them into a PR description) as
they're fixed.

### Bugs

- [ ] **Info-box LOCK didn't register in the 1v3 clip.** The button still read
  LOCK after a tap and a retry; the e2e "hands-off" test passes in
  `auto-fire-test`. Reproduce in a failing test first (invariant #13). Suspects:
  - the world-anchored info box slides as the ship moves, so taps miss;
  - the target was out of reach and the lock was dropped silently.
- [ ] **Switching a group to MAN doesn't cancel the lock AUTO already started.**
  In the footage both groups ended up on the same fighter because their AUTO
  locks were already building when the pilot flipped them to MAN.
- [ ] **Capital multi-mount groups** can show a predicted (ghost) bolt from a
  mount that isn't on target. The server correctly refuses it; the client
  gates per group, not per mount, in `sendFire`.

### Missing feedback / UX

- [ ] **No "can't lock" feedback.** An out-of-reach or untrackable target
  (`lockSeconds` = Infinity) sits at 0 % and is dropped after the 1.5 s grace
  with nothing shown. The plan's broken "can't lock" ring isn't built, and the
  LOCK button should say OUT OF RANGE.
- [ ] **No edge-radar marks** (HaloRadar): off-screen ships locking you are
  only shown by the caret on your ring and the top band.
- [ ] **Hostile drones draw in their own colours** (often green) next to red
  lock rings and diamonds; hostility should read at a glance.
- [ ] **The legacy weapon-slot bar** (PRIMARY / EMPTY / EMPTY) still shows at
  the bottom on desktop in D; the weapon strip replaces it.
- [ ] **The info box moves with its ship**, so its buttons are a moving target
  on touch. Consider pinning it while a finger is down, or docking it.
- [ ] **Pilot/Spectate toggle in portrait** is last in the top-centre column;
  with both lock bands showing on a short screen it can sit close to the ship.
- [ ] **Locking a player** (`p:` keys) always runs the failsafe and logs a
  hostile act, but there's no PvP flag or notice to the target yet (plan P2).
- [ ] **Warp-to in D** still uses the speed-dial "Warp ▸" and the existing chip;
  the NAV button and the status-band slot aren't built (see "Still to do" 3).

### Gameplay / server gaps

- [ ] **`lock_track` is trusted.** The server believes the client's line is on
  the target; it doesn't check the bearing. Verify server-side (target within a
  cone of the pilot's last guide bearing, or within the group's arc) before this
  leaves the experiment.
- [ ] **No rate limit on the lock messages** (`lock_request`, `lock_track`,
  `lock_cancel`, `set_group_mode`). The client sends `lock_track` only on
  change, but the server should cap it like inputs.
- [ ] **NPC capitals' turret fire isn't lock-gated** (`AiFireResolver.fireMount`);
  only the hull-aimed `resolve` path is.
- [ ] **The NPC fire gate is a line-of-fire cone** (0.45 rad, `NpcLockSubsystem`).
  A shot aimed elsewhere that then hits a tracked pilot isn't gated.
- [ ] **Player capital turrets** aim at the group's first lock only
  (`aimKeyFor`), not split across its 3 locks.
- [ ] **NPC locks start from beyond the screen edge** (weapon reach is long).
  Realistic, but tune or add the radar marks above so it reads.

### Tuning (all untested on a real device)

- Base lock 1.5 s, failsafe 1.75×, drain 1.5× (`LOCK_TUNING`, `lockProfile.ts`).
- Sticky line: the held target's cone is 1.6× wider (`updateLockGuide`).
- Fire tolerance 0.2 rad, server and client (`FC_MOUNT_FIRE_TOLERANCE`).
- Fixed-gun AUTO window ±0.3 rad (`FIXED_BEAR`, `LockSubsystem.ts`).
- Lock-line cone: 70 u minimum, widening 0.12 u per unit of distance.

### Tech debt

- [ ] `updateLockGuide` builds a key string per candidate (10 Hz while a line
  is held, plus each pointer move): small allocation; precompute keys.
- [ ] `_fcInfo.allFixed` is now unused on the client (the arc check replaced it).
- [ ] Unmeasured cost: `NpcLockSubsystem.step` is O(drones × fire-control
  pilots) at 10 Hz, and `fireBlocked` runs per NPC shot. Add a bench before any
  PR.
- [ ] Older showcase shots `fc-phone-landscape` / `fc-desktop` predate locking
  both ways and the held line; retire or re-script them. The review page's 1v3
  and failsafe clips predate the sticky line (the stills show it).

### Before any PR

- [x] Synced with `origin/main` (2026-11-08); typecheck, lint and the unit
  suite pass locally. Integration, netgate and e2e are left to CI.
- [ ] `pnpm e2e:netgate` (live loop: fire path, snapshot slices, mount aim),
  perf scenes, full `pnpm lint` + `pnpm e2e` feature tier.
- [ ] CLAUDE.md (the worktree/port-owner rule is now in the root CLAUDE.md): fire-control rules for src/server and src/client (lock-gated
  fire, `lock_track`, the own-ship `groups` / `lockedBy` slices).
- [ ] Pre-existing, not from this branch: `energy-bar` e2e fails on `main` too;
  `auto-fire` e2e is quarantined.
- [ ] Housekeeping: the old phase-1 worktree `../eqx-net-hud` couldn't be moved
  under `.claude/worktrees/` (Permission denied).

## Gotchas learned

- Several Claude sessions share this machine and the showcase recorder uses
  fixed ports per offset. **Check port owners immediately before launching**
  (not in parallel with the launch); this branch used offset 700 (3467/6073)
  after a clash on 400.
- Screenshots during a take stall the page 150–320 ms: stills are a separate
  pass (`FC_STILLS=1 pnpm showcase:fc`), videos a clean one.
- Automation defaults to classic art: the fc shots pass
  `art=machined&fx=new&shiplight=gpu&speedfx=1`.
- `laser_fired` is beams only; assert bolt fire via `hit_ack`.

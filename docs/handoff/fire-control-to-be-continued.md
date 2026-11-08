# To be continued: Fire Control HUD (branch `exp/fire-control`)

Paused 2026-11-08 at the user's request: "wrap up and close out this unit of
work… the other work we had planned will have to go into a markdown file and
committed as to be continued and picked up at a later date." Delete this file in
the PR that finishes the work.

## Where things stand

- **Branch:** `exp/fire-control` (worktree `.claude/worktrees/fire-control`). It
  was cut from `exp/hud-mobile-first` with `origin/main` and
  `origin/feat/warp-picker-keep-both` merged in. **Not pushed, no PR**: the user
  asked for no PR until they say so.
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
   - the Pilot/Spectate toggle moved off the ship.

## Still to do (from the approved plan, in rough priority)

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

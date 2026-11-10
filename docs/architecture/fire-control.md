# Fire control: weapon groups, locks and the fire gate

Player-facing behaviour: [docs/features/weapon-groups-and-locking.md](../features/weapon-groups-and-locking.md).

## The rule: no player weapon fires without a completed lock

Since 2026-11-09 this is universal (root CLAUDE.md invariant #19). Every player
is tracked in `LockSubsystem` from join (`enable` in `onJoin`; `forget` on leave
through `LeaveHandler.forgetLocks`), and NPC drones must lock every player
(`NpcLockSubsystem`). There are no legacy pass-throughs left: `hasLocked()` is
false for an untracked player, `mountBearsOnLock` / `lockAimTarget` always
consult the locks, and player turrets always aim at their group's lock (the old
player auto-target in `WeaponMountTicker.tickPlayer` is gone). The `fireControl`
join option and the `?ui=` HUD switch were removed. NPC capitals' turrets each
fire only with the capital's completed lock on their OWN target (PR 1d slice 2):
a capital holds one lock per pilot, built with whichever of its gun sizes locks
that pilot fastest, so its AA can engage a fighter while its 16" guns (which can
never lock a fighter-sized hull) wait for a capital. A capital turret whose
target is a hostile STRUCTURE fires only with its own completed turret lock on
it (same `lockSeconds` rules: the mount size's profile, the hull's sensor, the
structure's radius as signature). Structure turrets lock their targets too
(PR 1d slice 3, `StructureMountTicker`).

**Trust.** The server never takes the client's word for a lock:
- `lock_track` carries the lock line's bearing (`b`, `encodeAim`); the server
  holds the target only when it lies on that line by the shared rule
  `lockLineScore` / `lockLineHolds` (`core/combat/lockLine.ts`, the same function
  the client picks with; the server uses the sticky cone to absorb display delay
  and quantisation). A claim off the line, past reach × 1.1, or without `b`
  counts as "on nothing".
- `lock_request`, `lock_track`, `lock_cancel` and `set_group_mode` share a cap of
  `MAX_LOCK_MSGS_PER_TICK` (3) per session per tick; the excess is dropped.

**Cost.** NPC lock step is O(pilots × hostile NPCs) at 10 Hz:
`benchmarks/npc-locks.bench.ts` measures ~0.015 ms for 56 drones × 4 pilots and
~0.037 ms for 56 × 10 (laptop, 2026-11-09).

**Test triggers.** testMode join option `instantLock: true` (URL `?instantLock=1`):
every lock completes on the next step (a failsafe still commits its hostile
act); AUTO targeting is unchanged. testMode join option `anyTarget: true` (URL
`?anyTarget=1`): AUTO groups also pick non-hostile NPCs and non-own structures
in reach + arc (never players); usually paired with `instantLock`. Integration: `harness.lockTarget(playerId, target, groupId?)` →
`_internals.forceLock`. E2E: `tests/e2e/helpers` `lockOn`.
testMode room option `lockTimeCapS: N` (or the room-creating client's join
option / URL `?lockTimeCapS=N`, `TestClientOpts.lockTimeCapS`): no NON-player
lock in the room takes longer than N seconds while the target is in reach
(0 = the first lock step): NPC drones and capitals on pilots
(`NpcLockSubsystem`), capital turrets on structures (`WeaponMountTicker`) and
structure / coastal turrets (`StructureMountTicker`). A lock the rules call
impossible (past `maxSeconds`) but in reach locks in N too; out of reach stays
unlockable. The math is `capLockSeconds` (`core/combat/lockTime.ts`). For tests
and recordings that need the big guns locked without the long (by design)
wait. Player locks keep `instantLock`: an N-second player cap would make the
client's predicted lock ring (`lockSeconds`, #15) disagree with the server.
testMode join option `groupMode: 'manual'` (URL `?groupMode=manual`,
`TestClientOpts.groupMode`): every weapon group of that pilot starts in MAN, so
AUTO (which `anyTarget` widens to any target) never kills a fragile target
before the test switches the group it wants to AUTO or locks it.

## Server

| Piece | File | Role |
|---|---|---|
| Lock time | `core/combat/lockTime.ts` | Pure `lockSeconds(inputs, tuning)`; Infinity = can't lock now. secs = base × size × tracking × range ÷ (sensor × pilot). Range: small guns (none/AA/S) use the share of their reach (`1 + 0.6 × range/reach`); heavy M/L/XL guns (`WEAPON_LOCK_PROFILE[size].absRange`) use ABSOLUTE distance, `1 + (range / 7000)^1.5` (owner 2026-11-10: "speed, size and distance"; "it should take ages to lock"). The `maxSeconds` (8 s) "can't lock" test reads the reach-share time only, so distance makes a heavy lock slower, never impossible: a 16" on a battleship takes ~2.5 s at 4k u, ~10 s at 20k, ~17 s at 30k. Structures (`clampAtMax`) cap the size/speed part at 8 s, then a heavy gun still stretches it for distance |
| Lock state | `core/combat/lockState.ts` | `LockEntry` + `stepLock`: failsafe → acquiring → locked; `track` = commit / held / released (released drains at `decayMul`× and drops at 0) |
| Player locks | `server/rooms/LockSubsystem.ts` | Per pilot, per group: queue (capacity 1 sub-capital, 3 capital), AUTO pick (arc-filtered), `requestLock` (commit), `trackLock` (held line), `cancelLock`, `setMode`; stepped every 6 ticks |
| NPC locks | `server/rooms/NpcLockSubsystem.ts` | Every NPC hostile to a tracked pilot builds a lock on them by the same rules; `fireBlocked(npcId, targetId)` refuses a drone shot at a pilot target it has not completed a lock on (the target id rides `intent.fire.targetId`; non-pilot targets are not gated); `WeaponMountTicker.tickCapitalMounts` asks the same question per capital turret with that turret's own target. A capital's lock time is the fastest over its per-mount-size profiles; testMode `instantLock` on a pilot completes NPC locks on them in reach |
| Player fire gate | `PlayerFireResolver` deps `fireAllowed` + `mountBearsOnLock` | A group fires only with a LOCKED target, and only mounts whose barrel is within `FC_MOUNT_FIRE_TOLERANCE` (0.2 rad) of it; otherwise refused without spending cooldown or energy |
| Turret aim | `WeaponMountTicker.tickPlayer` → `LockSubsystem.aimKeyFor` | Each mount slews toward its group's locked (else acquiring) target; no target ⇒ home. With several locks (capitals) the turrets share them out via the shared `pickTurretLock` (`core/combat/turretLockPick.ts`): turret *i* of the group prefers lock *i mod n*, else the next lock round the list it can engage (reach + arc), else the first. The client's predicted aim and ghost gate (`fcMountAimKey`) call the same function (#15) |
| Naval reach switch | `shared-types/combat/navalRange.ts` + `navalGuns.ts` | `EQX_NAVAL_RANGE=real` (client `?navalRange=real`) gives every `naval_*` gun its real range as its engage reach (16" 38,700 u, Lindemann 56,000 u) and flight real ÷ 3. Lock reach (`reach × reachSlack`) and the absolute-distance lock time follow; a 16" lock at 30 km takes ~17 s. Off by default; both sides read it, the welcome carries it (#15). See [real-scale-ranges.md](real-scale-ranges.md) |
| Capital fire cadence | `PlayerFireResolver` (per-mount ledger) + `ColyseusClient.fcFireMounts` | Capitals (`hasTurretFireControl`) fire each turret on its OWN weapon reload as soon as it bears on its own target; the group fire carries only the reloaded, bearing mounts and pays that share of the group energy cost. A multi-barrel turret is one mount, so its barrels still fire together. Other ships keep the one group cooldown |

**Messages** (strict zod, `clientMessages.ts`): `lock_request {groupId, target}`
(commit), `lock_track {groupId, target | null, b?}` (the held line and its
bearing; sent only when its target changes), `lock_cancel {groupId, target?}`,
`set_group_mode`.
Target keys: `s:<entityId>` (swarm) or `p:<playerId>`.

**Snapshot (#16), own active pilot only, shared refs mutated in place:**
- `states[].groups`: `[{id, m: 0 auto | 1 manual, l: [{t, s: 0 failsafe | 1 acquiring | 2 locked, p: 0..100, r?: 1 released}]}]`
- `states[].lockedBy`: `[{t, s: 1 | 2, p}]`: NPCs locking the pilot.

## Client

- `ColyseusClient`: `applyFcGroups` (store summary written only when ids, modes,
  targets or stages change), `localLockedBy` into the render mirror,
  `guideLock(bearing)` / `releaseLockGuide()` (send `lock_track` on change; the
  stick and mouse re-check 10×/s while held so a moving target stays held),
  `lockSelected()`, `fcFireTick` (THE client fire path; mirrors the server fire
  gate via `fcGroupBears`), `fcTickMountAngles` (THE client mount-angle path,
  #12). The `groups` / `lockedBy` slices are always applied.
- `AimFeedbackRenderer.drawFireControl`: your locks (closing ring, ticks,
  LOCKING / FAILSAFE / LOSING LOCK tag, dashed link; brackets + firing line when
  locked) and NPC locks on you (arcs, carets, diamonds). While anything is
  locking or has locked you, the whole threat ring is also drawn faintly
  (thin, low-alpha red) under the arcs, so a lone arc reads as a pointer on a
  ring centred on your ship rather than a reticle floating beside it (owner's
  choice 2026-11-10; lock: `AimFeedbackRenderer.test.ts`). Tag text is rebuilt only
  when its value changes (#14). Every mark on a target (ring, brackets,
  diamond, candidate ring) is placed by the pure `lockMarkFrame`: hull-sized
  and centred round anything that fits, but capped at
  `LOCK_MARK_MAX_SCREEN_HALF` (120 px) and moved onto the target's keel line at
  the point nearest you when the hull is bigger than that (a capital at normal
  zoom). The threat ring round your own ship is capped at 220 px
  (`threatRingRadius`). Before this a battleship's lock diamond was two screens
  wide: two stray red lines (showcase `capital-guns-fighter`, 2026-11-10).
  Lock: `lockMarkFrame.test.ts`.
- HUD: `WeaponStrip`, `LockStatusBand` (polls the mirror at 10 Hz, re-renders on
  change), `TargetAction` (LOCK / CANCEL LOCK / UNLOCK), `MouseLock` (desktop).
- Contacts overview (`ContactsOverview`, O key / CONTACTS tab, left edge): an
  EVE-style list of lockable contacts with distance, reach and lock state;
  a tap sends `lock_request` for the active group, a tap on its own lock
  sends `lock_cancel`. Reach is `fcGroupReach` × `reachSlack`. See
  [contacts-overview.md](../features/contacts-overview.md).

## Tests

- Unit: `lockTime.test.ts`, `LockSubsystem.test.ts` (held/drain/resume, arc-aware
  AUTO), `LockStatusBand.test.ts`, `WeaponStrip.test.tsx`, `MouseLock.test.ts`,
  `tests/unit/fireControlWireParity.test.ts`.
- Integration: `fireControlLocks.test.ts`, `npcLocks.test.ts` (fails with the NPC
  gate removed), `fireControlArc.test.ts` (fails without the arc gate).
- Unit: `lockLine.test.ts` (the shared lock-line rule); `LockSubsystem.test.ts`
  also covers `lock_track` verification, `instantLock` and `forceLock`.
- Integration: `fireControlLocks.test.ts` "a pilot who joined with no options
  cannot fire without a lock".
- E2E (feature tier): `fire-control-lock.spec.ts`, `lock-to-fire-default.spec.ts`
  (a default join cannot fire before a lock and fires after LOCK).

Open work: [docs/handoff/fire-control-to-be-continued.md](../handoff/fire-control-to-be-continued.md).

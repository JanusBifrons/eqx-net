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
join option and the `?ui=` HUD switch were removed. NPC capitals' per-turret
fire and structure turrets are not lock-gated yet (PR 1d).

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
AUTO groups also lock non-hostile NPCs and non-own structures in reach + arc, and
every lock completes on the next step (a failsafe still commits its hostile
act). Integration: `harness.lockTarget(playerId, target, groupId?)` →
`_internals.forceLock`. E2E: `tests/e2e/helpers` `lockOn`.

## Server

| Piece | File | Role |
|---|---|---|
| Lock time | `core/combat/lockTime.ts` | Pure `lockSeconds(inputs, tuning)`; Infinity = can't lock now |
| Lock state | `core/combat/lockState.ts` | `LockEntry` + `stepLock`: failsafe → acquiring → locked; `track` = commit / held / released (released drains at `decayMul`× and drops at 0) |
| Player locks | `server/rooms/LockSubsystem.ts` | Per pilot, per group: queue (capacity 1 sub-capital, 3 capital), AUTO pick (arc-filtered), `requestLock` (commit), `trackLock` (held line), `cancelLock`, `setMode`; stepped every 6 ticks |
| NPC locks | `server/rooms/NpcLockSubsystem.ts` | Every NPC hostile to a tracked pilot builds a lock on them by the same rules; `fireBlocked` refuses an NPC shot at an unlocked tracked pilot in its line of fire |
| Player fire gate | `PlayerFireResolver` deps `fireAllowed` + `mountBearsOnLock` | A group fires only with a LOCKED target, and only mounts whose barrel is within `FC_MOUNT_FIRE_TOLERANCE` (0.2 rad) of it; otherwise refused without spending cooldown or energy |
| Turret aim | `WeaponMountTicker.tickPlayer` | Each mount slews toward its group's locked (else acquiring) target; no target ⇒ home |

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
  locked) and NPC locks on you (arcs, carets, diamonds). Tag text is rebuilt only
  when its value changes (#14).
- HUD: `WeaponStrip`, `LockStatusBand` (polls the mirror at 10 Hz, re-renders on
  change), `TargetAction` (LOCK / CANCEL LOCK / UNLOCK), `MouseLock` (desktop).

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

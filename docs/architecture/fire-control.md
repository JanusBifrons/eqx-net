# Fire control: weapon groups, locks and the fire gate

Player-facing behaviour: [docs/features/weapon-groups-and-locking.md](../features/weapon-groups-and-locking.md).

## Opt-in

A client joins with `fireControl: true` (set by `?ui=d`, `gameSurfaceBootstrap`).
The server then tracks that pilot in `LockSubsystem` and NPCs must lock them
(`NpcLockSubsystem`). Everyone else plays the legacy rules: `hasLocked()` returns
true for untracked players and the NPC fire gate only considers tracked pilots.

## Server

| Piece | File | Role |
|---|---|---|
| Lock time | `core/combat/lockTime.ts` | Pure `lockSeconds(inputs, tuning)`; Infinity = can't lock now |
| Lock state | `core/combat/lockState.ts` | `LockEntry` + `stepLock`: failsafe → acquiring → locked; `track` = commit / held / released (released drains at `decayMul`× and drops at 0) |
| Player locks | `server/rooms/LockSubsystem.ts` | Per pilot, per group: queue (capacity 1 sub-capital, 3 capital), AUTO pick (arc-filtered), `requestLock` (commit), `trackLock` (held line), `cancelLock`, `setMode`; stepped every 6 ticks |
| NPC locks | `server/rooms/NpcLockSubsystem.ts` | Every NPC hostile to a tracked pilot builds a lock on them by the same rules; `fireBlocked` refuses an NPC shot at an unlocked tracked pilot in its line of fire |
| Player fire gate | `PlayerFireResolver` deps `fireAllowed` + `mountBearsOnLock` | A group fires only with a LOCKED target, and only mounts whose barrel is within `FC_MOUNT_FIRE_TOLERANCE` (0.2 rad) of it; otherwise refused without spending cooldown or energy |
| Turret aim | `WeaponMountTicker` fire-control branch | Each mount slews toward its group's locked (else acquiring) target |

**Messages** (strict zod, `clientMessages.ts`): `lock_request {groupId, target}`
(commit), `lock_track {groupId, target | null}` (the held line; sent only when
its target changes), `lock_cancel {groupId, target?}`, `set_group_mode`.
Target keys: `s:<entityId>` (swarm) or `p:<playerId>`.

**Snapshot (#16), own active pilot only, shared refs mutated in place:**
- `states[].groups`: `[{id, m: 0 auto | 1 manual, l: [{t, s: 0 failsafe | 1 acquiring | 2 locked, p: 0..100, r?: 1 released}]}]`
- `states[].lockedBy`: `[{t, s: 1 | 2, p}]`: NPCs locking the pilot.

## Client

- `ColyseusClient`: `applyFcGroups` (store summary written only when ids, modes,
  targets or stages change), `localLockedBy` into the render mirror,
  `guideLock(bearing)` / `releaseLockGuide()` (send `lock_track` on change; the
  stick and mouse re-check 10×/s while held so a moving target stays held),
  `lockSelected()`, `fcFireTick` (mirrors the server fire gate via
  `fcGroupBears`), `fcTickMountAngles` (predicted turret aim, #12).
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
- E2E (feature tier): `fire-control-lock.spec.ts`, `hud-variants.spec.ts` (`ui=d`).

Open work: [docs/handoff/fire-control-to-be-continued.md](../handoff/fire-control-to-be-continued.md).

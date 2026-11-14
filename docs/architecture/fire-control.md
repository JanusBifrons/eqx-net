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
that pilot fastest, so its AA engages a fighter quickly. An NPC ship's locks use
exactly the rule and numbers a player ship of the same kind with the same gun
gets on the same target (owner decision 2026-11-13: "Same rule as players — an
NPC's heavy gun locks a small fast ship slowly, but always gets there in the
end. It's the same ship and the same gun, so it gets the same lock."): a
battleship whose 16" guns alone reach a still fighter 5 km out locks it in
~38 s, where before it never could. A capital turret whose
target is a hostile STRUCTURE fires only with its own completed turret lock on
it (same `lockSeconds` rules: the mount size's profile, the hull's sensor, the
structure's radius as signature). Structure turrets lock their targets too
(PR 1d slice 3, `StructureMountTicker`).

**Locks work at any distance** (owner decision 2026-11-14). Players, NPC
ships and structures (coastal guns, defence turrets) can lock at any distance.
Distance only makes a lock SLOWER (the range terms of `lockSeconds` stay), never
impossible, and a lock never drops for being far. Only FIRING is range-limited:
each turret's own reach to the target's true hull (`mountInReach`, the per-mount
gates in the fire paths). So:
- `lockSeconds` / `capLockSeconds` have no reach gate; Infinity now means only
  "can't track" (too small or fast for the gun, past `maxSeconds`) or no gun. A
  small gun's reach-share term saturates at its reach (`min(1, range/reach)`),
  so past reach it locks as at the edge of reach and its "can't track" test
  reads size and crossing speed only. Heavy guns keep the uncapped
  absolute-distance term.
- The lock line (`lockLineScore`, client pick AND server `lock_track` check,
  #15) has no length cap; the reach only scales its near-first tie-break.
- The wire `c` flag means "can't track"; the HUD button reads CAN'T TRACK (was
  OUT OF RANGE). The contacts list's reach mark is the group's FIRE reach (no
  lock slack), not a lock limit.
- **AUTO releases out of fire range (lead call).** `LockSubsystem.stepGroup`
  drops an AUTO group's OWN pick once no mount of the group reaches the target's
  hull within reach × `LOCK_TUNING.reachSlack` (`LockSubsystem.inFireRange`:
  the player fire gate's own range half `mountReachesTarget` per mount; the
  slack is hysteresis over the in-reach `autoPick`), and
  the group re-picks. Without it AUTO would sit forever on a target it can't
  shoot (it only re-picks with no locks). A lock the pilot asked for (manual,
  or the lock line) persists at any distance. AUTO's pick itself stays limited
  to targets it could fire at (`autoPick`: reach + `bears`).
- **Hostility needs fire range (lead call).** A lock alone no longer keeps an
  NPC hostile: a player's lock (`SectorRoom.refreshLockHostility`) and the
  NPC's own lock (`NpcLockSubsystem`) re-stamp hostility only while the pilot
  is inside that NPC's FIRE range (`mountsReachTarget` over the NPC's mounts to
  the pilot's hull). Out of its fire range nothing refreshes and the NPC
  forgets the pilot 30 s later, even with a lock held. Hits are unchanged.
- **A capital's one lock per pilot** is built by the fastest profile whose guns
  may reach the pilot (`mayBeInReach`, reach × slack); with none in reach, by
  its LONGEST-reach profile (the gun that reaches them first). Otherwise its AA,
  whose reach-share term saturates, would lock a fighter 60 km out in seconds
  and license the 16" the moment it closed.
- Locks: `lockTime.test.ts`, `lockTime.cap.test.ts`, `lockLine.test.ts`,
  `mountReach.fireRange.test.ts`, `LockSubsystem.test.ts` ("far past every
  weapon's reach", "does not drop", "AUTO releases"), `NpcLockSubsystem.test.ts`
  ("locks at any distance", "outside it the lock holds but the refresh stops"),
  `capitalLockGate.test.ts`, `ColyseusClient.longRangeLock.test.ts`,
  `TargetAction.test.tsx`, `contactRows.test.ts`.

**Locks keep it hostile** (owner decision 2026-11-10). Being targeted is a
hostile act. An NPC ship stays hostile to a pilot while any of that pilot's
weapon groups is LOCKING (acquiring) or LOCKED on it, and for the usual 30 s
(`FORGET_TICKS`) after the lock drops (since 2026-11-14: after the pilot leaves
the NPC's fire range, see "Locks work at any distance"): every lock step, `LockSubsystem` calls
`refreshHostility` for each live lock past its failsafe on a hostile target, and
the room re-stamps the NPC's ledger entry (`SectorRoom.refreshLockHostility` →
`aiController.markHostile`). Before this, an NPC forgot the pilot 30 s after the
last HIT, and a 16" shell flies ~30 s at real-scale range, so a battleship
dropped its lock between salvos and stopped firing.
- **Starting a lock on a non-hostile NPC** is the failsafe, unchanged: the
  failsafe ring is slower and harmless if cancelled; finishing it is the hostile
  act (`commitHostileAct`: ledger + `bot_aggro` + the `lock_hostile_act` log).
  From then the lock refreshes like any other.
- **No faction escalation from a lock.** Refreshing and the failsafe commit
  touch only that NPC's individual hostility; only a HIT on a drone escalates
  the `FactionLedger`. A draining (released) lock doesn't refresh.
- **Client (#16):** nothing new on the wire. The NPC's hostility to the viewer
  rides the snapshot `drones[].hostile` bit, so radar colours follow.
- **AUTO keeps it going:** an AUTO group re-picks the nearest hostile NPC, so a
  pilot who stays in reach with AUTO groups keeps that NPC hostile. Since
  2026-11-12 the NPC's own lock does too (below), so only leaving its FIRE
  range lets it forget, 30 s later.
- Lock: `LockSubsystem.test.ts` "locks keep it hostile",
  `tests/integration/sectorRoom/lockKeepsHostile.test.ts`.

**An attacking NPC stays hostile** (owner decision 2026-11-12: "Its own lock
and its own hits on you also keep it hostile; it forgets you 30 s after it last
hit or held a lock on you"). Hostility to a pilot now decays 30 s after the
LATEST of four things: the pilot's last hit on the NPC, the pilot's last lock
on it, the NPC's last hit on the pilot, and the NPC's last held lock on the
pilot. Before this, a battleship cued by one `test_aggro` against a passive
pilot forgot them 30 s after the cue, partway through its 30 s 16" reload: one
volley, then its turrets went home.
- **Its own lock:** every NPC lock step (`NpcLockSubsystem`, drones and NPC
  capitals alike, robots too since they share it), an NPC that is LOCKING or
  LOCKED on a pilot inside its fire range calls the `refreshHostility` dep →
  `SectorRoom.refreshNpcAttackHostility` → `aiController.markHostile`.
- **Its own hits:** `SectorRoom.applyDamage` calls the same method when the
  target is a pilot (`playerToSlot`) and the damage is > 0, with the shooter as
  the NPC (a capital's shells carry the drone id as owner internally).
- **Refresh only, never a new grudge:** both paths re-stamp only when the NPC
  already holds the pilot in its hostility LEDGER (`isEntityHostileToPlayer(…,
  truce = true)`), so on-sight stance (robots) never becomes ledger hostility
  and a truce still ends it. No `bot_aggro`, no faction escalation (#16: the
  `drones[].hostile` bit carries it).
- **No feedback loop:** the NPC's lock refreshes hostility only while the pilot
  is inside its fire range; out of fire range its lock may hold (locks work at
  any distance) but it forgets the pilot 30 s later, and once it is no longer
  hostile it isn't visited and the lock drops after the 1.5 s grace. A dead or
  departed pilot has no pose, so every lock on them clears at once.
- Structures and structure turrets keep their own rules (hostile acts).
- Locks: `NpcLockSubsystem.test.ts` "its own lock keeps the NPC hostile",
  `tests/integration/sectorRoom/npcStaysHostileWhileAttacking.test.ts` (second
  16" volley after the reload; leaves reach ⇒ forgets, turrets home; no aggro ⇒
  never targeted).

**Trust.** The server never takes the client's word for a lock:
- `lock_track` carries the lock line's bearing (`b`, `encodeAim`); the server
  holds the target only when it lies on that line by the shared rule
  `lockLineScore` / `lockLineHolds` (`core/combat/lockLine.ts`, the same function
  the client picks with; the server uses the sticky cone to absorb display delay
  and quantisation). A claim off the line or without `b` counts as "on
  nothing" (no length cap since 2026-11-14: locks work at any distance).
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
lock in the room takes longer than N seconds, at any distance
(0 = the first lock step): NPC drones and capitals on pilots
(`NpcLockSubsystem`), capital turrets on structures (`WeaponMountTicker`) and
structure / coastal turrets (`StructureMountTicker`). A lock the rules call
impossible (past `maxSeconds`, sub-capital guns) or very slow locks in N too;
only a shooter with no gun stays unable to lock. The math is `capLockSeconds` (`core/combat/lockTime.ts`). For tests
and recordings that need the big guns locked without the long (by design)
wait. Player locks keep `instantLock`: an N-second player cap would make the
client's predicted lock ring (`lockSeconds`, #15) disagree with the server.
testMode join option `groupMode: 'manual'` (URL `?groupMode=manual`,
`TestClientOpts.groupMode`): every weapon group of that pilot starts in MAN, so
AUTO (which `anyTarget` widens to any target) never kills a fragile target
before the test switches the group it wants to AUTO or locks it.

### Range to the hull, not the centre (player fire gate)

Owner decision 2026-11-14: fire range is measured from each turret (its mount's
world position) to the nearest point of the target's true hit shape, not
centre to centre (a battleship's AA, reach ~1,428 u, could not reach another
battleship with hulls touching). `shipHullDistance(kindId, shieldUp, px, py,
cx, cy, angle)` in `src/core/combat/shipHitShape.ts` gives that distance (0
inside), against the same shape the hits use: a capital's hull polygon
(`shipCollisionParts`, the one `capitalHits` / `shipRayHit` refine against), a
non-capital's shield bubble with its shield up, its hull polygon with it down.
The polygon maths is `pointToShipPolygonDistance` in `Weapons.ts`, beside
`rayHitsShipPolygon`. Fire gates call `shipWithinHullReach(..., reach)`: it
first rejects on the cheap bounding circle (`centreDist > shipHitBound + reach`
⇒ out, the polygon is never touched) and measures the hull only inside that
band. Both are allocation-free. Locks: `tests/unit/shipHullDistance.test.ts`
(beam vs bow, inside = 0, bubble, agreement with the capital ray hit, the far
reject never reading the polygon) and `shipHullDistance.heapDelta.test.ts`.

### NPC and structure turrets: range per mount, to the hull

Wired for every NPC and structure gun (the player gate: next section).
The ONE turret range gate is `mountInReach(dx, dy, reach, target)` in
`src/core/combat/mountReach.ts`: (dx, dy) is the target's centre from the
MOUNT's world origin, `reach` that mount's own `mountWeaponReach`, and `target`
a `MountRangeTarget` (a ship's `kindId` + `angle` + `shieldUp` ⇒
`shipWithinHullReach`; anything else a circle of `radius`; absent ⇒ the
centre). Callers:

- `mountCanEngage` (capital turrets in `WeaponMountTicker.tickCapitalMounts`,
  structure turrets in `StructureMountTicker`) takes the target view as its
  last argument. `MountTargetView` and `TurretTargetView` carry the shape
  (`kindId`, `angle`, `shieldUp`, `radius`); the room fills it for pilots
  (`ship.shield > 0`), swarm ships (`!rec.shieldDown`) and structures
  (`rec.radius`, the radius the lock code already uses).
- `AiFireResolver` (drones' slot fire): a mount fires only when the target's
  hull is within its reach (`bearingMask`, with the room's `targetShape` dep).
  A lock no longer licenses a shot from any distance; out of reach the shot
  is held and no cooldown is spent.
- `pickTurretLock` (the player lock share-out, server and client) uses the same
  `mountInReach`, with per-lock shapes from `resolveLockTarget` /
  `fcTargetShape` (#15).

Candidate searches widen by the target's bound so a hull in reach whose centre
isn't is still a candidate: `mayBeInReach(dx, dy, reach, t)` (centre within
reach + `mountRangeBound(t)`). The room's structure-turret gather queries its
grid at `reach + maxShipRangeBound()` and keeps only `mayBeInReach` candidates;
the non-capital drone slew pick passes `reachToHull: true` to `pickTarget`.
Cost (laptop, 2026-11-14): `turretGather.count.test.ts` real 60 hostiles /
40 km 127 → 134 candidates per tick (budget 160). Locks:
`tests/unit/npcTurretHullRange.test.ts` (battleship AA vs a battleship
alongside, a drone holding fire beyond reach with a lock, a coastal barbette vs
a bow-on battleship), `turretLockPick.test.ts`.

Not yet hull-based: lock time (`lockSeconds`, centre distance; locks have no
reach gate at all since 2026-11-14) and the drone brain's own `fireRange`
decision still measure centre to centre.

### Player fire gate: range per mount, to the hull

**Wired into the PLAYER fire gate.** `core/combat/fireControlBearing.ts` holds
the whole per-mount gate, `mountFiresOn(weaponId, reach, ox, oy, angle, t)` =
`mountReachesTarget` (range) AND `mountBearsOn` (bearing). The range half
measures from the mount's world origin to the target's hit shape against that
mount's own `mountWeaponReach` (`weaponIdReach(weaponId)` when only the id is
at hand): a ship (any pilot) via `shipWithinHullReach`, anything else
(structures) as centre distance − its lock `signature` (its radius). The target
is a `FireTargetShape` (pose, heading, `ship`, `kindId`, `shieldUp`,
`signature`), filled on both sides by the one `fillFireTargetShape`: the server
in `SectorRoom.resolveLockTarget` (swarm record `shipKind` / `!shieldDown` /
`radius`; a pilot's `ShipState.kind` / `shield > 0`), the client in
`ColyseusClient.fcTargetPose` (swarm wire `shipKind` / `shieldDown` / `radius`;
the ship mirror's `kind` / `shieldDown`). `LockTargetView` extends it.

Who calls it: the server's `SectorRoom.mountBearsOnLock` (→ `PlayerFireResolver`
per mount), and the client's `fcGroupBears` (non-capital groups), `fcFireMounts`
(capital per-turret salvo) and `fcMountBears` (ghost gate). The client's old
centre-to-centre `reach × 1.1` checks are gone; the server had no range check
at all (fire range came only from the lock's centre-measured reach). A mount out
of reach is refused like one off bearing: no cooldown, no energy. **AUTO pick**
(`LockSubsystem.bears`) uses the same range half per mount, with the mount's
ARC as the angular half (a turret trains onto what AUTO picks; the fire gate
then checks its barrel); the client has no AUTO pick of its own.

NPC / structure turret fire is the section above. Lock reach: none since
2026-11-14 (locks work at any distance; see "Locks work at any distance").
Locks:
`tests/integration/sectorRoom/playerTurretFireRange.test.ts` (AA fires at a
battleship alongside, centres 1.7 km apart; a drone out of every AA mount's
reach is refused with no energy spent), `src/client/net/ColyseusClient.fireRange.test.ts`
(client salvo = the shared gate's set for the server's target view; shape-fill
parity), `tests/unit/fireControlBearingParity.test.ts` (both sides call
`mountFiresOn` + `fillFireTargetShape`, never a bare `mountBearsOn`).

## Server

| Piece | File | Role |
|---|---|---|
| Lock time | `core/combat/lockTime.ts` | Pure `lockSeconds(inputs, tuning)`; Infinity = can't lock now (can't track, or no gun; no reach gate since 2026-11-14, see "Locks work at any distance"). secs = base × size × tracking × range ÷ (sensor × pilot). Range: small guns (none/AA/S) use the share of their reach (`1 + 0.6 × range/reach`); heavy M/L/XL guns (`WEAPON_LOCK_PROFILE[size].absRange`) use ABSOLUTE distance, `1 + (range / 7000)^1.5` (owner 2026-11-10: "speed, size and distance"; "it should take ages to lock"). The `maxSeconds` (8 s) "can't lock" test reads the reach-share time only, so distance makes a heavy lock slower, never impossible: a 16" on a battleship takes ~2.5 s at 4k u, ~10 s at 20k, ~17 s at 30k. Structures (`clampAtMax`) cap the size/speed part at 8 s, then a heavy gun still stretches it for distance. A SHIP's heavy gun (`absRange` under ship tuning, i.e. not `clampAtMax`) skips the 8 s test entirely: a small or fast target locks slowly, never impossibly (owner 2026-11-10: "10 minutes or an hour … working as intended"). This holds for EVERY ship, player or NPC (`LockSubsystem`, `NpcLockSubsystem`, `WeaponMountTicker` capital turret on a structure): one rule, no per-pilot flag (owner 2026-11-13: "It's the same ship and the same gun, so it gets the same lock"; the old player-only `neverImpossible` flag is gone). Lock: `tests/unit/npcLockParity.test.ts` |
| Lock state | `core/combat/lockState.ts` | `LockEntry` + `stepLock`: failsafe → acquiring → locked; `track` = commit / held / released (released drains at `decayMul`× and drops at 0) |
| NPC locks | `server/rooms/NpcLockSubsystem.ts` | Every NPC hostile to a tracked pilot builds a lock on them by the same rules; `fireBlocked(npcId, targetId)` refuses a drone shot at a pilot target it has not completed a lock on (the target id rides `intent.fire.targetId`; non-pilot targets are not gated); `WeaponMountTicker.tickCapitalMounts` asks the same question per capital turret with that turret's own target. A capital's lock time is the fastest over its per-mount-size profiles that may reach the pilot, else its longest-reach profile; locks at any distance; testMode `instantLock` on a pilot completes NPC locks on them at any distance |
| Player locks | `server/rooms/LockSubsystem.ts` | Per pilot, per group: queue (capacity 1 sub-capital, 3 capital), AUTO pick (a mount's arc + that mount's range to the target's hit shape), `requestLock` (commit), `trackLock` (held line), `cancelLock`, `setMode`; stepped every 6 ticks |
| Player fire gate | `PlayerFireResolver` deps `fireAllowed` + `mountBearsOnLock` | A group fires only with a LOCKED target, and only mounts that pass the shared `mountFiresOn`: the target's hit shape within the mount's own reach, measured from the mount, and the barrel bearing on it (`mountBearsOn`); otherwise refused without spending cooldown or energy |
| Turret aim | `WeaponMountTicker.tickPlayer` → `LockSubsystem.aimKeyFor` | Each mount slews toward its group's locked (else acquiring) target; no target ⇒ home. With several locks (capitals) the turrets share them out via the shared `pickTurretLock` (`core/combat/turretLockPick.ts`): turret *i* of the group prefers lock *i mod n*, else the next lock round the list it can engage (reach + arc), else the first. The client's predicted aim and ghost gate (`fcMountAimKey`) call the same function (#15) |
| Naval reach switch | `shared-types/combat/navalRange.ts` + `navalGuns.ts` | `real` (the default since 2026-11-14) gives every `naval_*` gun its real range as its engage reach (16" 38,700 u, Lindemann 56,000 u) and flight real ÷ 3. The absolute-distance lock time follows; a 16" lock at 30 km takes ~17 s. `EQX_NAVAL_RANGE=legacy` (client `?navalRange=legacy`) opts back into the old reaches; both sides read it, the welcome always carries it (#15). See [real-scale-ranges.md](real-scale-ranges.md) |
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
  LOCKING / FAILSAFE / LOSING LOCK tag, dashed link, drawn ONCE per target:
  when several groups build a lock on the same ship only the one ranked by
  `acquiringRank` (building beats draining, then furthest along) is drawn, the
  same pick as the banner's own row (fight-clip review 2026-11-13: two stacked
  tags); brackets + firing line when
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
  A capped 1.2x diamond still boxed a random slice of the hull ("weird and
  misplaced", owner 2026-11-12), so on a capital the threat diamond is now a
  ~14 px pin on the keel point nearest you (`threatDiamondHalf`); fighters keep
  the hull-framing one. When the threat's hull (a capsule: keel ± half beam,
  `hullHalfBeam`) is closer than the ring, the threat arc and caret are pulled
  in to the gap, caret tip clear of the hull, or hidden if under 40 px
  (`threatPointerRadius`); the faint full ring stays.
  Lock: `lockMarkFrame.test.ts`.
- HUD: `WeaponStrip`, `LockStatusBand` (polls the mirror at 10 Hz, re-renders on
  change), `TargetAction` (LOCK / CANCEL LOCK / UNLOCK), `MouseLock` (desktop).
- Contacts overview (`ContactsOverview`, O key / CONTACTS tab, left edge): an
  EVE-style list of lockable contacts with distance, reach and lock state;
  a tap sends `lock_request` for the active group, a tap on its own lock
  sends `lock_cancel`. Reach is the group's fire reach `fcGroupReach` (locks work at any distance). See
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

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

### Active slot selection + energy (weapons/energy/AI overhaul, 2026-06-01)

The per-weapon picker is GONE. Each ship fires its **catalogue-bound loadout** (scout/fighter/heavy/gunship → bolts, interceptor → beams, missile-frigate → missiles); the server ignores any claimed `weapon` field (Step 3). The pilot now selects the active **weapon slot**, not the weapon type.

- `activeSlotId: string` is in Zustand (discrete UI selection — purity-clean). Slot selection lives in the **weapon-slot action of [SpeedDialMenu](../../src/client/components/SpeedDialMenu.tsx)** (`data-testid="slot-selector"`, `data-slot-id` = the hot slot) — it cycles to the next of the local ship's `slots`; today every gameplay ship has one slot so the cycle is a no-op affordance, forward-compatible with multi-slot kinds. (Pre-2026-06 this was a standalone `SlotSelector.tsx` `ToggleButtonGroup`; the speed-dial refactor consolidated it.) `Keyboard.ts` no longer binds 1/2/Q. `setActiveSlotId` clears `lastFireMs` so a slot swap resets the cooldown gate.
- `ColyseusClient.tickPhysics()` derives the firing weapon from the active slot's first mount (`localShipMounts()` → `resolveSlotMounts(kind, activeSlotId)`), computes the slot cooldown as the **max** over the slot's mounts, and clears `liveBeam` when the slot's weapon isn't hitscan. `sendFire()` spawns each ghost with its mount's bound `weaponId` and sends `{ weapon: slotWeapon, slotId: activeSlotId }`.
- **Energy** is the local player's PREDICTED resource (`ColyseusClient.predEnergy`): regen + boost drain in `tickPhysics`, fire drain (once per slot trigger) in `sendFire`, hard-reconciled from `snap.states[localId].energy` each snapshot. Read per-frame by the GameHud status capsule's energy fill (`useEnergyFill`, top-center) via `getGameClient().getPredictedEnergy()` + a direct-DOM `scaleX` write — NEVER a per-frame Zustand write (Invariant #2). `energyMax` (the constant-per-kind denominator) is the one Zustand read, set on spawn. Local ghost fire/boost is gated on `canAfford(predEnergy, slotCost)` so prediction matches the server's gating. `data-energy-pct` is the E2E hook. Energy math is the shared pure `src/core/combat/Energy.ts`. Regression: [tests/e2e/energy-bar.spec.ts](../../tests/e2e/energy-bar.spec.ts) + reworked [tests/e2e/weapon-switching.spec.ts](../../tests/e2e/weapon-switching.spec.ts).

### Fire control (universal) + AUTO group mode + facing boost

Full story: [docs/architecture/fire-control.md](fire-control.md). There is ONE HUD ([hud/GameHud.tsx](../../src/client/hud/GameHud.tsx)); the `?ui=` variants, the legacy HUD panels, the auto-fire toggle and manual aim are gone.

- **Every weapon group fires only at a LOCKED target** (the server refuses any player shot without a completed lock). `ColyseusClient.fcFireTick` is the only client fire path: **AUTO** groups pick + lock hostile targets in reach/arc and fire on their own; **MAN** groups fire while their weapon-strip chip is held or Space on the active group. There is no auto-fire toggle and no free fire.
- **The own-ship `groups` / `lockedBy` snapshot slices are always applied** (`applyFcGroups` → Zustand `fcGroups` on change + `mirror.localGroups` / `localLockedBy`, #16).
- **Lock line (`updateLockGuide` / `guideLock`):** the pick uses the SHARED `lockLineScore` (`@core/combat/lockLine`), and `lock_track` carries `b` = `encodeAim(bearing)`; the server verifies the claim with the same rule (`lockLineHolds`, #15) and ignores a target without `b`. Sends only when group/key change. The pick is alloc-free per candidate (cached `s:`/`p:` keys, bound visitors). Lock: `ColyseusClient.lockGuide.test.ts`.
- **`fcTickMountAngles` is THE client mount-angle path** (via `tickLocalMountAim`, #12): each mount slews to its group's lock (locked, else acquiring) from the MIRROR pose, or back to base. The client sends no `aim` input any more. Lock: `ColyseusClient.liveBeamMountAimPose.test.ts`.
- **Input:** desktop `installMouseLock` (hold LMB = lock line, RMB = boost via `aimInput`, keys 1–9 group / Shift+1–9 AUTO⇄MAN / T lock selected / X clear); touch `installFcKeys` + the GameHud move stick and lock-line stick. `?instantLock=1` (testMode) makes locks complete instantly and `?anyTarget=1` (testMode) lets AUTO pick neutral NPCs/structures, for tests.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

### Fire control: lock-to-fire is universal (root invariant #19)

- **Every player is tracked** by `LockSubsystem` from `onJoin` (`locks.enable`) and forgotten on leave (`LeaveHandler.forgetLocks` → `locks.forget` + `npcLocks.forget`). `hasLocked()` is false for an untracked player. Never reintroduce a pass-through (`isEnabled`-style "legacy rules").
- **The fire gate** (`PlayerFireResolver` deps `fireAllowed` + `mountBearsOnLock`): a group fires only with a LOCKED target, and only the mounts that reach its hit shape from where they sit (own weapon reach, `mountReachesTarget`; see "Range to the hull") and whose barrel bears on it per the shared `mountBearsOn(weaponId, …)` (both: `mountFiresOn`) (`core/combat/fireControlBearing.ts`; the client's ghost pass calls the same, #15): naval shell guns must put the shot within `TURRET_FIRE_MISS` (60 u) of the target, the rule every NPC capital and coastal gun uses, and other guns keep `FC_MOUNT_FIRE_TOLERANCE` (0.2 rad). A flat 0.2 rad let a player's 16" turret fire while still training, ~6 km wide at 30 km (owner 2026-11-12, "missing by miles"; lock `playerNavalFireTolerance.test.ts`). (Separate turrets fire independently when each is on target and share the group's target; a multi-barrel turret fires all its barrels together); none bearing ⇒ `hit_ack { rejected }` with no cooldown or energy spent.
- **Turret aim:** `WeaponMountTicker.tickPlayer` aims each mount at its group's lock (locked, else acquiring) and homes it otherwise. A capital group with several locks shares them out per turret (`LockSubsystem.aimKeyFor` → shared `pickTurretLock`, same call as the client's `fcMountAimKey`, #15), and `mountBearsOnLock` tests each mount against ITS pick. Capital turrets fire on their own reload (`PlayerFireResolver` per-mount ledger, partial salvo pays its share of the energy); other ships keep the group cooldown. There is no player auto-target or manual-aim mount path.
- **Ship heavy guns lock small targets slowly, never impossibly, whoever flies the ship** (owner 2026-11-10: "10 minutes or an hour … working as intended"; owner 2026-11-13: "Same rule as players — an NPC's heavy gun locks a small fast ship slowly, but always gets there in the end. It's the same ship and the same gun, so it gets the same lock."): `lockSeconds` skips the `maxSeconds` gate for any heavy (M/L/XL, `absRange`) gun under ship tuning (`LOCK_TUNING`, no `clampAtMax`), so it keeps the finite size × tracking × absolute-distance time (no `c: 1` can't-lock flag, no drop). Player (`LockSubsystem`) and NPC (`NpcLockSubsystem`, `WeaponMountTicker` capital turret on a structure) take that ONE path; there is no per-pilot flag (the player-only `neverImpossible` is gone). Never add one back: a pilot difference is a bug. Sub-capital guns keep the `maxSeconds` rule; structures keep `clampAtMax` (fixed batteries are not ships, own tuning). Locks: `tests/unit/npcLockParity.test.ts` (NPC battleship 16" locks a fighter in the player time, then fires), `lockTime.test.ts`, `fireControlLocks.test.ts` "player heavy gun on a small target".
- **`lock_track` is verified**, not trusted: it carries the line bearing `b`; `LockSubsystem.trackLock` holds the target only when the shared `lockLineHolds` (`core/combat/lockLine.ts`, sticky cone, the client's own pick rule) accepts it. A failing claim (or no `b`) counts as "on nothing" and releases the held lock. Lock: `LockSubsystem.test.ts` "lock_track is verified".
- **Snapshot slices (#16):** own active pilot only, shared refs mutated in place: `states[].groups` (`LockSubsystem.wireFor`) and `states[].lockedBy` (`NpcLockSubsystem.wireFor`). Every pilot now gets them.
- **Test triggers:** testMode join options `instantLock` (every lock completes next step) and `anyTarget` (AUTO also picks non-hostile NPCs and non-own structures), `groupMode: 'manual'` (every group starts in MAN; `LockSubsystem.enable`) and `_internals.forceLock(pid, key, groupId?)` (integration `harness.lockTarget`). Use them; never add a test-only fire bypass. NON-player locks have the room option `lockTimeCapS` (testMode, zod-checked in `onCreate`, also a join option): `NpcLockSubsystem`, `WeaponMountTicker` (capital turret on a structure) and `StructureMountTicker` pass every lock time through `capLockSeconds`, so none takes longer than N s at any distance (0 = the first step). Lock: `tests/integration/sectorRoom/lockTimeCap.test.ts`.
- **Locks keep it hostile** (owner 2026-11-10): every lock step, a live (acquiring or locked, not draining) player lock on an NPC ship already hostile to that pilot re-stamps its hostility (`refreshHostility` dep → `SectorRoom.refreshLockHostility` → `aiController.markHostile`), so the 30 s `FORGET_TICKS` decay runs from when the lock drops. Individual hostility only: no `FactionLedger` escalation, no `bot_aggro` (the snapshot `drones[].hostile` bit carries it, #16). A lock on a non-hostile NPC still runs the failsafe first and commits as a hostile act. Lock: `tests/integration/sectorRoom/lockKeepsHostile.test.ts`.
- **An attacking NPC stays hostile** (owner 2026-11-12): the NPC's OWN lock (every `NpcLockSubsystem` step while locking or locked with the pilot inside its fire range; drones, capitals, robots) and its OWN hits on a pilot (`applyDamage`, pilot target, damage > 0) re-stamp its hostility via `SectorRoom.refreshNpcAttackHostility`, so decay runs 30 s from the latest of the pilot's hit/lock and the NPC's hit/lock. Refresh only: it needs the pilot already in the NPC's ledger (`isEntityHostileToPlayer(…, truce = true)`), so stance hostility never becomes a grudge. Out of its fire range the refresh stops (its lock may hold: locks work at any distance) and it forgets 30 s later. Lock: `tests/integration/sectorRoom/npcStaysHostileWhileAttacking.test.ts`, `NpcLockSubsystem.test.ts`.
- **Structure turrets lock too** (PR 1d slice 3): see "Defence fire control" below.
- **NPC drones fire only with a completed lock on their target** (PR 1d slice 1): `HostileDroneBehaviour` puts its AI target on `intent.fire.targetId`, threaded `AiFireRequest` → `handleAiFire` → `AiFireResolver.resolve` → `NpcLockSubsystem.fireBlocked(npcId, targetId)`. A pilot target needs that drone's completed lock (acquiring is not enough; a lock on another pilot doesn't count); non-pilot targets (NPCs, structures, displaced hulls) are not gated. Lock: `NpcLockSubsystem.test.ts`.
- **An AI pilot's shot leaves down its drawn barrel, and only a barrel that bears fires** (owner 2026-11-14, fight clips: "The turrets also aren't turning to shoot the direction they do"). `AiFireResolver.fireNow` fires EVERY mount at hull + `baseAngle` + its slewed `droneMountAngles` angle (0 for a fixed nose gun), the angle the client draws the gun and the remote beam at; `resolve` first builds a bearing mask (`barrelBearsOn` with `mountFireTolerance`, the player rule #19) and holds, spending no cooldown, when no barrel bears (a turret still training). A charge weapon fires the mounts that bore at the trigger pull, down their barrels at release. `HostileDroneBehaviour` pulls a fixed gun's trigger only inside `FC_MOUNT_FIRE_TOLERANCE` (turret kinds keep the wide cone + arc request) and exposes `aimPoint(out)`, its combat lead point this tick; `WeaponMountTicker.tickDrone` trains a non-capital drone's turrets on that point first (any target: a pilot, another faction's ship, a structure), falling back to the hostile-pilot pick. Before, turrets trained only on hostile pilots, so in ship-vs-ship fights they sat at rest while the pilot fired. **`swarmEntitySnapshot` fills ONE shared scratch**: copy the fields you need before any other lookup (a hit test inside the mount loop overwrote the shooter's pose, so a twin turret's second beam left from the target's pose). Locks: `tests/unit/aiTurretFacesShot.test.ts`, `tests/integration/sectorRoom/aiTurretFacesShot.test.ts`, client `tests/unit/aiTurretDrawnFollowsSnapshot.test.ts`.
- **Spectating doesn't dodge a fight** (owner 2026-11-12): the `spectate` handler records the parked hull in `spectateParkedHull` (cleared on reclaim, a new active hull, or leave). `engageablePilotHull(pid)` (predicate `isEngageablePilotHull`, `shipLiveness.ts`) resolves it for the NPC lock step (`pilotPose`), the drone/capital turret candidates (`visitParkedPilotHulls`), and the structure-turret pilot scans, all under the PILOT's id, so locks, `hostileTo` and `fireBlocked` keep working. A projectile sweeps a lingering hull with the same per-kind shape as an active ship (`ProjectilePipeline` `lingeringShip`), not the fighter `hitRadius`. A pilot CAPITAL (active or parked) is hit on its hull outline even with its shield up, like an NPC capital: its circle is half the hull's length, so shells used to burst ~2,000 u off a heavy cruiser's beam (lock `capitalShieldHugsHull.test.ts`). The parked hull itself stays passive: no active hull ⇒ `LockSubsystem.step` skips the pilot and fire messages have no shooter. Lock: `tests/integration/sectorRoom/spectateStillTargeted.test.ts`.
- **NPC capital turrets fire only with a completed lock on their own target** (PR 1d slice 2): `WeaponMountTicker.tickCapitalMounts` calls the `fireBlocked(droneId, mountTargetId)` dep (→ `NpcLockSubsystem.fireBlocked`) last, before spending the reload; a blocked turret keeps aiming. A capital holds one lock per pilot (entries are per pilot × NPC), and its lock time is the FASTEST over one profile per mount size (`geos`) that may reach the pilot (none in reach: the longest-reach profile), so AA locks a fighter fast while a 16" gun alone locks it slowly (~38 s at 5 km, the same as a player battleship). testMode `instantLock` on a pilot also completes every NPC lock on them at any distance (`NpcLockDeps.instantLock` → `LockSubsystem.isInstant`); capital integration tests use it. Lock: `tests/unit/capitalLockGate.test.ts`.
- **NPC capital turrets engage hostile STRUCTURES too** (2026-11-10): the candidates are the pilots plus the room's per-tick hostile-structure set (`hostileStructures` dep → `hostileStructureCircles`, built by `fillStructureTargets`), still filtered by the drone's `hostileTo`. A structure target is gated by the TURRET's own lock (`droneMountLocks`, `stepLock` per tick with that mount size's `WEAPON_LOCK_PROFILE`, its gun's reach, the hull's `sensorFor`, the structure's radius as signature; uncapped: a heavy gun locks a small structure slowly, a sub-capital gun past `maxSeconds` skips it in its search). Before this a capital could not fire at a structure at all (it never fires as a hull). Locks: `capitalLockGate.test.ts`, `tests/integration/sectorRoom/coastalDuel.test.ts`.
- **Not yet gated:** a drone shot at a non-pilot target (an NPC or structure) that strays into a pilot.

### From the server Thresholds section

Moved verbatim from the old "Thresholds" section of `src/server/CLAUDE.md`. The rules stay there in short form; current values are in [server-thresholds](server-thresholds.md). Dates, plan names and "was" notes below are history.

- **Fire control — NPC lock step**: O(pilots × hostile NPCs) every 6 ticks now that every pilot is tracked; ~0.015 ms at 56 drones × 4 pilots, ~0.037 ms at 56 × 10 (`benchmarks/npc-locks.bench.ts`, laptop 2026-11-09). The room's `forEachHostileNpc` scans the whole swarm per pilot; budget 0.1 ms per step.

## History

- **2026-11-14, locks at any distance.** Owner decision: players, NPC ships and structures lock at any distance; distance only makes a lock slower; only firing is range-limited (per-turret fire range to the hull, the sibling fire-range changes). Lead calls in the same change: NPC hostility is refreshed by a lock only inside that NPC's fire range (before: "out of reach ⇒ lock drops ⇒ forgets 30 s later"; now "out of fire range ⇒ no refresh ⇒ forgets 30 s later"); AUTO groups release their own pick once it leaves fire range and re-pick, manual locks persist; AUTO's pick stays limited to what it could fire at. The wire `c` flag and the HUD now say CAN'T TRACK instead of OUT OF RANGE. See "Locks work at any distance" above.

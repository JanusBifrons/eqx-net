# Allegiances — the NPC sides of the living world

Plan: `peppy-jumping-pinwheel` (Living World: Allegiances, Loot & Trade), phase P0.

## Why

Until P0 the living world had exactly one AI side: the drones. Every AI code
path assumed "drones vs everyone else":

- the drone brain only ever saw players and player structures (`AiWorldView`
  had no slice for other swarm entities);
- the drone beam only tested players and hostile structures;
- missile lock-on and attacker labels decided "AI or player?" from **id
  prefixes** (`swarm-`, `lwbot-`);
- shooting *any* kind-1 swarm entity declared war on the drones
  (`FactionLedger`).

The living-world plan adds a third-party **robot** side (hostile to players
AND drones) and a neutral **trader** side (P2's trade haulers). P0 is the
framework that lets those sides exist without each feature re-solving
"who fights whom".

## Naming

"Faction" was already taken: `src/core/faction/Faction.ts` + `FactionLedger`
mean *a player plus the structures they own in one sector*. The AI sides are
therefore called **allegiances**. Keep the two words distinct.

## The model

`src/shared-types/allegiances.ts` is the single source (server, client and
core all import it — invariant #15):

- `NPC_ALLEGIANCE_IDS` = `drones | robots | traders` (append-only).
- `PLAYERS_SIDE` — every player and player structure, for stance purposes.
- One **stance table** — what side A does to side B *unprovoked*:

| A \ B   | drones   | robots   | traders  | players |
|---------|----------|----------|----------|---------|
| drones  | friendly | hostile  | neutral  | neutral |
| robots  | hostile  | friendly | hostile  | hostile |
| traders | neutral  | neutral  | friendly | neutral |
| players | neutral  | neutral  | neutral  | neutral |

`hostile` means *attack on sight* (within `ON_SIGHT_ENGAGE_RANGE`, 1600 u).
`neutral` means only the reactive ledger applies — the drones' existing
wave + retaliation (`markHostile`) behaviour is unchanged. Players' own stance
is always neutral: players choose whom to shoot.

An entity's allegiance comes from its **ship kind** (`ShipKind.allegiance`,
default `drones`). That costs zero wire bytes: the client already receives the
kind on the binary swarm record. There is no faction byte and no
`SWARM_WIRE_VERSION` bump.

## Ship-kind flags

`ShipKind` gained three optional fields (catalogue v12 → v13):

- `allegiance` — see above.
- `npcOnly` — robots, haulers, loot pods. Excluded from
  `GAMEPLAY_SHIP_KINDS_LIST` (random drone pickers) and `PLAYABLE_SHIP_KINDS_LIST`
  (ship picker), and **rejected server-side on join** by `isPlayableShipKindId`.
  Hiding them in the UI alone would let a forged join pilot a robot.
- `shedImmune` — `LoadShedder` never evicts it (haulers, nexi, elites:
  entities whose silent removal would destroy value or break a world state
  machine).

## How the AI sees other sides

`SectorRoom.fillSwarmTargets` builds a per-tick list of kind-1 combatants
(`AiWorldView.swarms`) **once per tick** (invariant #14, pooled objects) and
**only when two or more allegiances are present** in the sector. A drones-only
sector leaves it absent, so the brain takes the pre-P0 fast path —
byte-identical behaviour and zero added cost.

`HostileDroneBehaviour` then:

- appends only *hostile* swarm candidates (stance on-sight within range, or
  retaliation via its own `hostileTo`);
- treats players as on-sight hostile when its allegiance says so (robots);
- stays IDLE (patrol / flock) when nothing hostile is in range — on-sight
  engagement never flips the persistent `COMBAT` state;
- reports `isHostileToPlayer` = stance OR ledger. That feeds the existing
  per-recipient `drones[].hostile` snapshot bit, `liveCounts`, and player
  turret aim — so a robot renders hostile from first sight, and a late joiner
  reconstructs it from the snapshot alone (invariant #16). The client builds
  the same behaviour from the same kind, so its ledger agrees.

## Fire paths

Allegiance decides **targeting** only. It never decides what a shot hits.

- **Friendly fire (owner decision 2026-11-10: "Fire hits all").** Every shot
  hits the first thing in its path, the shooter's own side included: bolts and
  naval shells (`ProjectilePipeline`, sweep and blast), NPC beams
  (`AiFireResolver.hitscan` → the room's `nonPlayerRayHit`: every swarm entity
  of any side, structures of any owner, rocks, scrap, parked hulls), structure
  turret beams (`beamFirstHit` → `turretBeamFirstHit`, its owner's own ship
  included), missiles (contact and splash) and player shots. Two physical
  skips stay: a shot never hits its own shooter, and a capital turret won't
  fire along its own deck (`mountLineClear`, the per-mount fire mask). Shield
  fences block every shot. *History:* P0 rule 6 let NPC bolts and beams pass
  through their own allegiance; that was removed.
- **Line of fire (slice 2).** An NPC holds fire while a FRIENDLY body sits on
  its shot's line from the muzzle to the target (up to the target's distance;
  the shooter and the target themselves are never tested). The gun keeps
  aiming, the lock stays, and no cooldown or reload is spent, so it fires the
  moment the line clears. Where the check sits: `AiFireResolver.resolve`
  (drone slots: bolts, beams, missiles, charge wind-ups; before the cooldown),
  `WeaponMountTicker.tickCapitalMounts` (each capital turret, last, along its
  barrel from its muzzle) and `StructureGridSubsystem.fireMount` (every
  structure turret; refusing returns false so the reload is kept). All three
  call the room (`npcShipLineBlocked` / `droneLineBlocked` /
  `structureLineBlocked`), which runs `LineOfFireGate`.
  **What counts as friendly** mirrors `isFriendlyFire` (a hit that would be an
  accident): for an NPC ship, ships of a friendly allegiance and NPC structures
  not hostile to its side; for an NPC base turret, its own base's structures,
  its faction's other bases, and NPC ships of sides it isn't hostile to; for a
  **player's turret**, its owner's own structures and the owner's own active
  ship (decision 2026-11-10: a base never shoots its owner; allies' ships are
  not protected). Hostiles, neutrals, rocks and scrap never block: the NPC
  shoots them. **Players are never gated**: a pilot may shoot through allies.
  **Cost:** one `ProjectileBroadphase` grid of the swarm registry per tick,
  built lazily on the first check (none in a tick with no NPC fire), rebuilt
  only if membership changes; each check is one grid query over the segment's
  box, the friendly predicate per candidate, and a narrow ray test only for
  friendly candidates (stopping at the first hit). Allocation-free. Count gate
  `LINE_OF_FIRE_BUDGET` (`perfBudgets.ts`, synthetic 80-ship fight where
  every ship fires every tick: 80 checks → 1,617 candidates, 236 narrow tests
  per tick vs 30,400 for a full scan). The perf scenes print
  `lineOfFireChecksPerTick` / `lineOfFireNarrowPerTick` (print-only until
  calibrated on CI). Formation spacing is the remaining item (docs/SHELF.md).
- **Accidental hits don't start wars.** A hit on an NPC from its own side
  (`SectorRoom.isFriendlyFire`: an NPC of a friendly allegiance, or an NPC base
  not hostile to the victim's side) does its damage but does NOT mark the
  victim hostile and does not escalate a faction (`swarmDamageStrategy`). A
  hit from another side, a player or a player's structure marks as before.
- **Missile** lock-on classifies the shooter by registry (any live kind-1
  entity is an AI shooter), and targets cross-allegiance swarms by stance.
- **Structure turrets** engage drones and robots, never neutral traders.
- **Escalation:** only a hit on a *drone* flips the player's drone-war ledger
  (`escalateFactionOnDroneHit`). Shooting a robot or a hauler doesn't declare
  war on the drones; the victim still retaliates via its own `markHostile`.

## Tests

- `src/shared-types/allegiances.test.ts` — stance truth table, npcOnly
  exclusion.
- `src/core/ai/HostileDroneBehaviour.allegiance.test.ts` — robot fires at an
  unprovoked player, drone doesn't; drone fires at a robot; never at an ally.
- `src/server/rooms/ProjectilePipeline.friendlyFire.test.ts` — a bolt stops on
  the first ship in its path, its own side included.
- `tests/integration/sectorRoom/friendlyFire.test.ts` — a drone's bolt and
  beam hit the ally in front, a battleship's shell hits its escort, a turret's
  beam hits its owner's ship; the hit ally does not turn hostile.
- `tests/integration/sectorRoom/npcLineOfFire.test.ts` — a drone holds with an
  ally in the way and fires once it moves; a robot in the way doesn't block;
  an NPC base turret holds over its own connector (control: fires with it off
  the line); a player's turret holds over its owner's ship.
- `tests/unit/capitalLineOfFire.test.ts` — a capital turret with its escort
  in the line holds while a turret on the far end fires.
- `src/server/rooms/LineOfFireGate.test.ts` — parity with a full scan, and
  the count budget.
- `src/client/combat/friendlyFirePrediction.test.ts` — the local beam end and
  hit prediction stop on an ally (#15).
- `tests/integration/sectorRoom/allegianceThreeWay.test.ts` — a real robot and
  drone fight with no player involved (verified RED with the swarm feed
  disabled); a forged join cannot pilot a robot.

## What comes next

- **P1b** appends the circle (T2) and hexagon (T3) robots and a robot
  `LivingWorldDirector` instance.
- **P2** adds per-player reputation into `areHostile` (a robot truce at high
  rep) and the trader hauler.
- The procedural-bases work can tag an NPC base with an `NpcAllegianceId`.

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

- **Beam** (`AiFireResolver.hitscan`): a third pass tests other combatants
  (`swarmCombatCircles`), skipping the shooter and friendlies.
- **Bolt** (`ProjectilePipeline`): an NPC bolt carries its owner's allegiance
  (resolved once at spawn) and passes **through** same-allegiance ships.
  *Behaviour change:* before P0 drones shot down fellow drones in the way.
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
- `src/server/rooms/ProjectilePipeline.allegiance.test.ts` — bolt pass-through.
- `tests/integration/sectorRoom/allegianceThreeWay.test.ts` — a real robot and
  drone fight with no player involved (verified RED with the swarm feed
  disabled); a forged join cannot pilot a robot.

## What comes next

- **P1b** appends the circle (T2) and hexagon (T3) robots and a robot
  `LivingWorldDirector` instance.
- **P2** adds per-player reputation into `areHostile` (a robot truce at high
  rep) and the trader hauler.
- The procedural-bases work can tag an NPC base with an `NpcAllegianceId`.

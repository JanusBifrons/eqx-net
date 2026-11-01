# Relations: who is hostile to whom

Plan `soft-leaping-truffle` v3, phase B1. Code:
- [src/shared-types/relations.ts](../../src/shared-types/relations.ts)
- [src/core/relations/HostileActLedger.ts](../../src/core/relations/HostileActLedger.ts)

## Why

Bases are getting owners that aren't players (NPC bases, phase B2 onward). Several systems need to know whether a ship is welcome near something it doesn't own:
- shield gates;
- turrets;
- cargo access and break-ins;
- NPC trade docks.

If each system answered the question its own way, they would drift apart: a gate could open for a ship the turrets beside it are shooting. B1 gives them one answer, `relationOf(actor, owner, ctx)`.

## Parties

Both the actor and the owner are owner strings:

| String | Party |
|---|---|
| a player id (a UUID), or `scenario` in tests | a player or account |
| `npc:<allegiance>` | an NPC side, e.g. a roaming robot: `npc:robots` |
| `npc:<allegiance>:<baseId>` | an NPC base: `npc:traders:sol-3` |

- `npcOwner(allegiance, baseId?)` builds these strings.
- `parseOwner` reads them, with a cache so hot loops allocate nothing.
- An unknown allegiance (`npc:pirates:x`) is read as a plain id, never as an NPC side.
- Persistence and uid hashing treat owners as opaque strings, so NPC owners need no migration.

## The answer

| Case | Relation |
|---|---|
| Same party | `self` |
| A hostile act that hasn't cooled down | `hostile` (this beats an alliance) |
| Two players | `allied` if the alliance provider says so, else `neutral` |
| Two NPC parties | `friendly` on the same side, else the allegiance stance table |
| A player and an NPC party | the stance table, taking the worse direction, unless `npcStanceToPlayer` overrides it |
| An empty owner | `neutral` |

- **Hostility is treated as mutual.** Robots attack players on sight, so a robot is `hostile` to a player's gate as well as the reverse.
- **Hostile acts are directional.** If A breaks into B's cargo, A is hostile to B; B is not hostile to A.
- **Hostile acts are per owner.** Raiding one trader base doesn't make every trader base hostile.

## Inputs (injected)

| Input | Today | Later |
|---|---|---|
| `alliances: AllianceProvider` | `NO_ALLIANCES` | player alliances |
| `hostileActs: HostileActQuery` | the room's `HostileActLedger` (nothing records into it yet) | break-ins (C2), attacks on NPC bases (B2) |
| `npcStanceToPlayer` | none | reputation, e.g. the robot truce at ≥ 500 standing (B2) |

**Keep one context per room** and update `ctx.nowMs` in place. `relationOf` itself never allocates (invariant #14).

## Who uses it

| Caller | Since | Note |
|---|---|---|
| `GateController` (via `SectorRoom`) | B2 | `gateAdmits` treats `friendly` like `self`, so an NPC base's own side passes its gates |
| NPC-owned turrets and their missiles | B2 | Target whatever is `hostile` to the owner, players included. Player-owned turrets are unchanged (drones and robots, never players) |
| Hostile acts | B2 | A player, or a player's turret, damaging an NPC structure records an act against that base |
| Waves, faction escalation, persistence | B2 | NPC owners are skipped: never a wave target, never a player faction, not saved (they regenerate from their seed) |
| Cargo access (`cargoOpensFor`) | C1 | |
| Break-ins | C2 | |

## Locks

- `relations.test.ts`:
  - the full truth table;
  - the providers (alliances, a hostile act beating an alliance, cooldown, per-base acts, the stance override);
  - a property test proving that, with no alliances or acts, a pair of players is still `self` or `neutral`: exactly the interim gate rule, so switching gates over in B2 changes nothing for players.
- `HostileActLedger.test.ts`: directionality, expiry, the extend-only cooldown, `sweep` and `clear`.

B1 shipped the seam only. B2 wired it in. Its locks:
- `tests/integration/sectorRoom/npcOwnership.test.ts`:
  - a trader base ignores a pilot until the pilot attacks it;
  - a robot base engages pilots and drones, but never robots;
  - a player's turret is unchanged;
  - NPC bases are never wave targets.
- `structureTargets.test.ts`.

## A turret aiming at a player

A player has no swarm entity id, so a turret's target slot in `structureTargets` holds `-(ownerIdx + 2)`. `ownerIdx` indexes the room-state `structureOwners` table, where the server interns the target player.
- The server encodes with `encodePlayerTurretTarget`.
- The client decodes with `decodePlayerTurretTarget` into `turretTargetPlayerId`, then aims the barrel and the aim line at that ship.

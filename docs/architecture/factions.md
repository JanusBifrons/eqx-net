# Factions and standing

Plan `soft-leaping-truffle` v4, phase F1. Code:
- [src/shared-types/factions.ts](../../src/shared-types/factions.ts): the catalogue, the fixed stance layer, policies;
- [src/shared-types/relations.ts](../../src/shared-types/relations.ts): `relationOf`, which reads them;
- [src/server/economy/EconomyStore.ts](../../src/server/economy/EconomyStore.ts): the standing web, stored and persisted.

## Why

The user, 2026-11-02: "Everything is a faction… every individual player has their own faction, unless they join another one… factions don't have to be powerful or large or own structures", with "a relationship web with every other faction from −100 to 100".

Before F1 there were three NPC "sides" (drones, robots, traders), and reputation was a per-player number for each of them. Region powers, the alien-gate Ancients, minor companies and military bases all need owners that can like or dislike each other, so the model is now general.

## Who is a faction

| Faction | Id | Kind |
|---|---|---|
| Every player | their player id | `player` (a faction of one; joining player factions comes later) |
| Drones, Robots | `drones`, `robots` | `swarm` |
| Traders | `traders` | `guild` |
| Sol Dominion, Verdant Reach, Crimson Expanse, Azure Deep | the region ids (`core`, `verdant-reach`, …) | `power` |
| The Ancients (alien gates) | `ancients` | `ancient` |
| Minor companies and militias (F2) | generated | `minor` |

The fixed list is append-only, because ids are persisted in owner strings and standings. NPC owners are `npc:<factionId>[:<baseId>]`; the three original ids are faction ids, so nothing saved needed migrating.

## Standing: a directional web

- **Directional, −100..100, in 0.1 steps.** Every faction has a view of every other, and the two directions are separate: dodging my toll lowers my view of you, not yours of me.
- **Starts at 0.** NPC factions are neutral toward each other, except for the fixed layer below.
- **Where it lives:**

  | Pair | Stored in |
  |---|---|
  | NPC faction → player | the player's economy row (`rep`, the old reputation) |
  | player → anyone | the player's economy row (`views`) |
  | NPC faction → NPC faction | one `economy_state` record, `standings` |

  Read it with `EconomyStore.standing(from, to)` and change it with `adjustStanding`. Rooms read it through the trade sink (`TradeSink.standing`).
- **Rescale:** the old reputation ran −1000..1000. A row saved before F1 has no `standingScale` marker and is divided by 10 once on load. Every constant (`REP_*`, the truce, the refusal line) was divided by 10 too, so nothing behaves differently.

## The fixed stance layer

`factionStance(a, b)` is what a faction does unprovoked, underneath standing:
- the same faction is friendly;
- the original allegiance table still holds (robots attack everything; drones and robots fight);
- every other pair is neutral, except that robots attack the new factions on sight.

Standing never softens this layer.

## Policies: what standing does

Each faction's `FactionPolicy` maps its view of you to behaviour:

| Field | Meaning | Default |
|---|---|---|
| `hostileBelow` | its turrets and patrols treat you as hostile | never (robots: their truce, 50) |
| `alliedAbove` | you count as allied (gates, cargo, teleporters) | never |
| `refuseTradeBelow` | it won't trade with you | never (traders: −30) |
| `priceSwing` | how far standing moves its prices | 0 (traders: ±15 %) |

The defaults reproduce the pre-faction rules exactly. F3 lets a player edit their own faction's policy.

## In `relationOf`

After the stance table and the hostile-act ledger, `relationOf` applies the **owner's** policy to the owner's view of the actor:
- below `hostileBelow` the actor is hostile;
- above `alliedAbove` a neutral actor is allied;
- a hostile base relation is never softened, and two parties of one faction skip the check.

It's allocation-free, and returns early when the policy can't act on standing, so hot loops (NPC turret target filtering) pay nothing for the default policies. A parity test proves a full standing web with default policies changes no relation.

## The galaxy (F2)

**Control** (`src/core/galaxy/control.ts`, `sectorController`):
- the Sol Dominion holds the whole core region (3 sectors);
- each frontier power holds only its region's heart;
- the other 15 of 21 sectors are **neutral ground**.

A sector's `region` is now geography only. The galaxy map groups territories by the controller (`/galaxy/snapshot` `owner`, null on neutral ground), and the tooltip names the power or says "Neutral ground".

**Minor factions** (`MINOR_FACTIONS` in `factions.ts`):
- three per region, each with a different specialty (mining, freight, manufacturer, militia);
- a generated name ("Merrow Mining Co.", "Saffron Freight") and a colour;
- generated from a fixed seed, so client and server agree on every id with no registration step.

Minor factions don't have to own anything: the core region's minors own no bases, because their power holds the whole region.

**Base owners** (`chooseBaseOwner` in `galaxyBases.ts`, from its own seeded stream, so layouts are unchanged):

| Sector | Owner |
|---|---|
| Controlled | the power; the Traders run its trade hubs |
| Neutral | a weighted pick: minor factions of the region (4× when their specialty fits the role), the region's power (1.5×), the Traders (4× for trade hubs, else 0.5×). An owner already used in the sector is far less likely, so several factions build side by side |

The owner string is `npc:<faction>:<baseId>`, and the inspector names it ("Merrow Mining Co. base").

## Next

- **F3:** a Factions tab, editable policies, and standing events beyond trade (kills, raids, break-ins, tolls).
- **Military bases (M):** these fill in power and militia patrols.

# Robot territory and the nexus (Living World P3a)

> **Economy v2 W1:** credits are a virtual wallet ([economy-wallet.md](economy-wallet.md)).
> The nexus's credits are its kill bounty (paid to the killer's wallet), and
> harvester raids steal **goods only**, never credits.

Plan: `peppy-jumping-pinwheel`. Builds on robots v1
([robots.md](robots.md)).

## What the player sees

- A **robot nexus** — a huge violet octagon — sits in one of the galaxy's edge
  sectors. It fires slow, heavy **pulse orbs** (easy to see coming, painful to
  tank) and is guarded by whatever robots are nearby.
- While the nexus stands, **robots that die come back at the nexus** instead of
  warping in from the galaxy edge. Killing robots near it only buys time.
- Robots **claim sectors**. A sector where robots dominate for a while turns
  robot-violet on the galaxy map ("Robot Dominion"). The nexus sector is held
  for as long as the nexus lives. Players and their bases push back; a sector
  the robots hold while players are present reads as **Contested**.
- **Destroying the nexus** is the biggest single kill in the game: 400–800
  credits, 60–120 salvage, 20–40 alloy and 2–4 robot cores. Robots then fall
  back to arriving from the edge, the territory decays, and the nexus returns
  about 20 minutes later in a different edge sector.

| | Nexus |
|---|---|
| Hull / shield | 6,000 / 2,500 |
| Weapon | pulse orb — 45 damage, 700 u/s, ~1,400 u reach |
| Movement | none (stationary) |

## How territory works

Each sector has a control **pressure** from −100 to 100, recomputed every robot
control tick (`src/core/territory/sectorControl.ts`):

- each robot present: +12; a living nexus: +80;
- each player structure: −6; each player present: −15.

Pressure moves toward that target at 1.5 per second, so a squad passing
through does not flip a sector. Robots **claim** a sector at 60 and only
**release** it at 20 (hysteresis), so a contested frontier doesn't flicker on
the map. A sector a robot squad lingers in for a while turns violet and fades
back after it leaves; the nexus sector stays held.

## Internals

- `RobotTerritory` (`src/server/livingworld/RobotTerritory.ts`) owns the nexus
  (`rbot-nexus`, a `robot-nexus` swarm entity) and the per-sector control. It
  plugs into the robot director through hooks: `respawnAnchor` (reinforcements
  at the nexus — the robots-only exception to edge ingress), `onTick`, and
  `sectorOwner` (handed to the drone director, which publishes
  `/galaxy/snapshot`, so robot-held sectors get `owner: { factionId: 'robots' }`).
- The galaxy map colours `robots` violet and the tooltip reads "Robot Dominion".
- Not persisted: on restart the nexus is placed fresh and control starts at 0.

## Tests

- `src/core/territory/sectorControl.test.ts` — targets, bounded rate, claim /
  hold-through-a-dip / release, contested.
- `tests/integration/sectorRoom/robotTerritory.test.ts` — real rooms: the nexus
  spawns; a killed robot reinforces at the nexus; a destroyed nexus drops cores
  and returns; the nexus sector is claimed.
- `LivingWorldDirector.galaxySnapshot.test.ts` — robot owner stamping.
- `galaxyTooltip.test.ts` — "Robot Dominion".

## Harvesters (P3b)

- Each nexus keeps **two robot harvesters** (gold, scoop-bowed). They chase the
  nearest loot pod in the nexus sector, scoop it up, and fly home once three
  quarters full (or as soon as nothing is left to chase).
- At the nexus they **bank** their cargo into the nexus's own hold. Everything
  the robots hoard comes out when the nexus dies, on top of its loot table, so
  a nexus near a busy battlefield gets richer over time.
- A killed harvester **spills what it carries**. Harvesters respawn at the
  nexus 90 seconds later, and follow the nexus when it relocates.
- They collect through the same atomic pickup path as players
  (`LootCollector.npc`); their hold is an ownerless record keyed by their id.

| | Harvester |
|---|---|
| Hull / shield | 300 / 150 |
| Weapon | bolts |
| Carries | 400 weight |

## Raids and the charge laser (P3c)

- **Raids.** When there is no loot pod to chase, a harvester heads for the
  nearest player storage (Capital or Cargo Bay) within 3000 u of its nexus.
  Parked beside it, it steals up to 30 weight per control tick (about every
  1.5 s): Robot Cores first, then alloy, salvage, and minerals, plus up to 25
  credits. Each step is one atomic `tradeTransfer` group. The stolen cargo sits
  ownerless in the harvester's hold, so **killing the raider spills your goods
  back as pods**. Once it is three quarters full it flies home and banks the
  haul into the nexus.
- The owner gets a red **"Robot harvesters are raiding your storage!"** toast,
  at most once a minute (the existing `trade_notice` channel, event `raided`).
  Every step writes a `storage_raided` audit event.
- **Charge laser.** The robot orb now carries a `charge-laser`: a hard-hitting
  beam (60 damage, 520 u range) that winds up for 1.2 s before it fires. While
  it charges, the orb shows a pulsing red line along its aim, so you can dodge.
  The beam fires along the direction locked at the start of the charge. The
  `charging` bit rides the slim `drones[]` snapshot slice (sent only while
  true; the client clears it when a drone drops out of the slice), so a late
  joiner sees the telegraph too.

| Tuning | Value |
|---|---|
| Raid range from the nexus | 3000 u |
| Steal per step | 30 weight + 25 credits |
| Owner warning | at most once a minute |
| Charge laser | 60 damage, 520 u, 72-tick wind-up, 150-tick cooldown |

Tests: `tests/integration/sectorRoom/robotTerritory.test.ts` (raid),
`tests/integration/sectorRoom/chargeLaser.test.ts` (the telegraph lands before
the beam; red with no wind-up), `src/client/net/snapshotRemoteSync.charging.test.ts`.

## Next

Harvesters raiding trade haulers and mining asteroids, and merge clusters.

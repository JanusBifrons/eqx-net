# Robot territory and the nexus (Living World P3a)

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

## Next (P3b)

Harvesters (drain asteroids, collect loot pods, raid storage and haulers),
merge clusters, and a charging robot laser with a visible telegraph.

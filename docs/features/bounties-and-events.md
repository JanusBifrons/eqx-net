# Elites, world events and bounties (Living World P4)

Phase P4 of the Living World plan (`peppy-jumping-pinwheel`) gives players
named targets worth chasing. It ships in parts:

- **P4a — named elites** (this page, shipped).
- **P4b — world events** (shipped): robot incursions, drone motherships,
  salvage fields.
- **P4c — bounties and the Contracts tab.**

## Named elites (P4a)

### What the player sees

- Up to **two named elites** roam the galaxy at any time, for example
  "Dread Vexis" or "Iron Kharn". Each is an existing heavy hull (gunship,
  missile frigate, heavy, or robot hexagon) with **4× the hull** of a normal
  ship of that kind.
- In the world an elite wears a **pulsing gold ring** and a gold **★ name**
  label. The label shows even when ordinary NPC callsigns are hidden.
- When one appears or dies, every pilot in the galaxy gets a **gold toast**:
  "Dread Vexis has been sighted!" or "Dread Vexis has been destroyed!".
- On the galaxy map, the sector tooltip and the sector drawer name the elite
  that's roaming there ("★ Dread Vexis sighted").
- Killing one drops a **guaranteed rare haul**: its kind's loot table rolled
  three times, plus 1–3 Robot Cores and 200–500 credits. It also gives far more
  XP, because XP scales with the victim's (boosted) max hull.
- An elite keeps its kind's side. A drone elite is neutral until you shoot it;
  a robot elite attacks on sight.
- A slain elite's replacement appears **8 minutes** later in a different
  sector.

### How it works

- `EliteDirector` (`src/server/livingworld/EliteDirector.ts`) keeps the elite
  slots full. It ticks on the drone director's control loop (`onTick`, about
  every 1.5 s) and spawns through the room's living-world bot hook. It then
  calls `SectorRoom.markElite(id, name)`, which tags the swarm record
  (`rec.elite = { name, maxHealth }`) and heals it to the boosted max.
- **One max-hull read.** Every per-entity max-health read goes through
  `droneMaxHealthOf(rec)` (`droneKindHelpers.ts`): the shield/hull router, the
  snapshot `hp` percent, player turret health weighting, and kill XP. An
  elite's 4× hull is consistent everywhere.
- **Client state comes from the snapshot (#16).** The elite's name rides the
  slim `drones[].elite` snapshot field while it is in interest. The client
  clears it when the drone drops out of the slice, the same as `charging`. The
  galaxy snapshot carries `SectorLiveState.elite` through the director's
  `sectorElite` hook. The `world_notice` toast is only an accelerator.
- Elites are **never load-shed**. A shed would remove one silently, with no
  `ENTITY_DESTROYED`, and leave its slot stuck.
- Elites use the `elite-` id prefix, which `isDirectorBotId` treats as an NPC.
- Elites are not persisted: they re-seed on boot.
- **Audit events:** `elite_spawned`, `elite_killed` (with the attacker).

### Tuning

| | Value |
|---|---|
| Live elites | 2 |
| Hull | 4× the kind's |
| Respawn | 8 min, different sector |
| Spawn / roam radius | 2600 u / 3200 u from the sector centre |
| Loot | kind table ×3 + 1–3 cores + 200–500 credits |

### Tests

- `src/server/livingworld/elites.test.ts`: names, the guaranteed haul, NPC id.
- `src/client/net/snapshotRemoteSync.charging.test.ts`: the elite name is set
  and cleared on absence.
- `tests/integration/sectorRoom/eliteDirector.test.ts`: a real elite with 4×
  hull, its name on the client snapshot, the galaxy hook, the rare haul on
  death, galaxy-wide notices, and the respawn.

## World events (P4b)

### What the player sees

Every few minutes something happens somewhere in the galaxy. A gold toast
announces it to every pilot ("Robot Incursion detected!"), and the galaxy map's
tooltip and sector drawer show **⚑ \<event\> underway** in that sector. One event
runs at a time, with a 9-minute lull between them.

| Event | What happens | How it ends | Reward |
|---|---|---|---|
| **Robot Incursion** | 6 robots (1 hexagon, 2 orbs, 3 cubes) appear together, hostile on sight. | Destroy every raider. | A cache where they stood: 40–80 salvage, 10–20 alloy, 1–3 Robot Cores, 250–500 credits (plus each robot's own drop). |
| **Drone Mothership** | A "Drone Mothership" (a missile frigate with 6× hull, gold ring and name) plus 4 fighter escorts. | Destroy the mothership; the escorts warp out. | The elite haul (table ×3 + 1–3 cores + 200–500 credits). |
| **Salvage Field** | 6 rich loot pods scattered around a point. | It drifts away after 5 minutes (the pods keep their own 15-minute life). | 20–45 salvage, 2–8 alloy and 20–60 credits per pod. |

An unfinished incursion (10 min) or mothership (12 min) fades: the survivors
leave quietly and drop nothing.

### How it works

- `EventDirector` (`src/server/livingworld/EventDirector.ts`) ticks on the
  drone director's `onTick` alongside the elites. Event NPCs use `event-` ids
  (NPC ids for `isDirectorBotId`) and spawn through the living-world bot hook.
  The mothership is tagged through `markElite(id, name, 6)`.
- Event NPCs are **never load-shed**: a quiet shed would leave the event
  waiting forever for a death it never hears about.
- Rewards drop through `SectorRoom.dropEventLoot` as ordinary loot pods.
- **Client state (#16):** the galaxy snapshot carries `SectorLiveState.event`
  (`{ kind, title, endsAtMs }`, via the `sectorEvent` hook). The notices are
  accelerators. In the sector, event NPCs are ordinary drones (the mothership
  carries the elite name and ring).
- **Test trigger:** `POST /dev/world-event/start?kind=incursion|mothership|salvage&sector=<key>`
  (non-production) starts one immediately.
- **Audit events:** `world_event_started`, `world_event_ended` (`completed`
  or `faded`). Events are not persisted: a restart begins a fresh lull.

### Tests

- `tests/integration/sectorRoom/worldEvents.test.ts`: covers each event kind
  in real rooms (strike group → cache, mothership → haul + escorts leave,
  salvage pods), the fade and the lull, one event at a time, the galaxy hook,
  and the notices.

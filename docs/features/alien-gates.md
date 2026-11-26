# Alien gates

Plan `soft-leaping-truffle` v4, phase A. Every sector has a ring of ancient gates, one on each edge that faces a neighbouring sector. They belong to **The Ancients**, a faction nobody has met. They tie the whole galaxy together without anyone building anything. The catch: each gate only leads across its own border. To go somewhere specific, like a trade hub, you still need a built teleporter or an NPC transit hub.

## What a gate is

- **A teleporter nobody owns or builds.** It is the `alien_gate` structure kind, and it works like a built teleporter (see [teleporters.md](teleporters.md)). It has the same pad, the same doors-closing cycle, and the same rule that everyone on the pad rides.
- **Bigger:** a 1600 × 1600 footprint, ringed by three turning stone rings (the Astrolabe). It has no posts: outside a jump nothing at the gate blocks a ship.
- **The Astrolabe** (redesign A1–A2, `structureStyleC.transport.astrolabe.ts`): a glowing hex-tiled light pool at the centre with a dark floating crystal over it, ringed by three rings of dark stone with teal glyphs. Each ring is three arcs with three gaps ("lanes") 120° apart. The rings turn at different speeds and directions. About 4.5 s before each timetabled jump they visibly swing into line (a 3 s spin-up and brake, like a combination lock) so the lanes line up and glow, hold through the cycle, then speed up again. Their angles come from the timetable and the live `tpPhase`, never frame time (`alienGateAstrolabe.ts`), so everyone, late joiners included, sees the same pose. The rings are art only: no collider.
- **The gate's light** (`structureStyleC.transport.astrolabeFx.ts`, the approved mock-up's effects): three lane beams under the stone, seen only through the gaps until the lanes line up; the pool's hex wireframe lit by waves running outward; the crystal's glow; and the jump flash, a white-teal glow that builds into the swap and fades after it, throwing out three rings of light. A rider sees the flash build as the jump fires and fade round them on arrival. They are light-only parts of the same rig (`PartDef.light`, `ASTROLABE_FX_PARTS`), faded per frame by its `partShow` from the same timetable, so late joiners see the same light. It is the gate's light in the world, never a screen flash.
- **Only the light pool rides; its inner ring seals it** (teleporter redesign A3, moved inward 2026-11-26 at the owner's call). The green hex pool fills the inner ring, and it is the ride area: a ship among the stone rings stays behind. Through the last seconds before a jump (the SEALED phase) the innermost stone ring becomes a solid circle round the pool, so nobody gets in or out; everyone inside it rides. The circle is a closed loop of 32 straight iris walls whose corners sit on the inner ring's inner edge, the pool's rim (radius 422, a chord sags about 2 units). One shared source, `src/shared-types/alienGateSeal.ts`, gives the inner ring's size (the Astrolabe rig reads it, the pool art fills to it), the walls (server iris walls and the client's derived walls, locked equal by `tests/unit/irisSpanParity.test.ts`), the ride disc (`onPad`) and the radial closing push (`padPushDir` round).
- **Ships fly under the rings.** The stone rings are the rig's `over` layer, drawn above every hull like arches; the pool and crystal are a floor in the pad-deck band, drawn below every hull. The rings never collide.
- **Quicker:** its cycle runs at about a third of a built teleporter's (about 5 s from warning to arrival).
- **Free:** it charges itself. No grid, no capacitor, no toll.
- **On a timetable:** each twinned pair jumps once a minute, at a moment set by the two sector keys. Different pairs jump at different moments, so the galaxy's gates don't all fire at once. The inspector shows where a gate leads and roughly when it next jumps.
- **Ships only.** A gate has no pad hold; cargo travels in your ship.
- **Not part of any network:** it never connects to a structure grid (`maxConnections: 0`), and nobody can pair with it.

## Where they sit

Each sector's gates are worked out by pure shared code (`src/core/galaxy/alienGates.ts`: `alienGateSites`, `alienGateCandidates`, and the owner `ALIEN_GATE_OWNER`). Server seeding and the client inspector both read it:

- **The ideal site** is 4100 units from the centre, along the galaxy-map bearing to the neighbour. Its twin sits on the matching edge of the neighbour, facing back.
- **The gates are placed after the sector's NPC bases**, so a big base never loses its site to a gate. Each gate takes the free spot nearest its ideal site (`alienGateCandidates`, a 250-unit grid searched nearest-first). Asteroids under a gate are cleared quietly.
- **Twins find each other at run time.** Each gate records the sector it leads to. The first time it needs its partner, it asks the teleport broker for the gate in that sector that points back. A gate may sit off its ideal spot, so pairing never relies on a pre-computed position.

The gate is 1600 units wide so it fits round the biggest bases once their transit-link teleporters are added (v4 H): at 2000 one gate in Bloomgate found no spot.

Gates are NPC structures, so they aren't saved: every boot regenerates them. `EQX_DISABLE_ALIEN_GATES=1` turns them off.

## They can't be attacked

A gate has no hull. Any hit on one does nothing to the gate, and its built-in guns **disable** the attacker instead. So does firing any weapon within 2500 units of a gate's centre.

A disabled ship's **engines and weapons go offline for 10 seconds**. Its hull is untouched. The timer restarts while the attack goes on, so you can't fight near a gate. It covers players and NPC ships alike. (A turret that hits a gate just does nothing; turrets can't be disabled.)

- **Server:** `AlienGateGuard` (`src/server/structures/`) holds the deadlines. It strips a disabled pilot's movement bits in the input handler, drops their fire, and zeroes a disabled NPC ship's AI intents (by swarm slot).
- **Client:** the own ship's snapshot entry carries `disabledMs` while it lasts (#16). The client strips its own input with the **same shared function** (`gateDisabledInput`, `src/core/combat/disable.ts`, #15), so prediction matches the server. A "Systems disabled" chip counts down at the top of the screen.

## Testing

| Layer | File |
|---|---|
| Sites (pure) | `src/core/galaxy/alienGates.test.ts`: one gate per neighbour, twins face each other, gates inside the sector and apart |
| Timetable (pure) | `src/shared-types/teleport.test.ts`: both ends agree on the moment, the next jump is within a minute, the test speed-up |
| Seal (unit) | `src/shared-types/alienGateSeal.test.ts`: the 32 walls close a loop on the inner ring, only the pool rides, the radial push; `tests/unit/irisSpanParity.test.ts`: server and client walls agree, solid only while SEALED; `World.gate.test.ts`: no solid part, a ship flies through where a post stood |
| Guard (unit) | `src/server/structures/AlienGateGuard.test.ts`: hits and zone shots disable, re-applied attacks extend it, NPC slots, turrets ignored |
| Both sides agree (unit) | `tests/unit/disableParity.test.ts`: the shared gate clears every movement bit; the server handler honours it; both sides call it |
| Integration | `tests/integration/sectorRoom/alienGates.test.ts` (two real neighbouring rooms): twins pair, the timetable carries a pilot across the border for free, a hit disables the attacker and puts `disabledMs` on its snapshot, a shot inside the zone disables, nobody can build or pair one. `galaxyBases.test.ts` checks the gates fit around the biggest bases |
| Astrolabe (unit) | `src/core/galaxy/alienGateAstrolabe.test.ts` (the rings swing into line before the jump, from the timetable); `structureStyleC.transport.astrolabe.test.ts` (the art, no pylons); `structureStyleC.transport.astrolabeFx.test.ts` (lane, pool wave, crystal and flash timing) |
| E2E | `tests/e2e/alien-gate.spec.ts` (`alien-gate-test` room): the owner reads "The Ancients", no pairing offer, firing in the zone shows the disabled chip; unsealed, a ship flies through the ring where a post stood; sealed, it stops at the ring |

The `alien-gate-test` room seeds one gate at the origin through the `testAlienGate` room option, with the pilot spawning inside its zone. The timetable runs on the teleporter test speed-up (`teleportCycleScale` shortens the minute too). That gate has no twin, so its timetable never fires: the seal tests force the phase with the `test_gate_seal` cue (`{ sealed: true | false }`, test mode or dev overrides only), which holds the room's gates SEALED or IDLE.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

- **v4 A — alien gates.** The inspector shows a gate's destination and next jump from shared pure code (`components/alienGateInfo.ts`: nearest ideal site + the timetable; approximate, browser clock), never a pairing offer. `DisabledIndicator` (top-centre) reads the Zustand `disabledUntil`, written by `ColyseusClient.applyLocalDisabled` from the own-ship `disabledMs` only when the disable starts, ends or is re-applied. While disabled, `tickPhysics` strips local input through the shared `gateDisabledInput` (both the per-tick and the heartbeat paths) and stops manual and auto fire, so prediction matches the server (#15). `resetPredictionState` clears it.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

- **What they are.** `alien_gate` is a teleporter kind (`isTeleporterKind` includes it; `isAlienGateKind` picks it out). It is unbuildable (`UNBUILDABLE_STRUCTURE_KINDS`: no blueprint, no pack recipe, no build menu, and `place_structure` refuses it), owned by `ALIEN_GATE_OWNER` (`npc:ancients:gates`), and never joins a grid (`maxConnections: 0`).
- **Seeding.** `seedAlienGates` runs for galaxy rooms (`alienGates` room option, set by `resolveSectorConfig`) AFTER the snapshot restore and AFTER the NPC bases. Each gate takes the free spot nearest its ideal site (`alienGateCandidates`). Seeding gates before the bases pushed 5 bases out of their sectors; keep the order.
- **Pairing.** A gate stores `alienNeighbour`. `TeleporterSubsystem.alienTimetable` resolves the twin through the broker on first use (`findAlienTwin`: the gate in that room whose `alienNeighbour` is here). Never pair gates by a pre-computed uid: a gate may sit off its ideal spot.
- **The subsystem.** `required()` is 0 and `isCharged()` true (free), `scaleFor` runs the cycle at `ALIEN_GATE_CYCLE_SCALE`, the pulse skips them (no pad hold), and only the end in the lower sector key fires the timetable. `teleportCycleScale` also shortens the minute (the test trigger).
- **Invulnerable + disable.** `applyDamage` returns early for a gate and calls `AlienGateGuard.onGateAttacked`; `handleFire` / `handleAiFire` call `onFired` (2500 u zone) and drop a disabled shooter's fire. The input handler strips movement bits through the SHARED `gateDisabledInput` (#15), and `postIntent` zeroes a disabled NPC's AI intent by slot. `evictSwarmEntity` must `forget` the ship (slots are reused). The own-ship snapshot carries `disabledMs` (#16).
- **Steady state** with no gates is one `gateCount` check per fire/damage call.
- Locks: `AlienGateGuard.test.ts`, `tests/unit/disableParity.test.ts`, `tests/integration/sectorRoom/alienGates.test.ts`, `galaxyBases.test.ts` (gates fit around the bases). Story: [docs/features/alien-gates.md](../features/alien-gates.md).

## History

- **Teleporter redesign (2026-11-25):** the gate used to share the built teleporter's flat pad: twelve solid posts round the edge and a dashed shield iris between them. Now it is the Astrolabe (A1 rings, A2 art), its twelve posts removed at the owner's call, and its outer ring is the seal (A3): 32 iris walls on the ring, solid only while SEALED. Built teleporters became walled chambers at the same time ([teleporters](teleporters.md#history)).
- **2026-11-26 (owner):** only the green pool rides, so the seal moved from the outer ring to the inner ring and the pool grew to fill it (a ship between the rings was shut in but left behind); the rings now draw over ships (they were stone the ships flew over); the closing message says "Inner ring closing."

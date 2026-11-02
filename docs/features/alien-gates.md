# Alien gates

Plan `soft-leaping-truffle` v4, phase A. Every sector has a ring of ancient gates, one on each edge that faces a neighbouring sector. They belong to **The Ancients**, a faction nobody has met. They tie the whole galaxy together without anyone building anything. The catch: each gate only leads across its own border. To go somewhere specific, like a trade hub, you still need a built teleporter or an NPC transit hub.

## What a gate is

- **A teleporter nobody owns or builds.** It is the `alien_gate` structure kind, and it works like a built teleporter (see [teleporters.md](teleporters.md)). It has the same pad, the same doors-closing cycle, and the same rule that everyone on the pad rides.
- **Bigger:** a 1600 × 1600 footprint with an open pad reaching 640 units from its centre (twice a small teleporter's), ringed by twelve glowing posts.
- **Quicker:** its cycle runs at about a third of a built teleporter's (about 5 s from warning to arrival).
- **Free:** it charges itself. No grid, no capacitor, no toll.
- **On a timetable:** each twinned pair jumps once a minute, at a moment set by the two sector keys. Different pairs jump at different moments, so the galaxy's gates don't all fire at once. The inspector shows where a gate leads and roughly when it next jumps.
- **Ships only.** A gate has no pad hold; cargo travels in your ship.
- **Not part of any network:** it never connects to a structure grid (`maxConnections: 0`), and nobody can pair with it.

## Where they sit

Each sector's gates are worked out by pure shared code (`src/core/galaxy/alienGates.ts`):

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
| Guard (unit) | `src/server/structures/AlienGateGuard.test.ts`: hits and zone shots disable, re-applied attacks extend it, NPC slots, turrets ignored |
| Both sides agree (unit) | `tests/unit/disableParity.test.ts`: the shared gate clears every movement bit; the server handler honours it; both sides call it |
| Integration | `tests/integration/sectorRoom/alienGates.test.ts` (two real neighbouring rooms): twins pair, the timetable carries a pilot across the border for free, a hit disables the attacker and puts `disabledMs` on its snapshot, a shot inside the zone disables, nobody can build or pair one. `galaxyBases.test.ts` checks the gates fit around the biggest bases |
| E2E | `tests/e2e/alien-gate.spec.ts` (`alien-gate-test` room): the owner reads "The Ancients", no pairing offer, firing in the zone shows the disabled chip |

The `alien-gate-test` room seeds one gate at the origin through the `testAlienGate` room option, with the pilot spawning inside its zone. The timetable runs on the teleporter test speed-up (`teleportCycleScale` shortens the minute too).

# Teleporters

Plan `soft-leaping-truffle` v4. T1 (this page's first section) is the structure, its charge, pairing, firing rules and the cargo swap. T2–T4 add ships riding the jump, other sectors and tolls.

## What a teleporter is

A **Teleporter** is a large open pad ringed by solid posts:
- **Small:** 800 × 800 u, pad radius 320. It fits a squad of small ships plus one medium or large hull squeezed in.
- **Large:** 2120 × 2120 u, pad radius 900. It is sized for capital ships to come.

Ships enter between the posts; only the posts are solid. Both sizes are player-buildable from a packed item (`pack_teleporter` on a Fabricator, `pack_teleporter_large` on an Assembly Plant) and appear under **Build ▸ Transport**.

## Pairing

A teleporter pairs with exactly **one** partner. Select your teleporter, and the inspector lists your other built teleporters in the sector by kind and distance, never by id. Tap one to pair them, or **Unpair** to split them.

T1 pairs teleporters in the same sector. Other sectors (T3) and other owners' teleporters, by mutual agreement (T4), come next.

## Charge

Each end has its own capacitor. It fills **only from the grid's spare power**: whatever is left after the batteries are topped up. It never drains your batteries, so turrets and fences keep their reserve.

A jump needs `jumpCharge(distance) = 600 + 0.15 × distance` (`shared-types/teleport.ts`):
- **Only distance matters.** In one sector that is the distance between the pads; across sectors each hop counts as 20 000 u.
- **Pace:** a mid-size base refills an in-sector jump in about a minute or two, and a few-hops jump in a few minutes.
- **Who pays:** the end that fires spends its charge. The other end keeps its own.

## Firing

The inspector's **Fire** button fires now (needs a full charge and both pads idle). Rules fire on their own, and the first rule met fires:
- **when charged:** a shuttle that keeps going;
- **when a ship boards:** a ship has sat on the pad for 3 s;
- **when loaded:** the pad holds at least N of a good, or N total weight (set from the server rules; the panel shows the first two today).

## The jump cycle

Both pads run it together, like train doors closing:

| Phase | Length | What happens |
|---|---|---|
| Armed | 5 s | Everyone on either pad is warned |
| Doors closing | 4 s | A shield iris closes round the edge (T2: it gently pushes straddlers fully in or out) |
| Sealed | 3 s | The barrier is solid and the pad charges up |
| Swap | — | Both pads trade contents |
| Open | 2 s | The iris opens again |

The inspector shows the phase. Room state carries it (`tpPhase`), so a late joiner sees a jump in progress.

## Cargo

Each pad has its **own hold**:
- small: 400 weight;
- large: 4000.

It is separate from base storage, so production never draws from it.

**Load:** **Load 10** moves a good from base storage onto the pad. A *keep loaded* rule (server rules) tops it up every pulse.

**On a swap:** the two pad holds trade places (one atomic group). Whatever arrives unloads into that base's storage on the next pulse, as far as storage has room.

**If a teleporter is destroyed or removed:** its pad hold spills as loot and its partner is unpaired.

## Riding the jump (T2)

**Who rides.** At the swap, everything on either pad trades places, each at the same offset from its pad's centre. That means active pilots, parked (lingering) hulls, NPC ships and scrap. **Everyone rides, strangers and enemies included** (your ruling): defend your pads. The pad is the open square inside the posts (`onPad`).

**The doors.**
- **Closing:** a gentle push moves any ship straddling the pad edge fully in, or fully out, whichever side its centre is on (`padPushDir`, ~90 u/s²).
- **Sealed:** the iris spans between the posts turn solid, so no one can fly in or out at the last moment.
- **Both sides agree.** The server worker and your client's prediction world run the same push and the same walls from the room-state phase (#15), so your ship doesn't judder at the doors.

**The warning.** A pilot whose ship is on a pad sees a top-centre banner while its cycle runs: "Teleport departing. Stay on the pad to ride, or fly off now.", then "Doors closing.", then "Sealed. Charging up…". It is worked out on the client from room state; no message is sent.

**Your view after the jump.** A teleported ship's `poseEpoch` goes up. On the change your client re-seeds its prediction at the new authoritative pose, a snap rather than a long correction slide, and the camera follows.

**Spawning on a pad works:** spawn clearance treats a pad as open (only the posts are solid).

## Testing

| Layer | File |
|---|---|
| Cycle and rules (pure) | `src/core/structures/teleportCycle.test.ts` |
| Integration | `tests/integration/sectorRoom/teleporter.test.ts`: charge capped at the jump's need, pad load, the swap with only the firing end paying, arrivals unloading, late-joiner room state, owner gating |
| E2E | `tests/e2e/teleporter.spec.ts` (`teleport-test` room, feature tier): the cargo flow, and a pilot on the pad who is warned, rides, and stays on the far pad |
| T2 unit | `src/shared-types/teleport.test.ts` (pad geometry, push direction); `src/core/physics/World.padField.test.ts` (the push in, out, off, and two worlds agree) |
| T2 integration | `teleporter.test.ts`: a pilot on pad A and a drone on pad B trade places, and the pilot's epoch bumps |

The `teleport-test` room seeds a powered Capital with a paired teleporter on each side, owned by a fixed id the test joins as. It uses `teleportCycleScale` and a fast grid pulse.

# Teleporters

Plan `soft-leaping-truffle` v4. T1 (this page's first section) is the structure, its charge, pairing, firing rules and the cargo swap. T2–T4 add ships riding the jump, other sectors and tolls.

## What a teleporter is

A **Teleporter** is a large open pad ringed by solid posts:
- **Small:** 800 × 800 u, pad radius 320. It fits a squad of small ships plus one medium or large hull squeezed in.
- **Large:** 2120 × 2120 u, pad radius 900. It is sized for capital ships to come.

Ships enter between the posts; only the posts are solid. Both sizes are player-buildable from a packed item (`pack_teleporter` on a Fabricator, `pack_teleporter_large` on an Assembly Plant) and appear under **Build ▸ Transport**.

## Pairing

A teleporter pairs with exactly **one** partner. Select your teleporter, and the inspector lists your other built teleporters in the sector by kind and distance, never by id. Tap one to pair them, or **Unpair** to split them.

T1 pairs teleporters in the same sector. T3 adds other sectors, and T4 adds other owners' teleporters by mutual agreement.

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

## Across sectors (T3)

**Pairing.** The inspector asks the server for your teleporters in **every** sector (`teleport_candidates`). It lists them by name: "Teleporter · 1.3 km" here, or "Teleporter · Verdance" elsewhere. Pairing one (`teleport_pair_remote`) links both ends, wherever they are.

**Charge.** A cross-sector jump counts each galaxy hop as 20 000 u. One hop needs 3 600 charge, about a minute on a mid-size base's spare power, and each extra hop adds 3 000.

**One cycle, two rooms.** The end that fires drives the cycle and sets the far pad's phase in its own room, so both pads warn, close, seal and open together.

**At the swap:**
- **Pad holds** trade places in one atomic group (`StorageService.padSwapAcross`; the hold store is process-wide).
- **Riders on both pads are collected first, then sent,** so nobody rides twice:
  - **Pilots** leave by an instant transit (`TransitOrchestrator.teleportOut`): no neighbour check and no spool, but the same seat reservation and roster re-home as a warp. They land on the far pad at the same offset.
  - **Parked hulls,** a disconnected pilot's hull included, are rebuilt in the far room. Their roster row moves sector, and their hold travels with them (keyed by the hull's id).
  - **NPC bots** move through their director (`LivingWorldDirector.teleportBot`), so its records stay right. An NPC no director owns (a trade hauler, a scenario drone) stays behind.

**How rooms find each other.** The `TeleportBroker` (`src/server/teleport/`) is a process-wide registry, like the trade sink. Every room with a sector key registers itself, and each director registers a bot mover.

## Tolls and pairing with other owners (T4)

**Setting a toll.** The inspector's **Toll** select sets a price per 1 000 charge (Free, 5, 10, 25 or 50 credits). A jump's toll is `tollFor(jumpCharge, per1000)`, rounded up, so a longer jump costs more. Once a toll is set, **non-payers hostile** switches what happens to someone who rides without paying. The toll is stored on the teleporter, persisted with it, and rides room state (`tpToll`, plus a bit in `tpRules`).

**Who is asked.** When a pad arms, every pilot on it is offered that pad's toll, except the owner and anyone the owner counts as friendly or allied (`relationOf`). A rider pays the pad they board, so each end of a pair can charge its own toll.

**The prompt.** A card at the top centre: *"<Owner> charges N¢ to ride this teleporter."* with four buttons:
- **Pay**: taken from the wallet now (all or nothing) and paid to the owner: a player's wallet, or an NPC faction's treasury.
- **Don't pay**: you still ride.
- **Always pay** / **Never pay**: as above, and remembered for every teleporter that faction owns, so you aren't asked again.

**At the swap.** Anyone still on the pad who was asked and didn't pay rides anyway, and pays for it in standing: the owner faction's view of them drops by 5 (`TOLL_DODGE_STANDING`). With **non-payers hostile** on, the owner records a hostile act instead, so their turrets and patrols treat the rider as hostile for a while. An answer that arrives after the swap is ignored (the server logs `teleport_toll_answer_ignored`).

**Pairing with someone else's teleporter.** Select another owner's built teleporter to see **Ask to pair**, which lists your own teleporters in any sector. Choosing one sends the owner a request (`teleport_pair_request`), and they see an Accept / Decline card. Only that owner can accept. On Accept the two are paired like any other pair, and either owner can unpair. A request expires after 10 minutes.

## Testing

| Layer | File |
|---|---|
| Cycle and rules (pure) | `src/core/structures/teleportCycle.test.ts` |
| Integration | `tests/integration/sectorRoom/teleporter.test.ts`: charge capped at the jump's need, pad load, the swap with only the firing end paying, arrivals unloading, late-joiner room state, owner gating |
| E2E | `tests/e2e/teleporter.spec.ts` (`teleport-test` room, feature tier): the cargo flow, and a pilot on the pad who is warned, rides, and stays on the far pad |
| T2 unit | `src/shared-types/teleport.test.ts` (pad geometry, push direction); `src/core/physics/World.padField.test.ts` (the push in, out, off, and two worlds agree) |
| T2 integration | `teleporter.test.ts`: a pilot on pad A and a drone on pad B trade places, and the pilot's epoch bumps |
| T3 integration | `teleporterAcross.test.ts` (two real galaxy rooms): candidates by sector name, pairing both ways, the hop-based charge, the cycle in both rooms, the pad holds swapped across rooms, the pilot sent to the far sector, a parked hull rebuilt there |
| T3 unit | `LivingWorldDirector.teleportBot.test.ts`, `tests/unit/teleportClientWireParity.test.ts` |
| T4 integration | `teleporter.test.ts` (pay, don't pay → standing, always remembered); `teleporterAcross.test.ts` (a stranger can't accept a pair request; the owner's accept pairs both rooms) |
| T4 unit | `EconomyStore.test.ts` (toll preferences, treasuries); `teleportClientWireParity.test.ts` (toll and pairing senders) |
| T4 E2E | `teleporter.spec.ts` (`teleport-toll-test` room, half-speed cycle): the owner sets a toll from the inspector, a rider on the pad gets the prompt, pays, and their wallet goes down |

There is no cross-sector browser test yet: the pilot's hop is the existing warp flow (`transit_ready`), checked here at the integration level.

The `teleport-test` room seeds a powered Capital with a paired teleporter on each side, owned by a fixed id the test joins as. It uses `teleportCycleScale` and a fast grid pulse.

## Client rules in detail

Moved verbatim from `src/client/CLAUDE.md`, which keeps the short form of each rule and points here.

### Teleporter panel and inspector placement (plan soft-leaping-truffle v4, T1)

- **`components/TeleporterPanel.tsx`** mounts in the inspector for your own built teleporter. It reads the room-state row decoded into `StructureRenderState.teleport` from the mirror at 4 Hz (no Zustand). It lists pairing candidates by kind and distance, never ids. Senders live in `structureActionsClient.ts`.
- **T2 — on-pad prediction.**
  - **Walls:** `visitDerivedWalls` emits each teleporter's iris spans (blocking only while SEALED, keys from `-2e9`), so prediction and drawing follow the server walls.
  - **Push:** `syncPadFields` sets each pad's closing push in predWorld from the room-state phase.
  - **Re-seed:** an own-ship `poseEpoch` change makes `handleSnapshot` re-seed the local body at the snapshot pose with a fresh `Reconciler`, and that snapshot skips the reconcile (a snap, not a slide). `_localPoseEpoch` resets to -1 on sector handoff.
  - **Warning:** `TeleportWarning` (top-centre) is derived from room state + the mirror, never a message.
- **T4 — tolls and pairing prompts.** `TeleportPrompts` (top-centre, `order={2}`, right under the energy bar so nothing above it changes height) shows a toll (`teleport_toll` → Zustand `tollPrompt`, Pay / Don't pay / Always / Never) and pair requests (`teleport_pair_request` → `pairRequests`, Accept / Decline). They are offers, not state. The owner's toll select lives in `TeleporterPanel`; `ForeignTeleporterPanel` asks another owner to pair. Every sender has a case in `teleportClientWireParity.test.ts`.

## Server implementation notes

> Moved from `src/server/CLAUDE.md`. The short rules stay there; this is the detail.

- **`TeleporterSubsystem` (`structures/`)** owns capacitors, pairing, firing rules and the jump cycle:
  - `update` runs at 10 Hz (`structureTurretTick`);
  - `pulse` runs at 1 Hz, after production: arrivals unload, then "keep loaded".
- **Charge:** the battery pass hands surplus left after batteries to `chargeCapacitors` (a `StructureGridHooks` hook). It never discharges batteries.
- **The cycle:** both pads of a pair run ONE cycle, driven by the initiator, which spends its charge at the swap.
- **The pad hold** is its own hold row (`tppad:<uid>`, holder type 'fitted'), never base storage. Move it only through `StorageService.padLoad` / `padUnload` / `padSwap` / `takePadForSpill`, each ONE group.
- **Room state:** `tp*` / `padWeight` fields are assigned on change (A2). `tpPhaseMs` rides along only when the phase changes.
- **Persisted:** partner, rules and charge go in the sector snapshot `teleport` block (rules re-validated on restore).
- **Pairing (T1):** same sector, same owner.
- **T2 — the doors and the ride:**
  - **Phase effects:** `applyPhaseEffects` turns the pad field on while CLOSING (`SET_PAD_FIELD`) and the iris walls solid while SEALED (`tpiris-<id>-<i>`, spawned once, inactive).
  - **The swap:** `SectorRoom.swapPadShips` collects riders by liveness class (#17: ACTIVE alive players, LINGERING hulls, swarm kinds 1 and 3), then moves them all (SAB + `SET_POSITION` + pose caches).
  - **Riders' clients:** an active rider's `ShipState.poseEpoch` bumps and rides the own-ship snapshot entry (#16), and the broadcast grace is extended.
  - **Spawn clearance** treats a pad as its posts (`pushSolidBoxes`).
- **T3 — across sectors.**
  - **Links:** a partner is a `PartnerLink` (local, or remote via `TeleportBroker.find`). The initiator drives both rooms' phases (`setPhase` on the far subsystem). Charge counts hops (`hopsToSector`; test rooms outside the galaxy graph count 1).
  - **The swap:** `swapAcross` trades the pad holds (`padSwapAcross`, one group), then collects BOTH pads' riders before dispatching either:
    - pilots go via `TransitOrchestrator.teleportOut` (instant, any sector);
    - parked hulls, a disconnected pilot's included, are displaced if needed, removed quietly (`removeLingeringHullQuietly`) and rebuilt via the far room's `receiveLingeringHull`, with the roster row `markStored` to the new sector;
    - NPC bots go via `TeleportBroker.moveBot` → `LivingWorldDirector.teleportBot` (registered for both directors in `index.ts`). Never move a director bot any other way, or the director's sector record goes stale.
  - **Rooms register** with the broker on create and unregister on dispose.
- **T4 — tolls and consent pairing.**
  - **Toll:** `rec.tpToll` (`set_teleport_toll`, owner-gated, persisted in the `teleport` block, room state `tpToll` + the `TP_RULE_TOLL_HOSTILE` bit).
  - **When it is asked and settled:** the subsystem's `onArmed` hook → `offerToll` (prompts riders on that pad, skipping friends and allies; a remembered Always/Never answers at once); `answerToll` pays at once; the swap calls `onTollSettle` for both ends → `settleToll` costs non-payers standing or records a hostile act. A late answer is ignored and logged.
  - **Payment** goes wallet → wallet for a player owner, or into the owner faction's treasury (`EconomyStore.creditTreasury`, persisted). Remembered answers are `EconomyStore.tollPref`.
  - **Pairing with another owner:** `teleport_pair_request` → `TeleportBroker.addRequest` + a prompt to the owner (`sendToPlayer` reaches them in any room) → `teleport_pair_answer`; only the owner of the asked teleporter can accept. `pair(…, consented=true)` skips the same-owner check.
- Lock: `tests/integration/sectorRoom/teleporter.test.ts`. Story: [docs/features/teleporters.md](../features/teleporters.md).

# Barge crane loop: plan (owner answers in, 2026-11-19)

The owner's pick from the ship-motion mock-ups (round 2 and 3, artifact
`Cn6PdAvbnU6qP4cXDf9kXR`, card "Barge · tractors feed, gantries stow"):

> "The way that it closes the loop of how the asteroids get inside the ship
> is absolutely amazing, and I definitely want that." Later: "pretty close to
> perfect."

**What the player sees.** The Barge's tractors pull a rock chunk to the side
of the hold. A gantry crane runs along rails over the hold from the stern and
lifts the chunk. It carries the chunk over to a hatch that slides open, lowers
the chunk into the hold, and the hatch slides shut. The gantry then goes back
to the stern.

## 1. What exists today (main, 99c33ecf0)

| Need | Existing system | Where |
|---|---|---|
| Rock chunk reaches the ship | A tractor's **hold zone**: a rock piece held near a beam's muzzle goes whole into the hold as one rock chunk (`ROCK_CHUNK_PRODUCT`, hidden ore). One atomic `HoldStore.commit`, then the piece is removed and the `onCollected` hook fires. The hold zone sits **outboard** of the hull (`holdPastHull`). | `LootSubsystem.storePiece` (~412-431), `ForceFieldSubsystem.inHoldZone`, `tractorField.ts` `holdPastHull`, `onCollected` (wired in `SectorRoom.ts`) |
| Barge hull, mounts | Look A container ship. The only "gantries" are two thin painted **service gantries on the stern engine module** (role `gantry`, ~226-239), not over the hold. The hold is a container-stack deck with no hatches. `tractor-*` mounts down both sides. `barge-look` is built from the same design. | `shared-types/shipKinds/capitals/bargeDesign.ts` |
| Moving parts | **Articulation rig**: parts with hinge/slide/lift joints, timed clips, IK, mounts riding on parts, a clip record `{clipId, startTick, target}` the server writes and every client replays (late-join safe), physics bodies that already follow a ship host (`rigBodies`: `noteRigHostPose` / `setShipState`; non-plane parts get no body), and a crane that shows the goods it carries (`craneCargo`, today a flow pulse, not an object). **Only on the unreleased `feat/structure-restyle` branch.** Its clip record is **one clip, one target per host**, carried only on structure rows (`StructureState.rigClip` uint8 / `rigHold` uint16). The rig lookup `rigForStructureKind` is structure-only. | branch `feat/structure-restyle`: `src/core/articulation/`, `rigBodies.ts`, `structureRigClip.ts`, `rigCatalogue.ts`, `rigSync.ts`, `structureStateWire.ts` |
| Chunk look | Rock pieces are wreck pieces with a rock look, drawn from a seed. | `src/client/render/art/wreckPieceArt` |
| AI-flown Barges | AI ships are **swarm entities**, not `ShipState` rows; they sync over the swarm wire. | `LootCollectors.ts`, `showcaseBargeRooms.ts`, swarm wire |

So nothing new is needed as a system. The work is to put the existing rig
on a ship (the restyle plan already allows it: "It must work on ships too,
barge side doors…"), widen its clip record to more than one slot, give the
Barge a rig, and play a clip when the existing pickup fires.

## 2. Design

- **The value moves exactly as today.** The chunk enters the hold in the
  same atomic commit at the same moment. The gantry carry *shows* that
  intake; it never holds value itself. So a Barge destroyed mid-carry spills
  its hold through the existing death path, and there is never value in
  two places (owner answer Q2). When both gantries are busy, the tractors
  keep holding the next chunk until one is free (owner answer Q3).
- **One rig per Barge**, in `rigCatalogue` (extended with a ship-kind
  lookup next to `rigForStructureKind`, not a second catalogue):
  - 2 gantries: each one a slide part along the hull (deck rails either
    side of the hold);
  - a trolley on each gantry: a slide part across the beam that **runs out
    past the hull side**, because the pickup zone is outboard;
  - a hook on each trolley: a lift part (lowers into the hold);
  - hatches over the hold: slide parts.

  All of these parts are **cosmetic**. They sit on deck, above the level
  ships fly and collide at (the same rule the owner set for the carrier
  deck), so they add no physics bodies.
- **One clip slot per gantry.** The rig's clip record grows from one slot to
  a small fixed number of slots per host (two for the Barge), on both the
  structure and ship wires, shared packer. An `intake` clip runs the whole
  trip in one slot: run to the chunk, lift, carry, open the hatch, lower,
  shut the hatch, go home. Its record holds the pickup point, the hatch
  index and the chunk's look seed and size. The free gantry nearest the
  pickup gets the job.
- **No pop at pickup.** The server captures the piece's pose before it
  removes the piece, and the clip starts with the hook rock at that pose,
  drawn from the piece's own seed. Clients never get geometry over the wire;
  they derive the rock from the seed, as wreck pieces do today.
- **Generic, not Barge-coded.** Any ship kind whose rig has an `intake` clip
  gets it. Pilots and AI pilots get the same thing, because the clip is
  triggered by the intake, not by input.
- **Hull change (new art).** Deck rails along both sides of the hold and
  hatch outlines on the container deck are new paint. The gantries are new
  rig parts; the stern service gantries stay as they are.

## 3. Slices (each one change + tests, ~10–20 min agent work)

0. **Rig core on main** (dependency; owner question Q1). The generic
   `src/core/articulation/` core, `rigBodies`, `World` rig stepping and the
   clip-record wire come off `feat/structure-restyle` as their own PR,
   structure kinds unchanged. The structure-restyle stream owns that branch,
   so this is coordinated with it, never pushed to its branch.
1. **Multi-slot clip record.** The clip record holds N slots per host
   (Barge: 2). Each slot: clip id, start tick, pickup point, hatch index,
   chunk seed and size. One shared packer for structure rows and ship rows;
   structure rigs keep using slot 0. Wire version bumps where the layout
   changes. `startStructureRigClip` reuses scratch instead of allocating per
   start (#14), or carries an alloc-debt tag. Tests: two slots replay
   independently, structure clips unchanged, round-trip pack/unpack.
2. **Ships carry clips.** `ShipState` carries the clip record; the
   **swarm wire** carries it too, so AI-flown Barges show the loop
   (`SWARM_WIRE_VERSION` bump, #11). `rigSync` reads ship and swarm rows as
   well as structure rows; ship hosts reuse the `rigBodies` ship-host path.
   Tests: a ship clip and a swarm clip replay the same pose on server and
   client, including for a late joiner.
3. **Barge rig + hull paint (new art).** Rig def (gantries, trolleys that
   overhang the side, hooks, hatches) in `rigCatalogue` keyed to the `barge`
   kind; `bargeDesign` paints the rails and hatch outlines, stern service
   gantries untouched. `barge-look` checked (it shares the design).
   `SHIP_KIND_CATALOGUE_VERSION` bump (now 30). Stills behind
   `?art=machined&fx=new` go to the owner before anything else.
4. **Intake starts the clip.** From the existing `onCollected` hook (not a
   new call inside `storePiece`): for a ship kind with an `intake` clip, start
   it on the free gantry nearest the pickup, with the piece pose captured
   before removal, the hatch and the chunk seed. Value path unchanged.
   Tests: a stored chunk starts exactly one clip; the hook rock starts at the
   piece's pose; with both gantries busy the piece stays held and nothing
   is stored until a slot frees (Q3).
5. **Draw the carried chunk.** Extend `craneCargo` from a flow pulse to an
   object on the hook, drawn with the existing wreck-piece rock art from the
   seed, with a deck shadow that grows as it lifts. Zero allocation per
   frame (#14).
6. **Docs, shot, perf.** `docs/features/` guide section, a showcase shot
   (real phone, sideways, full art), and a count-based budget (clip slots
   and rig parts per Barge). Perf is judged on the phone.

Each slice gets a still or a short clip for the owner before it merges (the
owner's "screenshots before filming" rule).

## 4. Owner answers (2026-11-19, question dialog)

- **Q1 Rig on main first: lift it now.** Slice 0 lands the generic rig core
  on main on its own, coordinated with the structure-restyle stream.
- **Q2 When the chunk counts: at pickup**, as today. The gantry only shows
  the intake; nothing is lost mid-carry.
- **Q3 Both gantries busy: tractors wait.** A deck pile is ruled out (a late
  joiner could not see it). Instead the tractors keep holding the piece at
  the hold edge, and the hold-zone store does not fire until a gantry is
  free, so **the gantries cap a Barge's mining rate** (a gameplay change the
  owner chose). The waiting piece is an ordinary held wreck piece, already
  on the swarm wire, so late joiners see it. Slice 4 adds the gate: for a
  ship kind with an `intake` clip, `storePiece` is skipped while every
  intake slot is busy (one check in the existing hold-zone path, no new
  queue). Tests: with both slots busy the piece stays held and nothing is
  stored; it stores the tick a slot frees. Ships without an intake rig keep
  today's instant store.

## 5. Out of scope

The carrier (design notes in `docs/SHELF.md`), structures, sub-capitals, and
unloading the Barge's hold at a dock with the gantries (a later idea: the
gantries lift chunks back out to the dock crane).

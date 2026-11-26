# Door power plan (shield gates and shield airlocks)

Status: PLAN, not built. Owner rule (2026-11-20): "Doors stay as they were when
power dropped. If open, stay open, close stay closed, partial stay partially
open. ... being partially powered should result in them opening and closing
slowly as well if power is low."

## Today
- Door decisions: `src/core/structures/gateLogic.ts` (`stepGate`, `stepAirlock`),
  owned by `src/server/structures/GateController.ts`, 10 Hz structure tick.
  Doors flip instantly; no progress value.
- Wire: `StructureState.gateOpen` uint8 (bit A=1, bit B=2).
- Collision: `ShieldWallManager` span blocks when powered && not stunned && bit clear.
  Power loss drops the whole span today.
- Power: `Grid` is all-or-nothing (`powered = hasCapital && netPower >= 0`);
  battery rescue in `StructureGridSubsystem`. No power fraction exists.
- Doors already draw power: gate 30, airlock 50, but always at the 0.2 idle
  trickle (they never call `setActive`).
- Rigs are start-tick clips; they cannot freeze or slow mid-clip.

## Design (extend existing owners; no new system)
A. Progress 0..1 per span on the existing gate/airlock records in `gateLogic`.
   Today's open/shut decision becomes a target; pure `advanceDoor(prog, target,
   dtMs, powerFrac)` moves toward it at `dt / DOOR_TRAVEL_MS * powerFrac`.
   powerFrac 0 = frozen. Hold timers start on arrival. Airlock: an end opens only
   when the other end's progress is 0. `DOOR_TRAVEL_MS` in `gateGeometry.ts`.
B. Power fraction: `Grid.rebuild` keeps `supply`/`demand` it already sums;
   `powerSummaryFor` adds `supplyFrac` (1 if net >= 0, supply/demand in deficit,
   0 with no Capital); battery rescue forces 1. Helper file if Grid.ts > 600.
C. Door draw: reuse `StructureGridSubsystem.setActive` (DRAW_FULL) on move
   start/stop edges. Moving = full draw, still = trickle.
D. Wire: reuse `gateOpen` uint8: low nibble span A progress 0..15, high nibble
   span B. One shared pack/unpack in core. No new field.
E. Client: `derivedWalls` exposes progress; renderer eases toward it on the game
   clock; moving leaf in the dynamic layer; static hash uses fully-open bits only.
F. Collision: one shared core predicate `gateSpanBlocks` used by
   `ShieldWallManager` and `derivedWalls`/predWorld. Gate spans stop dropping on
   power loss (fence walls unchanged). Needs e2e (invariant #9) in CI.
G. Persistence: optional packed `gateProg` on the saved record; missing = shut.
H. `GateController` construction moves out of `SectorRoom` into a factory; no
   SectorRoom/StructureGridSubsystem growth.

## Slices (~20 min each)
1 advanceDoor + constant; 2 stepGate progress; 3 airlock interlock; 4 Grid
supplyFrac; 5 battery rescue = 1; 6 GateController hooks + factory; 7 wire
pack/unpack + writer + decoder; 8 gateSpanBlocks in ShieldWallManager; 9
derivedWalls/predWorld; 10 renderer; 11 persistence; 12 docs + CI netgate/e2e.

## Rejected duplicates
Rig clips as door motion (two owners for one door); a new power-ratio service
(Grid already sums both); a new door power path (setActive exists); a new wire
field (gateOpen reused); separate server/client blocking rules (one predicate).

## Hostile review fixes (2026-11-20)
- Grid does NOT keep supply/demand today (Grid.ts sums only netPower; adjustDraw
  changes only the net). Track demand in BOTH rebuild and adjustDraw, in a
  helper file (Grid.ts is 587 lines). No power fraction exists anywhere else
  (production, batteries, turrets are all-or-nothing), so this is the one.
- F reuses `isWallActive` (src/core/structures/ShieldWall.ts:80): extend it; no
  new `gateSpanBlocks`.
- E eases with `applyEase`/`easeCode` (src/core/articulation/easing.ts).
- D pack/unpack lives in src/shared-types/structureStateWire.ts beside
  `encodeConnSock`, same style.
- Readers to change: ConnectorRenderer.ts:133 static hash (fully-open bits only),
  SectorRoom.ts:2257 gateOpenMask wiring, structuresSlice.ts:196 writer.
- Teleporter chambers (Teleporter, Large Teleporter, Transit Pad; teleporter redesign T2) seal
  with blast doors on this same machinery (`src/server/structures/padDoors.ts`:
  one `DoorTrack` per pad, `doorLevelFromSupply`, `setActive` while moving; a
  free pad with no grid runs at full level). CLOSING has no timer for them: it
  ends when BOTH pads' doors are shut (`stepCycle` `doors`); a pad whose doors
  stall unpowered mid-close cancels the jump and both reopen. The Ancients'
  gate (the Astrolabe) keeps its fixed-time iris, round its outer ring (A3). Door state is not saved: it follows tpPhase.
- CLIENT GAP: the client's single wallActive flag merges "powered" and "not
  stunned". Gate spans must stay up on power loss but fall when stunned, so for
  gate kinds the server writes wallActive = not stunned; otherwise prediction
  disagrees with the server.

## Owner questions
Answers 2026-11-20:
- Half open: "Yes, the gap is real".
- Open time: 3 seconds at full power.
- Power use: full only while moving, trickle while still.
- Shut + no power: owner expected gates to already be SOLID moving doors, not
  shields. Facts: the approved restyle plan says "Gates and airlocks move onto
  [articulation] later, as a separate job"; stage 4 §9 family 2 says "gate doors
  move onto the rig system (owner, earlier)". Not built yet: today a gate is
  still a shield span between two towers.

## REVISED DIRECTION (OWNER CONFIRMED 2026-11-20)
Owner: "Yes, solid doors now"; breaking in = "Destroy the gate" (stun no longer
opens a gate); leaves = "Two halves slide apart" into the towers.
Doors are solid leaves = `physical` rig parts (articulation already supports
kinematic bodies in the physics worker). This replaces A/E/F above:
- Extend articulation with a progress-driven clip position (scrub 0..1 set by
  the owner of the state) alongside start-tick clips; no second animation system.
- GateController keeps deciding the target; advanceDoor (power-scaled) moves
  progress; the rig poses the leaves from progress; leaves are the colliders,
  so the gap is real and a frozen door blocks exactly where it stopped.
- The gate shield span goes away for gates/airlocks (fence walls between pylons
  stay shields). Stun then has nothing to drop: owner question.

## SOLID DOORS: IMPLEMENTATION PLAN (2026-11-20, supersedes A-H above)
Motion = scrubbed rig segment. `PlayingClip` gains optional `from` (clip time at
startTick) and `rate` (clip ticks per game tick, signed); t = clamp(from +
rate*(now-startTick), 0, end). Old clips = from 0, rate 1. No new message:
RIG_CLIP gains optional from/rate. Door position P integer 0..TRAVEL_TICKS*15
(180 ticks = 3 s -> 2700); power level L 0..15 = round(supplyFrac*15);
P(T) = clamp(P0 +- L*(T-t0)); one core helper `doorPosAt(seg, tick)` used by
server, worker, predWorld. Airlock: one rig, clip door-a / door-b names the
moving end; interlock on P = 0 makes both-open impossible.
Wire (existing fields): rigClip = which door clip; rigStart = t0; rigHold = P0
(12 bits, crane meaning unused on door kinds); gateOpen = bit7 target open,
bits0-3 L. Helpers encodeDoorMotion/decodeDoorMotion/encodeRigScrub in
structureStateWire.ts. ~7 bytes per segment edge; still door costs nothing.
Rigs: `gate-doors` (2 physical slide leaves, each gateGapHalf long, slide into
towers), `airlock-doors` (4 leaves). Delete gate spans from ShieldWallManager,
gateGeometry (gateSpans, gateSpanWorld, GATE_SPANS/AIRLOCK_SPANS), derivedWalls,
ConnectorRenderer hash/guide, SectorRoom gateOpenMask wiring. Gates stay fence
emitters. Stun = fence walls only; gates broken by HP. Power: gridSupply.ts
helper (rebuild + adjustDraw), supplyFrac, battery rescue = 1. Re-segment only
when L changes, min 500 ms apart (no oscillation). Deck red/green from the
motion byte. Persistence: optional doorPos/doorClip, missing = shut.
Slices: 1 PlayingClip from/rate; 2 doorPosAt + constants; 3 RigBodySet/RIG_CLIP
fields; 4 rig defs + kind map; 5 grid supply/supplyFrac; 6 battery rescue = 1;
7 gate/airlock segment state; 8 GateController posts segments + setActive +
factory; 9 wire pack/unpack + writer + decoder; 10 span removal; 11 derivedWalls
/ConnectorRenderer cleanup + deck lights; 12 persistence; 13 docs + e2e
(gate-fly-through rework, rig-sandbox kinematic collision, invariant #9) + netgate in CI.
Risks: second door clock (must use doorPosAt); leftover span code (grep
`span >= 0`, `gateSpans` after 10); shots must hit leaf bodies, not
gateWorldAxisBoxes only.

## Owner answers round 3 (2026-11-20)
- Deck light green only when FULLY open.
- Draw while crawling: owner "this is a system thing, not a building thing":
  doors follow the general grid rule (setActive full draw while moving); no
  door-specific draw scaling.
- A shut door BLOCKS GUNFIRE (shots hit leaves and damage the gate; gap lets shots through).
- Ship in the gap when the door closes: "Close and shove it out" -> drop the
  never-close-on-a-ship hold for doors; kinematic leaves push ships out.

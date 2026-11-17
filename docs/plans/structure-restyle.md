# Structure restyle + articulation — design (DRAFT v1, 2026-11-17)

Branch `feat/structure-restyle` (worktree `.claude/worktrees/structure-restyle`).
**Local only — no push, no PR until the owner signs off.**

Order of work (owner, 2026-11-17): **look first → animation sandbox → gameplay last.**
Each stage gets owner sign-off (stills for look, a short clip for animation)
before the next starts.

---

## 1. Why

Bases haven't been touched while ships and terrain grew enormous:

| Thing | Size today (units) |
|---|---|
| Fighter | ~52 long |
| Trade hauler | radius 30 |
| Destroyer | ~2,440 |
| Battleship | ~5,760 |
| Mining barge | ~7,480 |
| Rock (median / max) | 326 radius / ~10,500 |
| **Capital structure** | **560 square** |
| Line node (connector) | 64 square |

Problems seen in the audit:
- Structures are toys next to ships and rocks.
- Every collider is a plain box (`structureHullPoints` returns the footprint box),
  so you stop dead when you hit one.
- Lines are a 14%-opacity drawn line that pulses.
- Structures show no owner colour or sigil (`shipArtSprites.ts:64` passes no accent).
- "Windows" are inset emissive bands that face the camera, i.e. the sky.

## 2. Decisions so far (owner)

| Topic | Decision |
|---|---|
| Size ladder | **Small 150–300 · Medium 600–1,200 · Large 2,000–4,000 · Capital 8,000–15,000** (rare, bigger than a battleship). No extra-small tier. |
| Shapes | Avoid squares and rectangles. Use irregular or faceted outlines. **Line nodes are hexagons**, solid, so you glance off them. |
| Lines | Stay **pass-through**, drawn **below** the ship layer. Restyle them as real infrastructure (pipe, cable or conduit), not a thin pulsing line. |
| Beacon | **The Capital, restyled.** It is still the root: bank, starter power, everything links back to it. Its centrepiece is a big screen showing the owner's colours and sigil. |
| Identity | **Every** structure gets livery areas (colour + sigil slot), like ships. Reuse the ship livery system (`liveryForge`, `sigil.ts`, `teamColorOf`/`teamSigilOf`). Leave room for a PNG sigil later. |
| First deliverable | A **small refining outpost**: beacon, 2 medium docks (1 intake, 1 outlet), a modest power station, a few cargo holds, a refinery. |
| Dock size | The medium dock fits ships up to ~300 u (hauler, gunship, heavy). A medium miner ship is a later, separate job. |
| Dock trigger | **Stop = go.** A friendly or allied ship stays still in the bay for ~1 s and the arm comes out by itself. If the ship flies off, the arm aborts and retracts. |
| Intake takes | A **filter set per dock** (e.g. "ore only"). |
| Outlet gives | **Fills the hold to the brim**, or until the base runs out. |
| In/out signage | **Chevron floor strips** point into the base (intake) or out of it (outlet), in different colours. A **big lit sign** on the building shows an in/out icon and the cargo-type icon. |
| Articulation scope | **Generic.** It must work on ships too (barge side doors, pop-out weapons). Ship use itself is out of scope for now; just don't hard-code it to structures. |

## 3. The three dock layers

The game has one 2D physics plane. "Height" is draw order plus collision groups.
The physics engine needs no change.

| Layer | Example | Draw | Collides with ships |
|---|---|---|---|
| **Under** | Dock lip (hazard/chevron apron), lines | Below ships | No (no collider) |
| **Plane** | Building body, hex nodes, doors, pop-up turrets | With ships | **Yes** |
| **Over** | Crane / loading arm | Above ships | No (own collision group, or a sensor) |

## 4. Look stage (Stage 1) — what the owner will choose between

The sandbox scene renders the whole refining outpost at Ladder A sizes. Next to
it, for scale: a fighter, a hauler parked in the dock, and a destroyer.

There will be **2–3 style directions**, shown as stills on one Artifact page.
Each direction covers all of these:
- Beacon with its sigil screen
- Hex line node, plus a run of the restyled line
- Medium dock: lip, chevrons, lit sign, crane folded at rest
- Power station
- Cargo hold
- Refinery

Candidate directions (to sketch, not decided):
- **A. Faceted industrial.** Hex and chamfered polygons, heavy plating, painted
  livery bands, hazard paint.
- **B. Clustered modules.** Irregular groups of hex and round pods, with
  trusses between them. Reads as "grown" stations.
- **C. Shipyard brutalist.** Big asymmetric slabs with angled cuts and a
  dominant livery panel. Closest to the capital-ship look.

Open look questions (answered by the stills, not in the abstract):
- What replaces the sky-facing windows (lit trims along edges, beacon lamps,
  vents, glow from the work inside)?
- Where the sigil sits on each building, and how big it is.
- What the line looks like: armoured pipe, cable bundle or segmented conduit,
  and how flow is shown.

## 5. Articulation system (Stage 2) — generic, sandbox first

**Corrected by review.** A server-authored joint system already exists:
weapon mount angles on ships and structures (`StructureMountTicker`,
`WeaponMountTicker`, `structureMountAngles` on the wire,
`MountVisualManager`). Kinematic bodies also exist: `World.ts:400` uses one
for projectiles, and predWorld once ran a kinematic drone follower
(LESSONS.md:2319).

What is genuinely missing is **clips** (timed sequences), **slide joints**,
**parenting** (a mount riding on a moving part) and **IK**. Gates and
airlocks still only switch a wall collider on or off (`gateLogic.ts`,
`GateController.ts`).

So the rig is a **generalisation of mounts, not a sibling.** A mount becomes
"a hinge part whose angle is aim-driven". Its angle keeps its single owner,
`WeaponMountController.tickSlot` (invariant #12). New clip-driven joints
(slide, deploy hinge) are owned only by the clip player. A pop-up turret is
then one rig: a deploy slide part (clip) carrying the existing mount
(aim).

**Model (shared `src/core/articulation/`, not tied to structures):**
- **Rig.** A tree of **parts** attached to any host entity (structure or ship).
  Each part has a joint (hinge or slide), limits, a draw layer
  (under/plane/over), and one of two kinds:
  - **Cosmetic.** Client-only drawing.
  - **Physical.** A Rapier `kinematicPositionBased` body in the physics worker,
    driven along its path, so it pushes things predictably.
- **Clip** (the "matinee"). Keyframed joint targets over time with easing,
  e.g. `door-open`, `turret-deploy`, `arm-reach`, `arm-retract`.
- **Targeted clip.** A clip with a world target point. A closed-form 2-bone
  (or n-bone) IK solves the arm so it reaches the target, e.g. the parked
  ship's hold.
- **Determinism.** Playback is a pure function of
  `(rigId, clipId, startTick, target?)`. The server only sends that small
  record, never poses every tick, and every client reproduces the motion
  exactly. This stays cheap on the phone and works for both cosmetic and
  physical parts.
- **Authority.** The server starts clips. Physical parts are stepped in the
  worker; the client prediction world (predWorld) evaluates the same function.

**No parallel systems.** Gate and airlock doors are the obvious first thing
the rig should absorb later: a door that slides instead of toggling.
**Owner to confirm** whether gates move onto the rig in this stream or later.
Until then they are not touched.

**Sandbox deliverables (all filmed in one short clip):**
1. A door opens, a pop-up turret slides out, then both go back in.
2. A hauler flies into the dock and stops. After ~1 s the crane finds it,
   reaches over its hold, holds there (a transfer placeholder), and retracts.
3. The ship leaves mid-reach and the arm aborts cleanly.
4. Edge cases: the ship parks off-centre, the ship drifts, and two ships are
   in the bay at once.

## 6. Gameplay (Stage 3) — after look + animation sign-off

This stage needs separate approval and a hostile plan review for duplicates.

Do not build parallel to:
- **The current deposit rule.** Today you hold within 400 u of your Capital or
  Cargo Bay for 2 s and bank everything (`loot-and-cargo.md:148-200`). Docks
  must **replace** this, not sit beside it.
- **The `feat/cargo-pods` branch.** Its auto-unload toggles on ship and storage
  and its tractor-only intake overlap the dock filter. Reconcile them.
- **Trader hauler docking** outside the base footprint
  (`economy-and-trade.md`). Decide whether traders use docks.
- **The size ladder.** It rescales every catalogue footprint. That affects
  placement, link range (600 u edge-to-edge), budgets
  (`structureBudgets.ts`) and procedural NPC bases.

Rough contents:
- Beacon (Capital restyled)
- Ladder sizes
- Hex node colliders
- Dock structure with intake/outlet + filter config, stop=go, and
  fill-to-brim
- Hold ↔ network transfer through the crane
- The outpost buildings, mapped onto existing kinds (solar/reactor → power
  station, cargo bay/vault → hold, refinery)

## 7. Agent slices (each ~10–20 min, one change + its tests)

All slices work in this worktree, one at a time unless marked ∥ (can run in
parallel).

**Stage 1 — look**
1. **1a** Sandbox scene: the real game (real server, real renderer)
   behind a flag, e.g. a `?room=` scene or dev trigger that lays out the
   outpost + scale ships. Never a parallel renderer (CLAUDE.md showcase rule).
   New art sits behind an art flag (like `art=machined`) until signed off.
2. **1b** ∥ Shape kit: outline generators (hex, chamfered polygon, irregular
   cluster) that produce both the art outline and the collider polygon from
   one source.
3. **1c** ∥ Livery on structures: pass the owner accent/sigil into the
   structure bake, plus a sigil-slot field on each structure draw plan.
4. **1d** Style A art for the six outpost pieces.
5. **1e** Style B. **1f** Style C. Each ∥ after 1d, sharing the kit.
6. **1g** Line restyle: 2–3 line looks, still under-layer.
7. **1h** Stills (phone viewport, full art), sent first, then one Artifact page
   comparing the styles → **owner picks.**
8. **1i** Iterate on the chosen style until the owner is happy.

**Stage 2 — articulation**
1. **2a** Core model: rig, part, joint, clip, plus deterministic evaluation and
   unit tests. Pure code, no rendering.
2. **2b** IK reach: a 2-bone solver plus reach limits, with tests.
3. **2c** Rendering: draw rig parts on under/plane/over layers in Pixi.
4. **2d** Physics: kinematic bodies in the worker, collision groups for the
   over layer, the same evaluation on predWorld.
5. **2e** Wire: the clip-start record from server to client (the
   structure-state row, or a small event).
6. **2f** Sandbox demos (door, pop-up turret, crane reach/abort), filmed once →
   **owner reviews the clip.**
7. **2g** Fix bugs found in review.

**Stage 3 — gameplay.** Planned after sign-off.

## 8. Hostile duplicate review (2026-11-17), binding on every slice

Every slice brief says: "extend existing systems; if a new parallel one seems
needed, stop and report".

| Piece | Extend this, never a sibling |
|---|---|
| Sandbox scene | One more `scenarioLayouts.ts` entry plus an `index.ts` `.define`. The hauler flight is a `sceneScript` (SceneScriptRunner). E2E hook: the `structures` area in `featureTriggers.mjs`. **No new dev trigger.** |
| Stills | `src/client/__art-lab__/`, which already has the `scene=structures`/`base` scenes and a phone matrix. |
| Shapes / hex nodes | Replace the body of `structureHullPoints` (the single render == collider seam). **Delete the dead `STRUCTURE_SIDES`.** Concave shapes go through `core/geometry/shipHullDecomp.ts`. |
| Livery / sigil | A sigil-slot op in the `structureVisuals.ts` draw plan, then `fields.ts` `stampSigils` (the capital `sigilsOn` path). Fill the `undefined` accent at `shipArtSprites.ts:64`. |
| Style art | Per-kind `case`s in `structureVisuals.ts`, then the forge bake. |
| Lines | `ConnectorRenderer.ts`. |
| Under / over draw | zIndex bands on the existing `shipContainer` (`beamsOverHulls.ts` pattern). **No new layer containers.** Today lines are *not* below ships; they are zIndex 0 by add order. |
| Over-layer collision | One more mask in `core/physics/collisionGroups.ts`. |
| Rig joints | Generalise mounts (§5). |
| Easing | Reuse or move `engineFx.ts easeTo`, `smoothDamp.ts`, `easedSnapTurn`. |
| Kinematic parts | `World.ts`, beside the wall bodies. Heed the predWorld follower warnings (LESSONS.md:1078, :2319, :2767). |
| Clip-start wire | A field on the existing `structureStateWire.ts` row (it must also survive late join, invariant #16). |
| Stop = go trigger | **The existing deposit dwell** (`SectorRoom.autoDepositTick`, `DEPOSIT_DWELL_TICKS`/`DEPOSIT_RANGE` in `StorageService.ts`), retargeted to a bay zone. Zone admission comes from `gateLogic.ts` (`GateOccupancy`, `admittedNear`). The sandbox crane uses this too, never a fresh trigger. |
| Dock structure | **The existing `freight_dock` kind** (storage, `dockMarket` Take/Put, `freightOrders`, already built by `growBase`). The "medium dock" is `freight_dock` restyled and extended with intake/outlet + filter. |
| Arm transfer | Consider the tractor lease (`tractorField.ts`, `LootSubsystem.ts`) as the mechanism and visual for moving cargo through the arm. |

Truly new code: the clip sequencer, slide joints, parenting and the IK solver.

**Owner calls on the review (2026-11-17):**
- **Arm transfer is a physical clamp or hose.** The arm lowers a clamp onto
  the hold, and cargo moves visibly along the arm. It does not use the
  tractor beam.
- **The medium dock is `freight_dock` evolved.** Its trading features stay.
- **Gates and airlocks move onto the rig later, as a separate job.**

## 9. Still open (ask as they come up)
- The crane's reach and speed, and whether one arm serves two ships or one at
  a time.
- How intake/outlet and the filter are set: a build-menu option, or by
  clicking the dock.
- Which existing kinds survive, merge or retire in the restyle.
- The PNG sigil pipeline: where uploads live, sizes, moderation.

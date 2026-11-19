# Structure restyle: Stage 4 plan (every building, family by family)

Draft 2026-11-19, **for owner approval**. Checked by a hostile review against the code, with its
findings applied. Builds on `docs/plans/structure-restyle.md` (Stages 1–3). Branch
`feat/structure-restyle`, **unreleased** until the owner says so.

## 1. Where we really are

This is a top-down redesign of every structure: how each one looks, moves, is sized, is placed, and
plays. It is gameplay, not a reskin.

| | Done | Left |
|---|---|---|
| Building types with the new look | 6 of 45: Capital, connector, freight dock, reactor, cargo bay, refinery | 39 |
| Moving parts | crane (freight dock + Capital bay), turret pop-up hatch | every other family |
| Sizes | Only the freight dock has been deliberately resized (1000×400). By longest side, 21 types already fall inside a ladder band, 20 sit in the 300–600 gap, and 4 are off the ladder: connector 64, shield pylon 72 and turret 140 are below "small", and the alien gate at 1600 is between medium and large. The Capital is 560, nowhere near its 8–15k tier. | decide the rules, then resize |
| Collision shapes | still the footprint box for every type (hex and outline colliders were on the Stage 3 list and are not done) | all |
| Full new-look base shown to the owner | none | all |
| Bases re-seeded for new sizes | none (only dock pads kept clear) | all |

What Stages 1–3 built is the **foundation**, and it does not need building again:
- the style kit;
- the moving-parts system, which ships can use too;
- the cable lines;
- dock and crane unloading;
- the new look on by default;
- the main-sync process.

## 2. Lessons, now rules (every family slice follows these)

1. **Gameplay questions first, in plain words.** Before any drawing, write down what the family does
   in play and every way the redesign could change it. The owner answers before code. The questions
   are about what happens in play ("what should happen when..."), never "which look".
2. **Stills before clips, clips before merge.** In-game stills on a Pixel 7 held sideways (915×412),
   full art, sent to the owner first. One recording per round, then a quick review, then send it.
   Taste changes go to the owner; bug fixes don't.
3. **Hostile duplicate review before code.** Every family brief is checked against the code. We extend
   the existing system and never build a sibling (this plan's own review caught three would-be
   duplicates).
4. **Both renderers, every time.** The phone draws on the main thread and the desktop draws in a
   worker. Stage 3 drew rigs on the phone only, which hid the bay on desktop. A family is done only
   when the desktop screenshot matches the phone still.
5. **Moving parts are cosmetic unless they change play.** If a part decides something (when a turret
   can fire, where a shot starts), the server owns it, as the turret hatch does. Otherwise it is
   client-only.
6. **Small slices.** One change plus its tests per agent, about 10–20 minutes. Heavy runs go through
   `pnpm heavy`; while one waits, the next independent slice starts.
7. **No shared hot files.** Each family edits only its own files (see Phase 0). Size changes run one at
   a time in the size lane. God-file caps only go down: new code goes into new modules. This is the
   lesson from the 2026-11-19 PR backlog.
8. **Sync main daily.** The stream branch drifted 444 commits in a day, and the merge had to chase code
   main had moved into new files. Merge `origin/main` at the start of every working day, in its own
   slice.
9. **Tests bound by game time, not wall time;** randomness is pinned with a test room option.
10. **Look at what you send.** Every still and clip is checked by eye first; a staged shot is labelled
    as staged.
11. **One size source.** A type's size is its catalogue footprint, full stop. No per-scene or
    per-structure size tables (the art lab's `OUTPOST_SIZES` goes in Phase 0c).

## 3. Owner decisions (2026-11-19)

- **Sizes: the ladder is a guide.** Each family is sized on its own merits when it comes up; tiny
  types (connector, pylon, basic turret) may stay tiny.
- **Scope: small and medium structures only.** The Capital keeps its size (560) and its current
  look and crane bay. Capital-tier sizing and the large types (large teleporter, alien gate) are
  parked.
- **Wipes are fine.** The game is in active development: saved structures can be wiped whenever a
  size batch needs it. So finished batches can land on main when ready; the look can still sit behind
  a setting until it is complete. Sizes live in the shared catalogue and can't be hidden behind a
  setting.

## 4. Phase 0: set-up (before any family)

**0a: Split the shared files** so family sessions never touch the same lines:
- **Drawings:** one file per family, `structureStyleC.<family>.ts`, created **empty for all families
  up front**. The style table spreads them all. The 6 finished drawers move into their files. The
  style test reads coverage from these files instead of a fixed list of six.
- **Moving parts:** the same for rigs, in `src/core/articulation/rigs/<family>.ts`. Rig-part drawing
  gets a per-family hook instead of one switch, and the turret-hatch special case moves into the
  turrets file.
- **Art cache:** `FORGE_VERSION` (one string shared by all baked art) gets a per-family part, so a
  family's drawing change refreshes players' cached art without every family editing the same line.
- **Family names:** a family is a gameplay grouping, which is not the same as the catalogue's data
  files (`grid`, `production`, ...). One test asserts that every type belongs to exactly one family.

**0b: Art lab, extending what's there (no new scenes):**
- The existing `structures` scene gets a `kinds=` parameter. Before/after = the same capture at the
  old look and at `restyle=c`. This replaces the old design-sheet script for this job; that script only
  knows 12 types and never draws style C.
- The existing `base` scene builds from the real `growBase(profile, seed)` instead of its hand list,
  so every checkpoint shows the real generator's base at each tier.

**0d: Cable sockets (owner-approved design 2026-11-19, gameplay, before any family's look).** Every
family draws its sockets and its way in, so this is foundation, not polish. Brief, still to get its
hostile duplicate review:
- **One socket source in core.** One function gives a kind's sockets (position plus outward
  direction, in local space) from its catalogue footprint by one default rule: some per side,
  scaled by side length; connectors get six faces. A family may override its layout in its own
  file. Server, build preview and both renderers all read this one function.
- **The link rule extends `canConnect`** (`Grid.ts:256`); it is not a new check. After the hub and
  capital-only rules, find a free socket pair: the building's socket faces the partner (≤ 90°, never
  wrapping behind the building), a connector takes any side, the cable's curve does not cross
  another building (this replaces the straight centre line in `isConnectionLineBlocked`, `Grid.ts:189`),
  and socket to socket is within `CONNECTION_MAX_RANGE` (600, today measured edge to edge by
  `edgeDistance`). It returns the chosen pair, or a reason in the same `CanConnectResult` style.
- **The chosen sockets are stored on the connection,** so a cable never jumps when other links come
  and go. Saves are wiped anyway (§3).
- **Drawing:** `ConnectorRenderer` draws the smooth bend between the stored sockets instead of centre
  to centre; the socket nubs are drawn from the same list; both renderers.
- **Supply in:** the cable pulses that exist today end with a flash at the socket collar. How the
  colour then spreads across the building (the inner channel) is a hook that each family fills in
  its own look step; the fancy spread effects come in a final polish pass.
- **Placement and AI:** auto-link on placement, base growth and the AI builders all go through
  `canConnect`, so they follow the rule without their own copies. The base-layout rethink (§9)
  is designed around connectors placed with the sockets in mind.

**0d review (2026-11-19, hostile duplicate check), corrections to the brief above:**
- Sockets sit on `structureOutline` edges (`shared-types/structureKinds/outline.ts`), not the footprint
  box. Shield gates' sockets are their existing emitter posts (`gateGeometry.ts:169`), so there is one
  attach-point rule.
- Curve blocking extends `isConnectionLineBlocked` into a polyline version on the existing segment
  tests (`Grid.ts:140,172`), with the curve's box as a broad phase. The comet reuses the crane's
  polyline pulse (`structureRigs.ts:300`, `drawCablePulse`).
- Not "connectors only" today: the hub rule needs only one hub end, and shipyard, deep core rig, ore
  processing complex and assembly plant are hubs (4 slots), as are shield emitters. Slots grow +1 per
  level, so a connector reaches 10: connectors take cables from any side with no fixed face count.
- `GridNode` gains kind + rotation in all four builders (parity test). The preview passes no ghost
  angle today (`ConnectorRenderer.ts:695`), which is an existing bug. The preview blocks only against
  your own buildings while the server blocks against everyone's; fix that with the curve.
- Connections are never saved (restore re-derives them), so there is no save impact. The wire needs a
  parallel `connSock` (uint8) next to `connTo`. Both renderers share `ConnectorRenderer`, so one change
  covers both.
- growBuilder's own straight link-line test (`growBuilder.ts:44`) and `linkReachBox` move to the curve;
  bump `BASE_GROWTH_VERSION`.
- Phone cost: the preview runs `canConnect` every frame, so use facing filter, fixed nearest-first
  order, first pass wins, ~12 segments, no allocation (scratch out-param), plus a count bench. Cache
  flattened polylines per edge on the static layer; a `perf:scenes` A/B for the flow layer.
- Slices: (1) `structureSockets`; (2) GridNode kind+rotation + ghost angle; (3) curve flatten +
  polyline blocking + bench; (4) `canConnect` picks the pair; (5) store on `Connection`, growBuilder,
  version bump; (6) wire `connSock`; (7) preview; (8) static curve + cable look by arc length;
  (9) flow comet + socket flash + perf A/B; (10) socket nubs + per-family inner-channel hook.

**0c (parked):** Capital-tier sizing is out of scope (§3). Remove the art lab's `OUTPOST_SIZES` so the lab draws catalogue sizes (rule 11).

## 5. The recipe for one family

| Step | What | Who decides | Parallel? |
|---|---|---|---|
| A | **Brief:** what the family does in play; every system that reads its size or shape (checklist below); gameplay questions in plain words | owner answers | yes |
| B | **Hostile duplicate review** of the brief against the code | — | yes |
| C | **Look:** drawings in the family's own file; stills on phone (sideways) and desktop; before/after from the art lab | owner picks | yes |
| D | **Moving parts:** rig defs in the family's rig file, cosmetic or server-owned (rule 5); one short clip | owner approves | yes |
| E | **Size + shape + gameplay** in the **size lane** (one family at a time): footprint, collision shape, reach and ranges, keep-clear zones, mounts; then re-measure hand layouts and base growth, with one catalogue-version bump per batch | owner approved in A | **no, serial** |
| F | **Finish:** both renderers, phone timing (`perf:scenes`), unit tests, merge `--no-ff` into the stream | — | yes |

**Brief checklist: what reads a structure's size or shape.**
- **Linking:** link reach (600 u, edge to edge) and line blocking. Any resize changes spacing and which
  lines get blocked.
- **Collision and movement:**
  - the collision shape (`structureHullPoints`);
  - NPC pathing (`RoomNav`);
  - AI target picking;
  - projectile broadphase.
- **Turret muzzles:** where shots start (`muzzle.ts`) depends on the footprint.
- **Reach:** deposit, mining, install and repair reach are all measured from the centre.
- **Base layout:**
  - placement rules and keep-clear zones;
  - base growth and site choice;
  - NPC trade boxes;
  - structure budgets.
- **Wrecks:** wreck and break-up pieces.
- **Hand layouts and tests:** the hand layouts and the test rooms.

**Checkpoint after every two families:** stills and a short fly-through of a full grown base (art-lab
`base` scene plus one in-game NPC base) at small, medium and large. This is how the owner judges the
whole feel and the placement.

## 6. Families and order

| # | Family | Types | Gameplay to settle (examples) |
|---|---|---|---|
| 0 | Set-up | — | see Phase 0 |
| 1 | **Power + solar** (owner's pick) | solar, battery, battery bank, reactor (revisit) | Does panel area set output? Solar tracking the star (cosmetic)? Spacing? Fuel shown flowing? |
| 2 | Fences + gates | shield pylon, shield gate, airlock, territory lock | Walls run between pylon centres, and gate post sizes are constants (`gateGeometry.ts`); gate doors move onto the rig system (owner, earlier) |
| ✓ | Checkpoint 1: full base | | |
| 3 | Light production | smelter, silicon works, hydroponics, fabricator, munitions works, reclaimer, gas collector, research lab, refinery (revisit) | Production shown working without new rules? |
| 4 | Mining | miner, deep core rig | Mining reach is measured from the centre, so a resize changes reach |
| ✓ | Checkpoint 2 | | |
| 5 | Heavy industry | ore processing complex, assembly plant, shipyard | The shipyard makes ships as stored goods (no launch point today): does a finished ship visibly roll out? (new gameplay = owner call) |
| 6 | Turrets | turret, laser bolt, missile, autocannon, mine layer | Hatch exists already; the muzzle position comes from the footprint, so a resize moves where shots start |
| ✓ | Checkpoint 3 | | |
| 7 | Coastal guns | AA quad, 5 in, 8 in casemate, 11 in, 16 in barbette, Lindemann, 80 cm siege gun | Off-centre guns move the muzzle (server); arcs and facing are gameplay |
| 8 | Storage + habitation | storage vault, habitat, tower, cargo bay (revisit) | Deposit range is measured from the centre |
| 9 | Transport + docks | teleporter, pocket pad, freight dock (revisit); large teleporter + alien gate parked (large) | Pad size = teleport volume (`PAD_SPECS`) as well as the footprint |
| ✓ | Final: every base re-seeded, collision shapes done, full suite + e2e, owner sign-off, PR(s) per §3 | | |

Shield pylons sit with the fences, not power, because the walls are built from their positions.

## 7. How the work splits

- **Sessions:** this stream session is the conductor. It owns the stream branch, the size lane (step
  E), the daily main sync, merges and checkpoints. Each family gets its own session in its own
  worktree for steps A–D and F. After Phase 0, no two families share a file.
- **How many at once:** realistically two family sessions. The limits are the heavy-job queue (one
  heavy job at a time on this PC) and the owner's review rounds, not code. A third session can write
  briefs ahead of time (step A, read-only).
- **Handoffs:** each family session writes `.resume/restyle-<family>.md`. Its brief, the owner's answers
  and links to its stills and clips go in §9 of this doc.

## 8. Rough size

Stage 3 took about two days for docks, mostly building the systems. A family that reuses them is mostly
drawing plus one owner round for stills and one for the clip. Estimate: **1–2 days per family**, about
**2–3 weeks** for everything with two sessions, gated mostly by review rounds. It is honest only to the
nearest week; re-estimate after Family 1.

## 9. Family log

(Each family's brief, owner answers, and stills/clip links get added here as it runs.)

### Family 1: power + solar (started 2026-11-19)

Types: solar, battery, battery bank, reactor. Owner answers (2026-11-19):
- **Solar:** a bigger array, about 700×300, with about 4× the power for about 4× the cost.
- **Sun:** panels turn to face the sector's sun. Look only; output does not change.
- **Battery + bank:** cells on the body light up with the charge. The floating bar and number go;
  the tap panel keeps the exact figure.
- **Reactor:** dims when dry: core dark, fans stop, a small no-fuel icon.
- **Sizes:** reactor and battery bank grow to medium, about 600 across, with the same power and
  storage. The battery stays 190 (small). Bases get re-laid and saves are wiped (§3).
- **Reactor power:** 240 → 960, so it stays worth about eight solars (solar 30 → 120).
- Wireframes the owner judged from: https://claude.ai/artifact/JEHqz4FtLLy1oVe6egAmsH
- **Destroyed power buildings:** parked on `docs/SHELF.md`.
- **Reactor cost:** raised to about 4,000 to match its 960 power.
- **Base layouts:** existing hand layouts, growth spacing and test layouts are not fitted around the
  bigger solar. They get rethought from scratch ("due a rethink anyway").
- **Cable sockets (gameplay, all families):** buildings get fixed sockets that stick out from the
  edge, and cables plug into them instead of aiming at the centre. Goods and power visibly enter
  through the socket, then follow a short inner channel to where they are used or stored.
  - The cable is a smooth bend: it leaves each socket straight, then curves.
  - Buildings have more sockets than link slots. The slot limits stay as today (Capital 4, line
    node 6, everything else 1).
  - Links only ever go to connectors, as `canConnect` already enforces (hub rule plus
    capital-only-connectors).
  - The bend must be forgiving, never fickle. A building's socket reaches anything in front of it
    (up to 90° off straight-out) but never wraps round behind the building. A connector takes a
    cable from any side. Sockets sit on every side, so angle alone never refuses a nearby link.
    What refuses a link is a building on the cable's curve, the 600 reach, or a full connector.
    To put many loads on one side, the player builds or chains connectors. (The owner rejected a
    35° limit as too fickle.)
  - The server's link check and the build preview share one socket rule. This extends today's link
    rules (`canConnect`, line blocking in `Grid.ts`, `ConnectorRenderer`); it is not a second system.
    It needs its own brief and hostile duplicate review before code.
  - Concept the owner agreed from: https://claude.ai/artifact/BzZmgbLtj93fZj1298qNHn
- **New-player cost (open, from the review):** the first solar costs 4× today's. Check the starting
  credits still buy a working first base.

Found while briefing: the battery bank never charged or discharged (every battery rule checked the
kind name), and the client ignored structure level for power. The fix is in PR #958 (not yet merged
when this was written).

## Open questions for the owner

None. Answered 2026-11-19 (§3). The owner OK'd starting Phase 0 and the Family 1 brief.

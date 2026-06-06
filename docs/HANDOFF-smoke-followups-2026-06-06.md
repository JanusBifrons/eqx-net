# HANDOFF — On-device smoke follow-ups (2026-06-06)

**Branch base:** `main` @ `ae18983` (the merged PR #10 build the user smoke-tested on their phone).
**Author:** Claude (Opus 4.8) session 2026-06-06, continuing from the lag/galaxy/netgate PR.
**Audience:** the next agent who picks this up. Every claim below is grounded in a read of the
code **on main @ ae18983** — file:line refs are against that tree unless explicitly noted.

This is the consolidated handoff the user asked for: a ready-to-execute plan for the **laser
disconnect** (lead item), plus grounded notes on **missile tuning**, **speed-dial placement +
multitouch**, **auto-fire**, and **structures/buildings**. Each section gives: user report →
on-main status → root cause (CONFIRMED vs HYPOTHESIS) → exact files → fix → failing-test-first
strategy (Invariant #13) → binding invariants → open questions.

---

## How to work this list (read first)

- **Invariant #13 is non-negotiable**: for every one of these, a **FAILING test comes BEFORE
  the fix**, at the level the bug *lives*. The traps are called out per-item (the recurring one
  is the [[feedback-test-observable-reads-actual-output]] lesson — a render-bug test that reads a
  *recompute* of the pose, e.g. `data-beam-from`, is tautological and passes while the render is
  broken).
- **Invariant #8 (netgate)** binds the laser turret-aim change, the missile change, and the
  auto-fire fire-path change — all touch the live loop. Run `pnpm e2e:netgate` on a **quiet
  host**; do **not** predict from the diff. It does **not** bind the speed-dial UI work or the
  structures UI/render-overlay work.
- **Dev servers are already running** from this session on the merged main: `dev:server` (2567)
  and `dev:client` (5173, LAN `http://192.168.1.96:5173/`). If they're stale by the time you
  start, kill 2567/5173 and reboot (Claude owns the servers — see root CLAUDE.md).
- **Suggested priority:** (1) Laser detach — fully root-caused, ready, and it's the live combat
  feel bug. (2) Speed-dial placement (one-liner) + (3) structures confirm-occlusion (z-order) are
  cheap, high-visibility wins. (4) Auto-fire and (5) missile both need a **product decision from
  the user first** (flagged below) — don't code them blind.

---

## Issue 1 — Laser beam disconnect / detach  ⭐ LEAD ITEM, fully root-caused

### User report
> "Interceptor laser appears stuck/detached — the beam stays put then catches up when I turn or
> fly, and it happens with **no enemy present**." (Repro: fly forward or in circles and hold fire
> in an engineering room → it detaches consistently.)

### On-main status — the fix is ABSENT
The fix commit **`d6cd260`** ("fix(client): laser beam detach — render cache + turret aim pose")
exists **only on the unmerged branch `feat/generic-entity-pipeline`**. `git branch --contains
d6cd260` returns just that branch; **main has none of its 7 files' changes**. There is a prior
handoff doc at `docs/HANDOFF-laser-beam-detach-2026-06-04.md` — but it too lives only on that
branch (`git show feat/generic-entity-pipeline:docs/HANDOFF-laser-beam-detach-2026-06-04.md`).

> ⚠️ **Do NOT merge `feat/generic-entity-pipeline` to get the fix.** The merge-base of main and
> `d6cd260` is `b7c369b` (a GEP commit), so `d6cd260` sits atop the *entire* unmerged GEP B1–B5
> stack + the `dac6726` galaxy interim. Merging it ships all of that. **Re-apply the two fixes
> surgically to main** — and note a straight cherry-pick will NOT apply cleanly (main refactored
> `tickLocalMountAim` into the pure `tickLocalMountAngles` helper *after* d6cd260's base, and
> `PixiRenderer.ts` line numbers have shifted). Whether to instead deliberately land GEP is the
> user's separate call.

> Note: the **earlier, related** beam-*origin* fix (`ColyseusClient.liveBeamPose.test.ts` +
> `updateLiveBeam` drawing from the **mirror** pose) **IS already on main** — don't redo it. Only
> the *detach* fix (render cache + turret *angle*) is missing.

### Root cause — TWO causes, both CONFIRMED by code read on main

**(1) Render dirty-cache compares to PREV-frame, not last-DRAWN pose — PRIMARY, no enemy needed.**
In `src/client/render/PixiRenderer.ts` both the **live-beam** block (~1098–1160) and the
**remote/drone-beam** block (~882–1085) gate the `BeamSpritePool.setBeams(...)` call behind a
`dirty` flag — but the cache slot is **overwritten with the current pose every frame**, so the
comparison measures *per-frame delta*, not *drift since the last actual draw*.
- Live path: `const BEAM_EPSILON = 4.0;` (1111); `let dirty = incomingCount !== this._liveBeamCacheCount;`
  (1113); the `if (!dirty) { if (... Math.abs(slot.fromX - fromX) > BEAM_EPSILON ...) dirty = true; }`
  compare (1135–1143); slot overwrite (1144–1148); `if (dirty) this._liveBeamPool.setBeams(...)` (1154).
- Remote path: same shape — `BEAM_EPSILON = 4.0` (943), compare (1051–1061), overwrite (1062–1068),
  `if (dirty) this._remoteBeamPool.setBeams(...)` (1079).

⇒ Coasting/flying under **4 u/frame** never trips `dirty`, so `setBeams` is never called and the
**drawn** beam freezes in place while the ship flies on, snapping to catch up only when one frame
exceeds 4 u. This is exactly the no-enemy / fly-forward repro (the turret sits at base in an empty
room, so only this cause is exercised).

**(2) Turret aim casts from the PREDICTED pose while the beam is DRAWN from the MIRROR pose — secondary.**
`src/client/net/ColyseusClient.ts` `tickLocalMountAim` (4282) reads `const state =
this.predWorld.getShipState(localId);` (4287) and feeds `state.x/y/angle` into `pickTarget(...)`
(4336) and `tickLocalMountAngles(angles, catalogueMounts, activeMountIds, target, state.x, state.y,
state.angle, dtSec)` (4352–4355). But the beam is drawn from the **mirror** pose (`updateLiveBeam`
@4369 uses `ship.x/y/angle` from `this.mirror.ships.get(localId)`, 4409–4421). The reconciler-lerp
angle offset (up to ~0.5 rad mid-turn) leaks into the beam direction. Only bites with a locked
target while turning.

### Files (on main)
| File | Where | Role |
|---|---|---|
| `src/client/render/PixiRenderer.ts` | live block ~1098–1160; remote block ~882–1085 | **Bug #1.** Delete the `dirty` machinery in BOTH blocks; always call `setBeams`. Add `feedback.liveBeamRenderedFromX/Y` writes after the live `setBeams`. |
| `src/client/net/ColyseusClient.ts` | `tickLocalMountAim` 4282–4356 (state read 4287; `pickTarget` 4336; `tickLocalMountAngles` 4352–4355) | **Bug #2.** Pass **mirror** `ship.x/y/angle` (the `ship` var is already in scope @4285) instead of predicted `state.*`. |
| `src/client/combat/localMountAim.ts` | `tickLocalMountAngles` 46–74 | Pure aim helper (did NOT exist at d6cd260's base). Needs **no change** — fix is the *caller*. This is why d6cd260 won't cherry-pick cleanly. |
| `src/client/render/BeamSpritePool.ts` | `setBeams` 80–119 | `setBeams` is O(count) transform writes (no Graphics triangulation) → always-calling for 1–2 beams is free. **Add** `get renderedFromX()` (`_liveCount>0 ? _pool[0].x : null`) / `renderedFromY` (`-_pool[0].y`) for the E2E observable. |
| `src/client/app/gameRafLoop.ts` | `data-beam-from` recompute 304–322 | The tautology to avoid (recomputes origin from `localShip` pose). **Add** a `data-beam-rendered-from-x/y` publish from `feedback.liveBeamRenderedFromX/Y` (~after 322). |
| `src/core/contracts/IRenderer.ts` | `RendererFeedback` ~446 | **Add** optional `liveBeamRenderedFromX?: number \| null` / `...Y?`. Adding a `RendererFeedback` field is a **phase-gate review** per `src/client/CLAUDE.md` (per-frame postMessage payload growth). Init the fields null in `PixiRenderer` (~251). |

### Fix approach
- **Fix #1 (render, PRIMARY):** in both beam blocks, delete the `BEAM_EPSILON`/dirty consts + the
  `let dirty=...` + the `if(!dirty){...}` compare + the count-mismatch dirty set, and call
  `setBeams(...)` **unconditionally** (keep the slot-array fill — that's the data passed in).
- **Fix #1 observability:** add the `liveBeamRenderedFromX/Y` field to `RendererFeedback`, the
  `renderedFromX/Y` getters on `BeamSpritePool`, write them after the live `setBeams` (null in the
  else branch), and publish `data-beam-rendered-from-x/y` in `gameRafLoop.ts`. **If the render E2E
  uses the worker renderer**, also thread the new feedback through the worker `FEEDBACK` protocol.
- **Fix #2 (turret aim, secondary):** change `pickTarget` (4336) and the `tickLocalMountAngles`
  call (4352–4355) in `tickLocalMountAim` to use mirror `ship.x/y/angle`. Keep the
  `predWorld.getShipState` guard (the predWorld body is still the hitscan collision world) — just
  stop using its *pose* for beam geometry.

### Failing-test-first (Invariant #13)
- **Bug #1 lives at the Pixi draw boundary** → the test MUST read the **actual drawn beam**, never a
  recompute. `data-beam-from-x/y` (gameRafLoop 304–317) tracks the live ship perfectly and would
  **pass with the beam frozen** — using it is the green-but-broken trap. Correct observable:
  `RendererFeedback.liveBeamRenderedFromX/Y → data-beam-rendered-from-x/y`, read back from the
  `BeamSpritePool` sprite transform. Pattern: the branch's
  `tests/e2e/combat/interceptor-beam-stays-connected.spec.ts` — fly/coast and assert the drawn beam
  origin tracks the ship nose within a small tolerance.
- ⚠️ **UNFINISHED on the branch:** the render E2E never *cleanly* proved RED — it **timed out at 30 s**
  under `worker=0` headless software-WebGL (a timeout is **not** an assertion fail), and the re-run
  was interrupted. The next agent MUST: (a) run it on the fixed code → PASS; (b) temporarily restore
  the `if(dirty)` gate → expect a **clean assertion fail** ("drawn beam origin detached by N u"), not
  a timeout; (c) if it still times out, either bump *this spec's* budget (justified — infrastructural
  GPU cost, not game-time, per the test-harness philosophy) **or** wire `liveBeamRenderedFromX/Y`
  through the worker FEEDBACK message and use the faster default worker renderer.
- **Bug #2 lives at the ColyseusClient aim seam** → a deterministic unit test (the branch's
  `ColyseusClient.liveBeamMountAimPose.test.ts`) asserts the turret aims from the mirror pose; it
  failed pre-fix by ~0.306 rad. Re-create it on main against the `tickLocalMountAngles` caller. This
  one was already proven on the branch.

### Invariants
**#13** (failing-test-first; the render test must cross to the renderer, not recompute — the branch's
RED proof is incomplete and finishing it is the obligation). **#9** (both fixes behavioural — ship
the render E2E + turret unit lock *with* the fix). **#8 netgate** — `tickLocalMountAim` is mount-aim
(explicitly netgate-relevant) and the render loop is touched; the change is presentation-only (local
`mountAngles` are pure client prediction, never on the wire) so it *should* not move corr/drift, but
run the gate on a quiet host anyway. **#14** — always-`setBeams` adds no allocation (reuses slot
arrays + pooled sprites); getters return existing fields. **#7/#10** — `RendererFeedback` gains a
field → note the phase-gate review in `src/client/CLAUDE.md`.

### Open questions
1. The **render-cache fix has NEVER been smoke-tested on the phone** (the user's prior on-device test
   only ever saw the turret fix). That on-device confirm of the no-enemy fly-forward repro is the real
   verdict and is still outstanding.
2. Will the render E2E produce a **clean assertion FAIL** (not a 30 s timeout) under `worker=0`
   software-WebGL on this box? Decide up front: bump this spec's budget, or use the worker renderer
   path with feedback threaded through.
3. Netgate on a quiet host has not been run for this change. Expected green; confirm, don't predict.
4. Strategy: surgical re-apply onto main (recommended) vs deliberately landing GEP.

### Existing artefacts
`d6cd260` (full diff via `git show d6cd260`); the branch handoff
`docs/HANDOFF-laser-beam-detach-2026-06-04.md`; branch tests
`ColyseusClient.liveBeamMountAimPose.test.ts` + `tests/e2e/combat/interceptor-beam-stays-connected.spec.ts`;
MEMORY entries [[laser-beam-detach-fix-status]] and [[feedback-test-observable-reads-actual-output]];
cherry-pick sources still on `feat/persistent-renderer` (`4e5416e` laser, `967d803` galaxy).

---

## Issue 2 — Missile: turn-speed review + explode-on-impact-only

### User report
> (1) "review the missile turn speed" — homing turn rate feels wrong. (2) "make it only explode on
> impact" — currently it can also detonate on a proximity radius and/or a lifetime timeout.

### On-main status — CONFIRMED present & active on `ae18983`
The heat-seeker is server-authoritative; its whole lifecycle is in
`src/server/rooms/MissileSimulation.ts` (`advance()` 343–419). Fired by both players
(`PlayerFireResolver.spawnMissile` 456–457) and AI (`AiFireResolver.spawnMissile` 241–242) via
`spawnServerMissile`. The missile-frigate is the only kind that mounts `heat-seeker`. **All three
detonation triggers and `turnRate=1.5` are present and active on main** — this is the as-shipped
build; no impact-only change has been applied.

### Root cause — DESIGN/tuning, not a bug
- **Turn:** one knob — `HEAT_SEEKER_DEF.turnRate = 1.5` rad/s (`src/core/combat/WeaponCatalogue.ts:163`).
  Per-tick guidance slews `m.angle` by `maxStep = turnRate * DT_SEC` (DT_SEC = 1/60, `MissileSimulation.ts:72`),
  then rewrites `vx/vy = dir * speed`. Effective turn **radius** = `speed/turnRate` = `400/1.5 ≈ 267 u`,
  so raising `turnRate` (e.g. 2.5–3.5) tightens homing; lowering makes missiles easier to outrun.
  ⚠️ Do **not** confuse with the frigate **mount** `rotationSpeed=1.5` (`src/shared-types/shipKinds/missileFrigate.ts:89/99`)
  — that's the turret slew, a different "turn."
- **Detonation — exactly THREE triggers, all in `advance()`:**
  - **(a) Proximity fuse** — step 2, `MissileSimulation.ts:374–384`. Active only when a target is
    locked AND `def.proximityFuseRadius > 0`. Heat-seeker `proximityFuseRadius = 36`
    (`WeaponCatalogue.ts:172`) → **active today** → `detonate(..., 'fuse')`.
  - **(b) Direct sweep (impact)** — step 5, `MissileSimulation.ts:401–407` → `sweepCollision()`
    (563–604). Circle-circle vs players + swarm/drones. **This is the path to keep.** → `detonate(..., 'sweep')`.
  - **(c) Lifetime/TTL** — step 6, `MissileSimulation.ts:409–415`. `ticksRemaining` (seeded
    `def.lifetimeTicks = 360` = 6 s) hits 0 → `detonate(m, m.x, m.y, null, null, 'lifetime')` (splash-only, in place). **Active today.**
  - All three call `detonate()` → inverse-square **splash** within `splashRadius=60` + a queued
    `MISSILE_IMPULSE`.

### Fix approach
- **Turn-rate review (TASK 1):** tune `HEAT_SEEKER_DEF.turnRate` only (data). No code change.
  Quantify "feels wrong" with the user first (too sluggish vs too aggressive).
- **Impact-only (TASK 2):**
  - **(a) Drop the fuse — pure data, preferred:** set `HEAT_SEEKER_DEF.proximityFuseRadius = 0`.
    The code already short-circuits the fuse on `> 0` (`MissileSimulation.ts:375`), and the catalogue
    comment documents this as the intended "direct-hit-only" switch (`WeaponCatalogue.ts:64–66`).
  - **(b) Drop lifetime detonation — the one real code edit:** at `MissileSimulation.ts:409–415`,
    change the expiry branch to **release the missile WITHOUT calling `detonate()`** (a non-damaging
    despawn / `releaseAtPos`). **Keep `ticksRemaining` as a despawn cap** — without a TTL a never-hitting
    missile flies forever.
  - Net: only `'sweep'` (impact) deals damage. A future general `MissileWeaponDef` boolean
    (`detonateOnExpiry`/`detonateOnProximity`) would be the Open/Closed way if other missile variants
    later want different behaviour — but for one weapon the data+one-edit change is minimal-correct.

### Failing-test-first (Invariant #13)
The real observable is the detonation **cause** via `serverLogEvent('missile_detonated', { cause })`
read through `GET /dev/events` (`cause ∈ 'sweep'|'fuse'|'lifetime'`). `tests/e2e/missile-frigate-homing.spec.ts`
already reads exactly this (its `cause != 'lifetime'` assertions). **Read the actual event, not a recompute.**
- Add/extend an E2E: fire at NO valid target (or a target it will miss) → assert **no** `'lifetime'`/`'fuse'`
  `missile_detonated` and **no** `damage_applied`. Today a missed missile detonates `'lifetime'` and a
  near-miss detonates `'fuse'` → the test **FAILS on current code** (satisfies #13).
- Pair with an integration test in `tests/integration/sectorRoom/missileLifecycle.test.ts`: near-miss → zero damage.
- ⚠️ **Existing test will break and must be updated in the same PR:** `MissileSimulation.pool.test.ts:145–146`
  asserts `detonatedCount === 2` on lifetime expiry — that encodes the *old* behaviour.

### Invariants
**#8 netgate — BINDING** (`advance()` runs inside `SectorRoom.update()` @3622, feeds the snapshot
`missiles[]` slice + `MISSILE_IMPULSE` posts; both turn and detonation changes are live-loop). **#9/#13**
(behavioural; failing test first via the `/dev/events` cause). **#7/#10** — update
`docs/architecture/missile-simulation.md`, `docs/features/missiles.md`, and the `WeaponCatalogue.ts`
`MissileWeaponDef` doc-comments (which currently describe fuse + lifetime-detonate). **#11** NOT
triggered (editing numeric fields of an existing weapon def is allowed) — **but** if the missile-frigate
*ship kind* is edited, bump `SHIP_KIND_CATALOGUE_VERSION`. **#14** — `advance()` is hot-loop; the edits
remove a call / change data, add no allocation.

### Open questions (resolve with user before coding)
1. **Client VFX on lifetime expiry:** verify `src/client/render/pixi/missileSpriteUpdater.ts` + the
   `missile_detonated` handler — if the client only despawns the sprite on `missile_detonated`, removing
   the lifetime detonation may leave a lingering/abrupt sprite. Decide whether a non-damaging
   `'missile_expired'` broadcast is needed so the client can fizzle gracefully. (NOT read this pass.)
2. **"Only explode on impact" semantics:** keep splash-on-real-hit (most natural reading) vs pure
   direct-hit damage (also zero `splashRadius`)? Confirm.
3. **Turn-rate target value** is unquantified — get the user's intent.
4. Confirm no AI drone kind mounts `heat-seeker` today (none do besides the player frigate) so the AI
   fire path isn't silently affected — the change is symmetric for player + AI either way.

---

## Issue 3 — Speed-dial: placement (corner-most, right of FIRE) + multitouch

### User report
> (1) "the speed dial is in the wrong place" — should be the bottom-right **corner, right of FIRE**.
> (2) "doesn't allow me to click as I move (**still**)" — can't open the dial / tap actions while a
> steering joystick touch is held.

### On-main status — no prior fix for either
`SpeedDialMenu` still mounts at `order={30}` (`App.tsx:621`) with MUI click-driven `onOpen`/`onClick`
(`SpeedDialMenu.tsx:110–111, 122–158`); **no `onTouchStart` anywhere** in `SpeedDialMenu.tsx`. The
"(still)" confirms the multitouch limitation was reported before and remains.

### Root cause (both CONFIRMED)
- **Placement:** the `bottom-right` anchor is `flexDirection: 'row-reverse'` (`anchors.ts:167`), so
  **lowest CSS `order` = rightmost/corner-most** (`anchors.ts:62–65`; `MobileControls.tsx:181–186`).
  Current orders in that anchor:
  - `AutoFireToggleButton` `order={5}` (`App.tsx:620`) → **rightmost/corner** (lowest order). On both
    desktop + touch; auto-fire default ON.
  - `MobileControls` FIRE `order={10}` (`MobileControls.tsx:188`) — but rendered **only when
    `!autoFireEnabled`** (187). With auto-fire ON (default), FIRE is **not in the DOM** and AUTO holds the corner.
  - `MobileControls` BOOST `order={20}` (209).
  - `SpeedDialMenu` `order={30}` (`App.tsx:621`) → **highest order → LEFTMOST** — the placement the
    user is complaining about. (`SpeedDialMenu.tsx:29–34` docstring states this intent explicitly.)
- **Multitouch:** MUI `SpeedDial` opens + activates actions via a **synthesized CLICK**
  (`SpeedDialMenu.tsx` `onOpen`/`onClose` 110–111; `SpeedDialAction onClick` 122/132/141/150/158).
  Mobile browsers only synthesize a `click` from the **primary** touch sequence; a touchstart on a
  **second simultaneous** touch point (the dial, while the joystick's first touch is held) produces no
  click → the dial never opens. FIRE/BOOST escape this precisely because they bind `onTouchStart`
  (`MobileControls.tsx:194–205, 209–219`) — a raw touchstart **is** delivered to a second touch point.
  In-repo evidence of the distinction: `AutoFireToggleButton.tsx:32–37` (kept `onClick` for a single-shot
  toggle; documents that adding `onTouchStart` to a control that *also* gets a click **double-fires** →
  the `preventDefault`/dedupe guard in the fix is load-bearing).

### Fix approach
- **Placement (one-liner):** lower `SpeedDialMenu`'s `order` so it's corner-most. Literal "right of
  FIRE" = order < 10, but **AUTO at order 5 currently holds the corner** with auto-fire ON (FIRE is
  hidden then). Cleanest literal read of "bottom-right corner" = dial `order={1}`. **⚠️ Needs user
  intent** (see open Q1). Also update the `SpeedDialMenu.tsx:29–34` docstring + the `src/client/CLAUDE.md`
  "Layout Slot System" entry (it hard-codes `order={30}`).
- **Multitouch (primary):** drive the FAB open/close and each `SpeedDialAction` via `onTouchStart`
  (mirroring MobileControls), each with `e.preventDefault()` to suppress the trailing synthesized click
  (the `AutoFireToggleButton.tsx:32–37` double-fire trap). Verify MUI's `SpeedDialAction` (Fab-inside-
  Tooltip) actually forwards `onTouchStart` to the touch target. **Keep `onClick` for desktop/pointer.**
  - **Fallback:** if MUI's Tooltip/ClickAway/focus plumbing fights synthetic touch, replace the MUI
    `SpeedDial` with a minimal custom FAB + absolutely-positioned action stack (plain `Box component="button"`
    like FIRE/BOOST), **keeping every `data-testid`** (`speed-dial`, `speed-dial-fab`, `speed-dial-menu`,
    `galaxy-map-toggle`, `slot-selector`, `speed-dial-build`, `build-<id>`) + the `aria-pressed` on the map
    action so `speed-dial.spec.ts` + the keyboard-`M` assertion keep passing. Open/closed stays local React
    state (never Zustand); keep static `sx` hoisted (drawer-perf rule).

### Failing-test-first (Invariant #13)
The bug lives at the **multitouch DOM boundary** — a second simultaneous touch while a first is held —
which Playwright's single-pointer `page.touchscreen`/`.tap()` **cannot** express. Use a **CDP session**:
`const cdp = await page.context().newCDPSession(page)` → `Input.dispatchTouchEvent` with `type:'touchStart'`
carrying **two** touchPoints — point A held on `data-testid="mobile-joystick"`, point B tapping
`data-testid="speed-dial-fab"` — then assert the dial **opens** (`data-testid="galaxy-map-toggle"` becomes
visible/activatable, and tapping it as a 2nd touch while the joystick is held toggles `aria-pressed`).
- ⚠️ Confirm it's **RED on `ae18983`** first. A **single-pointer Playwright tap of the FAB already passes
  today** (`speed-dial.spec.ts`) — a test that doesn't hold a concurrent first touch is in the **wrong place**.
- **No CDP-multitouch helper exists in `tests/e2e` today** (only `tests/perf` + `tests/mobile-perf` use
  `Input.dispatchTouchEvent`, against real ADB devices) — a new helper is needed.
- Boot a touch context (`hasTouch:true`, mobile viewport) so `MobileControls` + the joystick mount
  (`MobileControls` mounts only when `isTouchDevice()` — `App.tsx ~605–607`).

### Invariants
**#13** (CDP two-touch E2E; single-pointer tap is the passes-but-misses anti-pattern). **#9** (behavioural
touch-handling change ships with the new E2E; keep `speed-dial.spec.ts` green). **#7/CLAUDE.md** (placement
change updates the `SpeedDialMenu.tsx` docstring + the `src/client/CLAUDE.md` Slot-System bullet).
**#8 netgate does NOT bind** (HUD slot ordering + UI touch handlers are not in the net/prediction/physics/
snapshot/mount-aim/SectorRoom loop). **#14 does NOT bind** (React/MUI handler code, not in a tick/render loop).

### Open questions
1. **Exact target order:** literal "right of FIRE" = order < 10, but AUTO (order 5) already holds the
   corner with auto-fire ON and FIRE is hidden. Does the user want the absolute corner (`order={1}`, right
   of AUTO too) or specifically between AUTO and FIRE? **Confirm with the user.**
2. Does MUI `SpeedDialAction` reliably forward `onTouchStart` through its Tooltip+Fab wrapper, or is the
   custom-FAB fallback required? (quick spike)
3. Verify `preventDefault` on touchStart suppresses the synthesized click without breaking desktop click.
4. Should the dial stay open across multiple action taps while steering, or close on each action as today?

### Existing artefacts
`tests/e2e/speed-dial.spec.ts` (5 single-pointer click-based tests; `openDial()` 43–46). `AutoFireToggleButton.tsx:32–37`
is the authoritative in-repo note on the touch-vs-click double-fire trap. No prior handoff/MEMORY entry for this.

---

## Issue 4 — Auto-fire "doesn't work" (needs an E2E) — ⚠️ likely WORKING AS DESIGNED

### User report
> "auto fire doesn't work (needs an E2E)."

### Root cause — CONFIRMED: hostile-only by design, and the user was likely on neutral drones
The fire path **is correctly wired and DOES read the flag**: `ColyseusClient.ts:3977`
`const autoFireEnabled = useUIStore.getState().autoFireEnabled;` gates the once-per-RAF fire block
(3978). When manual fire isn't held, `fireWanted = this.hasHostileInRange(st.x, st.y,
weaponAutoFireRange(slotWeaponDef))` (4014–4016). `hasHostileInRange` (4269–4280) scans
`this._lastAimTargets` and **skips any target whose `hostile` flag is false** (`4274 if (!t.hostile)
continue;`). That `hostile` bit = `sw.isHostileToLocal ?? false` (`LocalBeam.ts:120`), set **only** in
`updateMirror` (`ColyseusClient.ts:3596–3603`) from `_aiController.isEntityHostileToPlayer(entityId,
localId)` — which is true **only** if the drone's `HostileDroneBehaviour.hostileTo` set contains the
local playerId. `hostileTo` is populated **only** by `markHostile`, called on the client from exactly
two places: the `damage` handler (2039–2042, after the player damages a drone) and the `bot_aggro`
handler (1661–1665, server director aggro / `startHostile`).

⇒ **A neutral ambient drone the player has never shot and that has never aggroed is NEVER
`isHostileToLocal=true`, so auto-fire never engages it.** Galaxy sectors (where the user smoke-tested)
spawn drones IDLE with an empty `hostileTo`. So on a fresh sector, auto-fire correctly holds until the
player makes first contact (manual shot → `damage` → hostile) or a hunter-bot aggroes them. **This is
the designed hostile-only behaviour, present and intact on main — not a missing fix.** Hypotheses (b)
stale `_lastAimTargets`, (c) wrong range/slot, (d) flag not threaded are all **falsified** by the code.

### Fix approach — needs a PRODUCT DECISION first (do not code blind)
Two interpretations; the fix differs entirely:
1. **User expected auto-fire to engage neutral drones on sight** (most likely): the behaviour matches
   the *current design* but not the user's expectation. Either (a) keep hostile-only and treat the ask as
   "add the E2E that locks/documents the hostile-only contract" (the user literally asked for the E2E), or
   (b) **widen** auto-fire to engage neutral in-range drones — a behavioural change to `hasHostileInRange`'s
   gate (relax `if (!t.hostile) continue;` @4274), needing its own netgate run + care not to auto-attack
   everything. **Recommend NOT silently widening** — flag the trade-off ([[feedback-never-deviate-from-plan-silently]]).
2. **Genuinely broken vs a hostile** (real regression): write the failing E2E first; if it FAILS, bisect the
   `wiggly-snowflake` auto-fire commits (`c99994e`, `5b5c2a6`, `cbb1afe`) and the WebRTC default-on flip
   `9e48c31` (transport change could delay `bot_aggro`/`damage` → delay hostility on device).

Regardless, the concrete deliverable the user asked for is the **E2E**. Do not change the fire path before
a failing test exists (Invariant #13).

### Failing-test-first (Invariant #13)
The bug lives at the **browser fire-path integration** (tickPhysics reading the hostility ledger fed by
`bot_aggro`) → a Playwright E2E driving the real `auto-fire-test` room is the correct level (unit-testing
`hasHostileInRange` in isolation is the anti-pattern). The existing `tests/e2e/auto-fire.spec.ts` has
hostile→fires / toggle-off / neutral→does-not-fire — **the gap:** its hostile arm uses `startHostile=1`,
which pre-marks every drone hostile, so it **never exercises the real galaxy path** (neutral drone in range,
player hasn't shot it). New cases (in the `auto-fire-test` room, beam ship):
- **CASE A** (positive wiring lock, GREEN on main): `?room=auto-fire-test&shipKind=interceptor&startHostile=1`,
  NO input → assert fire triggers.
- **CASE B** (the case that catches the on-device report): join **without** `startHostile` (neutral fighter
  150 u ahead, in range) → assert fire **stays off** for ~1.5 s game time. Locks the hostile-only contract.
  If the product decision is to widen to neutral, this assertion **flips** and becomes the failing-first test.
- **CASE C** (realistic flow): join neutral, fire ONCE manually to damage the drone → it becomes hostile →
  release fire → assert auto-fire **continues** with no further input.
- **Observable:** `data-beam-active` (mirror `liveBeams.size>0`, `gameRafLoop.ts:302`) is OK as a *fire-intent*
  proxy, but for a stronger lock prefer a **server-authoritative** observable (hit_ack / ghost / the drone's HP
  dropping). **Do NOT** lean on `data-beam-from` xs/ys (recompute anti-pattern).

### Invariants
**#13** (E2E via the room, not a unit test of `hasHostileInRange`). **#9** (any widening ships with the E2E).
**#8 netgate** — the fire path is live-loop; any change to the gate or fire block needs the gate on a quiet host
(and it must keep measuring the **WS** path given `9e48c31` default-on DC). **Lesson** — prefer an authoritative
observable over the mirror flag/recompute.

### Open questions (CRITICAL — resolve with user before any code)
1. Did the user expect auto-fire to engage **neutral** ambient drones on sight, or to work against a drone they
   were already fighting? The fix diverges entirely on this.
2. Did their session actually have any **hostile** drone in range? (quiet sector + never fired = correct hold.)
3. Could `9e48c31` (WebRTC default-on) have delayed `bot_aggro`/`damage` delivery on device? (same-session WS-vs-DC check if Case C fails on device.)
4. Do **hunter bots** (`lwbot-*`, which `bot_aggro`) trigger auto-fire back? If hunter-bot works but ambient
   doesn't, that confirms the hostile-only-by-design diagnosis.
5. Read `docs/features/auto-fire-and-boost.md` for the intended UX contract before deciding.

---

## Issue 5 — Structures / buildings: no ghost + confirm dialog occluded

### User report
> "buildings don't really work … verify it places a **GHOST** (it does NOT) and the **confirm dialog** is
> visible and clickable (it ISN'T — it's **UNDER the UI**; I think it should be in **WORLD space**, not screen
> space)." Wants **Playwright screenshot** verification.

### On-main status & root cause — two distinct defects, both CONFIRMED
Flow: `SpeedDialMenu` "Build ▸" (`SpeedDialMenu.tsx:87,154–160`) → swaps to the 5 `STRUCTURE_KINDS_LIST`
actions (115–125) → picking a kind calls `setPlacementKind(kind)` + closes (89–95) → the Zustand
`placementKind` scalar (`store.ts:148`, setter 212) gates `StructurePlacementBanner.tsx:25` (a small MUI
Box "Place {kind} ahead?" + Confirm/Cancel) → Confirm calls `placeStructureAhead(kind)`
(`structurePlacementClient.ts:48–61`): reads the ship mirror pose, computes a fixed-clearance-ahead world
pos (`computePlacementPose` 34–42; `dist = 12 + kind.radius + PLACEMENT_AHEAD_GAP(60)`, forward `(-sinθ,cosθ)`)
and `room.send('place_structure',{kind,x,y})`. Server streams it back on the `kind===2` swarm path → renders
as a polygon via `swarmSpriteUpdater` (`buildStructureGfx`).

- **(A) NO GHOST = the known-deferred follow-up, not a regression.** `grep placementKind` across
  `src/client/render` returns **zero** matches — the only consumers are `store.ts`, `storeTypes.ts`,
  `StructurePlacementBanner.tsx`. `src/client/CLAUDE.md:117` states verbatim: *"The full tap-to-position world
  ghost (translucent silhouette + connection-range ring + live valid/invalid tint) is a follow-up that layers
  onto the same send."* Phase-2 shipped only the fixed-ahead fallback + text banner; the world ghost was
  **never built**. So "places no ghost" is the expected state of the deferred follow-up.
- **(B) CONFIRM OCCLUSION = a z-order + anchor-choice defect.** `StructurePlacementBanner` portals into the
  **`bottom-center`** Slot (`App.tsx:624`, `order={5}`), whose anchor host sits at **`zIndex: Z.hud = 10`**
  (`anchors.ts:149–160`; `zIndex.ts`). Every other interactive HUD layer is **above** it: bottom-left/bottom-right/
  top-center anchors are **`Z.mobileControls = 15`** (`anchors.ts:84,142,165`) — that includes the SpeedDial,
  AutoFireToggle, the joystick/FIRE/BOOST cluster, and EnergyBar; drawer = 1200, AppBar = 1300, overlay = 1400,
  transit = 1500. So the banner is in the **lowest interactive tier** at bottom-center of a phone screen —
  exactly where the thumb cluster + SpeedDial overlap it. The z-tier inversion (banner 10 < controls 15) is
  confirmed from code and is sufficient to explain "it's under the UI." (Exact pixel overlap not on-device measured.)

### Fix approach — two independent workstreams, both need a failing test first
**(1) GHOST (build the deferred follow-up):** render a placement preview on the Pixi canvas at the computed
placement pose. Minimal: while `placementKind` is set, project `computePlacementPose(localShip, kind)` and draw
a translucent polygon silhouette (reuse `buildStructureGfx`, the same per-subtype polygon the real structure
uses) + optional connection-range ring.
- **Invariant #2:** the preview pose is per-frame **spatial** data → it MUST live in the **render mirror**
  (e.g. a structured-cloneable `pendingPlacementPreview` field on `RenderMirror`, drained in `PixiRenderer.update`
  like `perFrameTriggers`/`explodingShips`), **NOT** Zustand. Only the discrete `placementKind` id stays in Zustand.
- **Phase-A3:** the create/reposition/clear decision goes in a pure `spriteUpdateDecisions`-style helper with unit tests.
- **⚠️ Y-FLIP:** game space is Y-up, Pixi world is Y-down (`pixiY = -gameY`, per `src/client/CLAUDE.md`) — the preview sprite must negate Y like every other world sprite.

**(2) CONFIRM OCCLUSION — two viable options (not mutually exclusive):**
- **(a) Cheap screen-space de-occlusion (recommended immediate fix):** move `StructurePlacementBanner` out of
  `bottom-center`/`Z.hud` into a tier **above** the controls (a dedicated higher-z anchor, or the
  `fullscreen`/`overlay` tier `Z.overlay=1400` with pointer-events scoped to just the buttons). Guarantees
  Confirm/Cancel sit above the SpeedDial + thumb cluster and are hit-testable.
- **(b) User's preferred WORLD-SPACE confirm:** anchor the confirm on the Pixi canvas at the placement pose.
  Feasible — `Camera.toScreen(worldX,worldY)` exists (`render/worker/Camera.ts:423–428`), `screenToWorld` (365–370)
  is the inverse — **but** the main-thread `PixiRenderer` (the touch default) exposes **no public world-to-screen
  getter today** (`toScreen` lives only on the worker-side Camera). Options: (i) draw the confirm as a Pixi-interactive
  element inside the world/overlay container and route canvas pointer hits to it (no MUI — respects "no MUI inside the
  canvas"); or (ii) project the world pose → screen each frame and position a screen-space MUI button there (needs a
  new `IRenderer` feedback field exposing the projected coord — a **phase-gate review**; handle Y-flip + off-screen
  clamping). **Recommend (2a) now**; treat the world ghost + world-confirm as the same follow-up — build the
  world-to-screen projection seam once and both layer onto it.

### Failing-test-first (Invariant #13) — user explicitly wants screenshots
- **(a) GHOST (bug lives at the RENDER layer):** boot the controlled `test-sector-fast` room main-thread
  (`?room=test-sector-fast&shipKind=scout&worker=0` — the OffscreenCanvas worker path screenshots black). Open
  dial → Build ▸ → pick a kind (`build-capital`). Assert the ghost **actually renders** — read the **real
  artifact**, not a recompute: either (i) extend `RendererFeedback` with a placement-preview count/transform →
  `data-*` attribute (the wreck/damage-number probe pattern: `__offscreen-spike__/wreck-render-probe-main.ts:101`),
  or (ii) `page.screenshot()` + `toHaveScreenshot()` golden of the silhouette at the ahead pose. **Pair the
  screenshot with the feedback-attribute assertion** so failure is loud and specific, not a pixel-diff flake.
- **(b) CONFIRM hit-test (bug lives at the LAYOUT/z-order boundary):** after picking a kind, assert the confirm
  button `toBeVisible` AND perform a real Playwright `.click()` (Playwright's actionability check **is** the
  occlusion detector — it fails if another element intercepts the pointer), then assert the `place_structure`
  effect landed (swarm-count climbs by ≥1, like `structure-build-placement.spec.ts:62–70`). **CRITICAL: run at a
  MOBILE viewport (e.g. 390×844)** — the existing `structure-build-placement.spec.ts` runs at **1280×800** (line 25)
  where bottom-center is clear of the corner clusters, which is exactly why it passes today despite the on-phone
  occlusion. A real click reaching the button at a phone viewport is the regression lock. Add a mobile-viewport screenshot too.

### Invariants
**#13** (failing test first; ghost test reads real Pixi output not a recompute; confirm test is a real `.click()` at a
mobile viewport — the existing 1280×800 spec passes *because* it dodges the overlap). **#9** (behavioural; ships with
tests). **#2** (preview pose in the render mirror, NOT Zustand). **#14** (per-frame ghost overlay + any `toScreen`
projection reuse scratch). **Phase-A3** (decision logic in a pure helper). **CLAUDE.md getFeedback phase-gate** (a new
`RendererFeedback` field for the preview transform / projected coord needs review). **#8 netgate NOT triggered** (UI +
render overlay, not the prediction/physics/snapshot/mount-aim/SectorRoom loop).

### Open questions
1. **World-space confirm shape:** (i) Pixi-drawn interactive affordance inside the world container, or (ii) MUI button
   screen-positioned at the projected world pose? Both need the world-to-screen seam; (i) is cleaner re Invariant #2 +
   "no MUI inside the canvas." **Product decision needed.**
2. **Projection seam on the main thread:** `Camera.toScreen` exists only worker-side; the touch default is the
   main-thread `PixiRenderer`, whose camera exposes no public world→screen getter today. Must read `PixiRenderer`'s
   camera/viewport field to know what to expose. (NOT traced this pass.)
3. **Render-path parity:** any new `RenderMirror` preview field must be structured-cloneable AND drained on **both** the
   main-thread `PixiRenderer` and `renderer.worker.ts`.
4. **Screenshot determinism:** goldens are flake-prone across DPR/font/GPU — make the **attribute** assertion the hard
   gate and treat the screenshot as supplementary evidence (the user asked for screenshots explicitly).
5. On mobile, the banner can also be hidden behind the dial **when the dial is OPEN** (actions render at
   `mobileControls=15`) — the de-occlusion fix must clear the expanded dial footprint, not just the collapsed FAB.

### Existing artefacts
`src/client/CLAUDE.md:117` (the "world ghost is a follow-up" statement — cite it). `tests/e2e/structure-build-placement.spec.ts`
(1280×800 UI→wire→mirror lock; passing today is itself evidence the occlusion bites only at mobile viewport).
`tests/e2e/structure-scenario.spec.ts` + the `structure-scenario-test` room / `prebuiltStructures` opts (pre-built powered
grid, good for finished-structure goldens). `src/client/structures/structurePlacementClient.test.ts` (geometry lock).
`docs/architecture/structures-and-power-grid.md:79`. `docs/plans/speed-dial-resource-structures.md` (the Phase-2 plan that
deferred the ghost). RendererFeedback probe exemplars: `__offscreen-spike__/wreck-render-probe-main.ts:101`,
`damage-number-probe-main.ts:92`. `tests/e2e/galaxy-map-pan-zoom.spec.ts` + `GalaxyMapLayer.getDebugTransform` +
`window.__eqxGalaxyTransform` (the canonical "read the REAL drawn transform" precedent to mirror for a ghost-transform DEV getter).

---

## Appendix — quick command crib

```bash
# read the prior laser handoff (lives only on the GEP branch)
git show feat/generic-entity-pipeline:docs/HANDOFF-laser-beam-detach-2026-06-04.md

# inspect the unmerged laser fix diff (DO NOT merge the branch)
git show d6cd260

# servers (Claude owns them; kill 2567/5173 then reboot if stale)
pnpm dev:server   # 2567
pnpm dev:client   # 5173 → LAN http://192.168.1.96:5173/

# inner loop (run on every change)
pnpm typecheck && pnpm lint && pnpm test

# targeted E2E (narrow + line reporter + explicit timeout; announce ETA)
pnpm e2e --project=chromium tests/e2e/<spec>.spec.ts --reporter=line

# netgate (REQUIRED for laser turret-aim, missile, auto-fire-widen — QUIET host only)
pnpm e2e:netgate

# missile detonation cause observable
#   GET /dev/events  → filter missile_detonated { cause: 'sweep'|'fuse'|'lifetime' }
```

— end of handoff —

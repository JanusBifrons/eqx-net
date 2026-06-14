# HANDOFF — Equinox Phase 5 (2026-06-14)

Pick-up doc for the next agent. Source of the work: the user's "Equinox Bugs"
Google Doc, **Phase 5** section (the latest playtest phase) + the live design
clarifications the user gave during this session (captured below).

Branch: `claude/equinox-bug-plan-ae32e1` (kept synced to `main`; each workstream
was its own PR off `main`). The user **merges PRs fast and steers mid-flight** —
branches delete on merge; re-push re-creates them; rebase the next commit onto
fresh `main` for a clean follow-up.

---

## Where we are — SHIPPED (merged to `main`)

| PR | What landed |
|---|---|
| #64 | **Scrap desync** (top priority): client scrap body was LOCKED (∞ mass) vs the server's dynamic mass-1 → correction spike. Made scrap drone-like (unlocked kinematic follower at the interpolated pose, render==collision). |
| #64 | **Laser damage falloff → LINEAR** (was reverse-square) — the user's correction. `hitscanFalloffFrac` = `1 − (1−minFrac)·t`. |
| #64 | **Structure persistence** ("structures lost on reset"): `SectorSnapshotPayload.structures[]`, reconstruct on hydrate via the `structurePlacement.place` seam. Schema 2→3. |
| #65 | **In-sector formation flying** (roaming squads): `LivingWorldDirector.formationStep()` flies a gathered idle squad in a wedge toward an arbitrary A→B destination via the new pure `core/ai/{steering,formation}.ts` (`arrive`/`seek` + slot geometry). They stay clustered → gather + spool + warp **together** between sectors. |
| #66 | **Scrap persistence**: `scrap[]` in the snapshot; collider re-derives from `(parentShipKind, componentIndex)` via the shared pure `core/geometry/scrapCollider.ts`. Schema 3→4. |
| #67 | **Lingering hulls persist forever**: `lingeringHulls[]` in the snapshot; `restoreLingeringHullsFromSnapshot` recreates the in-world `isActive=false` hull on boot. Schema 4→5. The 10-ship `ROSTER_CAP` is unchanged; ships persist once spawned until abandoned (→ wreck). |
| #68 | **Director dispatches the NEAREST roaming squad** to a ready base: `WaveDirector.assignReadyFactions` sorts spare idle squads by `hopDistance(sq.sectorKey, base)` (new pure BFS in `population.ts`). |

The whole Phase-5 set is green: typecheck · lint (0 errors) · full unit suite
(~2570) · the relevant integration suites · 8 s server boot. Every fix shipped
with a test (Invariant #13) and CLAUDE.md/doc updates (Invariants #7/#10).

**Skipped per the user's explicit instruction:** the laser "renders infinitely"
visual bug (see §2).

---

## Remaining work (priority order)

### 1. Director STATE persistence — "restart from any state" (the main remaining feature)

**The user's directive (verbatim intent):** *"The director should be flexible
enough to control ALL drones, and pick up and restart from any state. So when
the server boots, or an arbitrary event comes in like 'a base should be
attacked' trigger, it should review the pools of drones it currently has across
the entire game, and then direct the nearest roaming groups towards the player.
It absolutely should NOT ignore drones… this system is in its infancy and this
is an opportunity to make it more robust and dynamic. Eventually there will be
entire factions… multiple groups, multiple bases perhaps even within one
sector."*

The **"direct the nearest roaming groups"** half shipped in #68. This item is
the **"restart from any state"** half: make the `LivingWorldDirector` survive a
server restart.

**Why it's NOT yet done (and a genuine fork — confirm with the user):**
- The director (`src/server/livingworld/LivingWorldDirector.ts`) is
  **process-global with ZERO persistence today** — on every boot it re-seeds 24
  bots, re-homes squads at entry sectors (`start()`), and the world repopulates
  from scratch. Adding persistence is a **new architectural surface**.
- **Drones are NOT persisted via the sector snapshot** (this was deliberate, see
  §"Load-bearing facts"): they're director-owned. So director persistence is the
  ONLY way drone/squad continuity survives a restart.
- **Scope fork the user has not yet resolved:** *abstract squad-continuity*
  (persist each squad's `{sectorKey, targetFactionId, state}` + `waveCount` /
  `lastDispatchAtMs`; on boot restore those and let bots re-spawn at the squad's
  sector) **vs** *exact bot-pose continuity* (much heavier; persisting individual
  bot poses was already rejected as director-orphaning). **Recommended: abstract
  continuity** — it matches "the director picks up where it left off" without the
  orphan problem, and it's a small, bounded payload (~3 squads).

**Implementation plan (abstract-continuity version):**
1. **New persistence op + table.** Add a `DIRECTOR_STATE` op to
   `IPersistenceSink` (CRITICAL lane) + a `director_state` table (single row, or
   one row per squad). Mirror the `LIMBO_PUT`/`PLAYER_SHIP_PUT` shadow pattern.
   The director already takes injected timings; thread a persistence sink in.
2. **Persist** on shutdown (`index.ts` shutdown, before `persistence.shutdown`)
   and on a low-frequency cadence (the 1.5 s control loop tail, throttled). Write
   `[{ squadId, sectorKey, targetFactionId, state }]` + `waveCount` +
   `lastDispatchAtMs`.
3. **Hydrate** at director construction in `index.ts main()` (it's built AFTER
   the eager `matchMaker.createRoom(galaxy-*)` loop, so rooms exist). Restore the
   `SquadPool` states + targets + the `WaveDirector` maps; the existing
   `respawnStep`/`advanceMembersTowardGoal` then re-spawn bots at each squad's
   sector and resume traversal/attack.
4. **Tests:** a unit round-trip on the director-state serialize/deserialize (like
   `SectorPersistence.structures.test.ts`); an integration test via
   `bootLivingWorldTestServer` — seed a squad mid-wave, persist, recreate the
   director, assert the squad resumes its `{sector, target, state}`.

**Sharp edges:** the `BotTransitController`s (in-flight warps) are NOT trivially
serializable — accept that mid-flight transits reset to the squad's sector on
restart (don't try to persist transit timers). Keep the 24-bot pool fixed; only
the squad ASSIGNMENTS persist. Netgate not required (director loop, not the live
loop) — but run it if the persist cadence touches `update()`.

---

### 2. Laser "renders infinitely" (SKIPPED this session — screenshot-grounded)

The user reported this 3× ("goes on FOREVER", "renders infinitely"). **Confirmed
there is NO literal infinite-length bug in code:**
- The LOCAL player beam is bounded at `maxRange` (250 × `maxRangeMul` 1.5 = 375 u)
  with a solid-core + fade-tail taper (`solidDist` in
  `ColyseusClient.updateLiveBeam` → `BeamSpritePool`, P1a fix).
- REMOTE/turret/drone beams (`PixiRenderer` ~line 1382-1432) draw to the
  server-provided endpoint (bounded) but **do NOT pass `solidLen`/`solidDist`** —
  so they render a single full-length gradient with no solid-core+fade structure.
  This is the most likely remaining defect (the local-only P1a fix didn't cover
  them).

**Approach (the plan flagged this screenshot-grounded — do NOT ship a 4th blind
guess):**
1. Run a screenshot E2E (`?worker=0` forces the screenshot-able main-thread
   `PixiRenderer`; OffscreenCanvas screenshots black). Fire a beam into empty
   space, capture, look at the actual drawn extent (use
   `RendererFeedback.liveBeamRenderedFromX/Y` + a drawn-length feedback field).
   Cover a REMOTE/turret beam, not just the local one.
2. If confirmed: thread `solidLen` through the remote/turret beam render path so
   ALL beams use the two-layer model. Add an E2E that reads the drawn extent.
3. Possibly tune: the aim guide shows `range` (250) but the beam reaches
   `maxRange` (375) — decide whether the visual should stop at the guide or fade
   to the falloff tail (the user's "goes forever" may be the beam correctly
   exceeding its guide). **This is a feel decision — confirm with the user.**

Files: `src/client/render/PixiRenderer.ts` (remote beam build), `BeamSpritePool.ts`,
`beamStyles.ts`. Server falloff is already correct.

---

### 3. OPTIONAL — retire the 15-min Limbo disconnect TTL (vestigial cleanup)

The user said *"the limbo store is redundant now."* After the lingering-hull
persistence (#67) + R2.26 (in-session no-evict), the 15-min
`LIMBO_DISCONNECT_TTL_MS` is **vestigial for the lingering case** — the lingering
hull + roster + `lingeringSlots` handle reconnect/persistence; the Limbo
disconnect entry no longer gates anything user-visible. Recon confirmed setting
it to effectively-infinite "breaks nothing" (only Limbo memory grows, capped at
`LIMBO_MAX_ENTRIES`).

**This is LOW priority + RISKY (load-bearing reconnect/transit). Reproduce-first.**
The safe sequencing (recon-mapped): (a) add an atomic `PlayerShipStore.take()`,
(b) migrate the 30-s **transit-in-flight** reservation off Limbo onto
`PlayerShipStore`/the seat reservation (the role that MUST be re-homed before
deleting Limbo), (c) stop writing the disconnect Limbo entry, (d) delete
`LimboStore`. Gate every step on the green `lingering*` / `transit` /
`spiral-disconnect-reconnect` locks. **Recommendation: skip unless the user
specifically wants the cleanup — it's no longer a gameplay fix.**

---

### 4. ON-DEVICE FEEL VALIDATION (high value — several merged knobs are unverified)

Three shipped features are **feel knobs that no headless test can validate** (the
R2.25 damping saga is the cautionary tale for shipping AI-feel blind):
- **Formation flying (#65):** `FORMATION_DEST_RANGE/ARRIVE/SPACING` (in
  `LivingWorldDirector.ts`) + `MOVE_ARRIVE_SLOW_RADIUS` (in
  `HostileDroneBehaviour.ts`). Smoke: do roaming squads visibly fly in a wedge,
  slow to a stop, and warp together? Tune the constants if it reads wrong.
- **Nearest-dispatch (#68):** does the closest pack get sent? (low risk).
- **Lingering-hull reconstruction (#67):** restart a galaxy server with a
  disconnected hull present; does it reappear where it was left, visible to a
  second observer, reclaimable?
- **Scrap desync (#64):** fly into a scrap field; `data-pred-stats` correction
  rate should stay flat (the original bug). A netgate run is the objective check.

All are merged, so the user can smoke immediately.

---

## Load-bearing facts learned this session (don't re-derive these)

1. **Drones are 100 % director-owned** (`AMBIENT_DRONE_FLOOR = 0`; galaxy rooms
   boot `droneCount: 0`). Persisting drones in the sector snapshot creates orphans
   the director doesn't track → it's deliberately NOT done. Drone continuity =
   director-state persistence (item 1), a different owner. **Not "ignoring" them.**
2. **`PlayerShipStore.markActive` does NOT update `lastSectorKey`** (only
   `create`/`markStored` do). So the roster's sector field is unreliable for
   in-world ships across a transit — that's why lingering-hull persistence uses
   the SECTOR snapshot (stable `sectorKey`), not a roster scan.
3. **`findAbandonedShips` reaps only roster-DELETED ships** (`store.get(id) ===
   null`), NOT by `isActive`/`activeRoomId`. So a reconstructed lingering hull
   with a live roster row is never reaped. The reconstruction gate skips a hull
   whose roster row is gone (abandoned → wreck flow owns it).
4. **Lingering hull reconstruction recipe** (in `SectorRoom`): `freeSlots.pop()`
   → seed SAB pose → `new ShipState()` `isActive=false` → `postToWorker({type:
   'SPAWN', playerId: 'linger-'+shipInstanceId, …})` + `SET_POSITION` → register
   snapshot ring → `lingeringSlots`/`lingeringPoseCache`/`ownerlessShips=null`.
   `shipInstanceId` IS the roster `shipId` (the REKEY + abandon→wreck identity
   invariant). Run during hydrate, BEFORE any `onJoin`.
5. **Scrap collider re-derives from `(parentShipKind, componentIndex)`** — never
   persist it; `core/geometry/scrapCollider.ts` is the single source (shared by
   the death path, the client leaf, and the hydrate path).
6. **Netgate `rollingCorrRate` is high-variance** in the `feel-test-25` ram
   scenario (per-rep 0.0→1.0). A single RED median is NOT a verdict — re-run /
   characterise (it RED'd then GREEN'd on #64; the change was inert for that
   scenario). Don't widen the margin. Read the metric from the JOB LOG via the
   Actions API.

---

## Execution conventions (this repo)

- **Invariant #13 — test FIRST.** Every behavioural change gets a failing test
  before the fix, at the level the bug lives, committed together.
- **Invariant #8 — netgate** (`pnpm e2e:netgate`) for live-loop changes
  (client `net/`, `prediction/`, physics, render loop, snapshot
  decode/interpolate, mount aim, `SectorRoom` tick/snapshot). Director-loop /
  boot-hydrate changes don't need it.
- **Inner loop:** `pnpm typecheck && pnpm lint && pnpm test` + new tests + the
  8 s `timeout 8 pnpm dev:server` boot for server-touching changes. Defer the
  full suite + netgate to PR CI.
- **Commit per green milestone**; CLAUDE.md currency (Invariant #7) + a
  `docs/` prose update (Invariant #10) in the same PR.
- **Reproduce-first** for the reconnect/transit/lingering code — run the
  `lingering*` / `transit` / `abandonLingeringToWreck` integration locks as a
  green baseline before touching anything.
- **PRs:** one workstream per PR off `main`; the user merges fast. The stop-hook
  flags the upstream GitHub merge commit as "unverified" — that's a false
  positive (it's GitHub's commit, not yours; leave it). Set
  `git config user.email noreply@anthropic.com` / `user.name Claude` for your own
  commits.

---

## Suggested next-session order

1. **On-device smoke (item 4)** — validate the merged feel knobs; cheap, and it
   may surface tuning that reshapes item 1's priority.
2. **Director-state persistence (item 1)** — confirm the abstract-vs-exact fork
   with the user, then build the abstract version. This closes the Phase-5 +
   director vision.
3. **Laser render (item 2)** — only with the screenshot harness; confirm the
   stop-at-guide-vs-fade feel decision with the user first.
4. **Limbo retirement (item 3)** — only if the user wants the cleanup.

# AI Lockstep — Drone client/server alignment

This is the architecture that makes drones feel "fast" on the client without their behaviour drifting from server reality. It is the chapter-2 follow-up to the [remote-prediction](./remote-prediction.md) work that did the same thing for player ships.

The user-facing problem this solved: drones felt jittery and unpredictable in close combat — sometimes "two locations fighting over which is right and both winning." Diagnostic captures showed per-drone snap distance of 15–40 u every packet, even with the AI brain shared in `src/core` between server and client. The brain was the same; its **sensory inputs** weren't.

## The shape of the problem

`HostileDroneBehaviour.tick(self, view)` is pure: same arguments produce the same `(fx, fy, torque)` impulse on both sides. What diverged were the arguments:

| Field consumed by the AI | Server source | Client source |
|---|---|---|
| `self.x, self.y, self.angle, self.vx, self.vy` | SAB at `SLOT_*_OFF` | `predWorld.getShipState('swarm-${id}')` |
| `self.angvel` | SAB at `SLOT_ANGVEL_OFF` | `predWorld` — **never synced pre-fix** |
| `view.players[].x/y/vx/vy` | `shipPoseCache` from SAB at `serverTick` | `predWorld.getShipState(pid)` |
| `view.tick` | `serverTick` | `inputTick` |
| `view.dtSec` | 1/60 | 1/60 |

Pre-fix, the binary swarm packet (the only path that re-anchored drone state on the client) carried x/y/vx/vy/angle but **not angvel**. Server's behaviour applied a `1.5·ω` damping term using the live SAB ω; client's behaviour applied the same term using whatever ω predWorld's Rapier integration happened to settle on, which had never been reset to match. Damping diverged every tick, drone bearing diverged, snap distance grew toward `LEAD_TICKS × velocity × dt` and stayed there — because the gap re-opened as fast as the binary packet could close it.

## What chapter 2 shipped

Three structural changes plus one critical follow-up. Files cited inline.

### Phase A — wire-format v3 with `angvel`

[`src/shared-types/swarmWireFormat.ts`](../../src/shared-types/swarmWireFormat.ts) bumps `SWARM_WIRE_VERSION` from 2 to 3 and inserts `f32 angvel` at offset +24 between `angle` and `radius`. The record grows from 29 to 33 bytes (+14% wire cost — about 24 KB/s/client at 100 drones × 60 Hz, negligible against the existing envelope).

| Offset | Type | Field |
|---|---|---|
| +0 | u16 | entityId |
| +2 | u8 | kind |
| +3 | u8 | recordFlags (bit 0 = SLEEPING) |
| +4 | f32 | x |
| +8 | f32 | y |
| +12 | f32 | vx |
| +16 | f32 | vy |
| +20 | f32 | angle |
| **+24** | **f32** | **angvel (NEW)** |
| +28 | f32 | radius |
| +32 | u8 | shipKind |

The decoder hard-fails (silent drop) on `version !== SWARM_WIRE_VERSION`. Old clients connected to a v3 server will see drones go quiet — that's policy, not bug.

[`SwarmEntityRegistry.poseChanged`](../../src/server/net/SwarmEntityRegistry.ts) considers `|Δω| > 0.05 rad/s` as a delta-shipping trigger so drones spinning in place still get fresh packets. [`BinarySwarmBroadcast.encode`](../../src/server/net/BinarySwarmBroadcast.ts) zeroes `angvel` on SLEEPING records (parity with vx/vy). [`syncSwarmIntoPredWorld`](../../src/client/net/ColyseusClient.ts) passes `angvel` through to `World.setShipState`, which calls `body.setAngvel(state.angvel, true)` — the second arg wakes the body, so a sleeping drone with a real server-side spin doesn't silently keep its stale ω.

### Phase B — per-drone snap diagnostic

[`src/client/net/ColyseusClient.ts`](../../src/client/net/ColyseusClient.ts) emits a `swarm_snap_diagnostics` log event on every binary swarm packet that snaps an existing drone, throttled to one event per drone per 4 server ticks (so the 500-entry log ring isn't dominated by snap events). Payload:

```ts
{
  entityId, kind, shipKind,
  pre:  { x, y, angle, angvel },   // predWorld pose pre-snap
  post: { x, y, angle, angvel },   // packet pose
  snapDistance: hypot(dx, dy),
  angleSnap: abs(normalizeAngleDelta(post.angle - pre.angle)),
  angvelDelta: abs(post.angvel - pre.angvel),
  serverTick, inputTick,
}
```

Bucketed to `corrections` in [`diagRouter.ts`](../../src/server/routes/diagRouter.ts) (parallel to the local-ship `correction` event). Five new fields surface on `PredictionStats` via the existing `data-pred-stats` DOM attribute: `swarmSnapP50`, `swarmSnapP99`, `swarmAngleP99`, `swarmAngvelP99`, `swarmSnapCount`. Dev overlay, `getPredStats()`, and `__getPredStats()` all see them.

This event is the regression signal for the rest of the chapter — without it we were inferring drone-side problems from `correction.driftUnits`, which is a local-ship signal entirely.

### Phase C — drone reconcile anchor

[`src/shared-types/messages.ts`](../../src/shared-types/messages.ts) extends `SnapshotMessage` with an optional `drones[]` slice carrying per-id `{ x, y, vx, vy, angle, angvel }` for every in-interest drone at `snap.serverTick`. [`src/server/lagcomp/SnapshotRing.ts`](../../src/server/lagcomp/SnapshotRing.ts) goes from 5 to 6 floats per slot to carry angvel (480 KB → 576 KB per sector). [`SectorRoom.update`](../../src/server/rooms/SectorRoom.ts) populates the drones slice from `SnapshotRing.getPoseAt(id, serverTick)` so it's temporally aligned with the player states.

[`Reconciler.reconcile`](../../src/core/prediction/Reconciler.ts) accepts an optional `replaySeed.drones: Map<key, ShipPhysicsState>`. Before the existing replay loop, it resets each drone's predWorld body via `world.setShipState(key, dronePose)`. The `perReplayTick` callback runs `tickClientAi` on each replay step, so drones get re-ticked with the correct AI brain across the same window the player input is replayed across. (As of Phase D below this re-sim is **relevance-scoped** to the NEAR set — read Phase D before assuming it ticks every drone.)

[`ColyseusClient.handleSnapshot`](../../src/client/net/ColyseusClient.ts) builds the seed map from `snap.drones`, keyed `swarm-${entityId}` to match the existing predWorld swarm-body naming. Drones the client doesn't yet have a body for (will be spawned by the next binary packet) are skipped.

### Phase C follow-up — snapshot is the single source of truth for in-interest drones

**This is the load-bearing fix.** The initial Phase C (above) added the snapshot anchor without removing the pre-existing binary-packet `setShipState` path. Both paths reset drone state, at different cadences, to different targets:

- **Snapshot path** (20 Hz): seeds drones at `snap.serverTick`, then replay advances them through `currentTick − ackedTick` ticks of AI. Final predWorld pose is at `currentTick` (forward-extrapolated).
- **Binary packet path** (60 Hz): unconditionally calls `setShipState` to server's pose at packet emit, which is `~serverTick` (behind `currentTick` by ~`leadTicks` worth of motion).

Every binary packet pulled predWorld backward by `leadTicks` worth of motion, restoring exactly the divergence the snapshot path had just fixed. The mobile capture `2026-05-09T17-25-27-695Z-82ncsd` showed snap distance **tripled** vs the pre-Phase-C baseline — the two paths cancelled, and the spring offset path that smoothed the residual fired constantly. User saw "two positions fighting over which is right and both winning."

The fix: track which drones the most recent snapshot anchored.

```ts
// ColyseusClient.handleSnapshot, after building droneSeed
this._droneSnapshotAnchored.clear();
for (const d of snap.drones) {
  this._droneSnapshotAnchored.add(d.id);
  // ... build seed map ...
}
```

Then in [`syncSwarmIntoPredWorld`](../../src/client/net/ColyseusClient.ts):

```ts
const skipSetShipState = entry.kind === 1 && this._droneSnapshotAnchored.has(entityId);
if (!skipSetShipState) {
  this.predWorld.setShipState(key, { x, y, vx, vy, angle, angvel });
}
// ... spring-offset capture is also gated on !skipSetShipState ...
// ... but the swarm_snap_diagnostics event still fires for ALL drones, so the
//     metric stays observable regardless of which path applied.
```

For drones the snapshot anchored, predWorld stays at its post-replay forward-extrapolated pose. The binary packet still updates `mirror.swarm` (which is what the asteroid renderer's `interpolateSwarmPose` reads), but doesn't touch predWorld. Out-of-interest drones — not in the anchor set because the snapshot didn't carry them — fall through to the legacy binary-packet path unchanged. Asteroids (`kind === 0`) always go through the binary path; they have no AI to lockstep.

The anchor set is rebuilt from scratch each snapshot, so a drone leaving interest drops out automatically and its next binary packet re-anchors it.

### Phase D — relevance-culled replay (Option A, 2026-05-17)

Phases A–C made the per-replay-tick `tickClientAi` re-sim *correct*. It was not *scalable*: it is inherently **O(ticksAhead × N)** — every replayed tick re-ticks every in-interest drone's brain *and* `world.tick()`-integrates its body. Phone diag `2026-05-16T20-03-36-048Z-a3f5na` measured **116–266 ms client frame stalls** on a sector change (ticksAhead spiked to 44–49 while the living-world pack re-funnelled); headless measurement put the replay at **~48 ms at N=500 / ticksAhead=48** ≈ 3× a frame. The architecture targets ~500 entities/sector, so this is a client scaling defect that must **scale, not throttle**. There is no free lunch: tick-perfect N-drone lockstep is *intrinsically* O(ticksAhead × N).

Option A spends that fidelity only where the player can perceive it. Each snapshot, [`partitionDronesByRelevance`](../../src/core/prediction/droneRelevance.ts) splits the in-interest drones into:

- **NEAR** — hostile to the local player, OR within `DRONE_RELEVANCE_RADIUS` (= `HITSCAN_RANGE × 2`, a catalogue-derived combat-range multiple), OR last snapshot correction > `DRONE_SNAP_RELEVANCE_U`. Tick-accurately re-simmed through [`AiController.tickOnly(NEAR, …)`](../../src/core/ai/AiController.ts) in `perReplayTick` — full Phase-A–C lockstep, preserved exactly where it is visible.
- **FAR** — everything else. **Dead-reckoned, NOT frozen.** No brain re-sim, but `replaySeed` re-anchors them to the server-authoritative pose and the (unfrozen) replay `world.tick()` integrates them ballistically — they keep their linear motion; only the AI *curve* over the window is lost, which for a stable far drone is tiny. The expensive thing we cull is the per-drone `HostileDroneBehaviour.tick`; the body integration is cheap and was always O(N).

Replay **brain** re-sim becomes **O(k × ticksAhead), k ≪ N**. `tickOnly` iterates the NEAR set, NOT a predicate over the full registry — a predicate-over-`tick` was measured and rejected because it keeps the O(ticksAhead × N) Map scan even when it culls the expensive brain work (17.2 ms / 1.93×-in-N vs `tickOnly`'s ~12.5 ms; see `docs/LESSONS.md` 2026-05-17).

**Why dead-reckon, not freeze (the load-bearing correction).** FAR was *first* implemented as a `Reconciler.reconcile(freeze)` lock (mirroring the abandoned `814d7bc` blanket WIP). The quiet-host `feel-test-lockstep` canary caught a real regression every deterministic gate passed: `swarmSnapP50` **11→20**, `swarmAngleP99` **0.1→1.2** vs `main`. A *frozen* FAR body is held at the `ackedTick` anchor for a whole snapshot interval while `_droneSnapshotAnchored` gates off the binary correction, so it accumulates and snaps the full missed motion. Dead-reckon keeps the linear part → `swarmSnapP50` **1.6** (7× *better* than `main`'s 11.1, because ballistic extrapolation from the authoritative anchor beats `main`'s predicted-input re-sim for stable far drones). The freeze/`unlockBody` plumbing was reverted; `Reconciler.ts`/`World.ts` are unchanged from `main`.

This is **prediction-only**: the server still simulates every drone authoritatively, so culling the client's replay re-sim cannot change authority — it only chooses where to spend client prediction fidelity. The partition is recomputed every snapshot (~20 Hz), so a FAR→NEAR transition (the player flies toward a far drone) is picked up within one snapshot; the `_droneRenderOffsets` render spring masks that single-snapshot catch-up. The "one correction path per state surface" rule below is intact: the SAME `tickClientAi` / `AiController` path advances NEAR drones, only scoped — no second reset path is introduced. Full rationale, the §6 fork decision, and the measured numbers: [`docs/architecture/reconciler-replay-scaling.md`](reconciler-replay-scaling.md). Scaling lock: [`tests/integration/reconcilerReplayScaling.test.ts`](../../tests/integration/reconcilerReplayScaling.test.ts).

## The result, locked

Mobile capture `2026-05-09T17-52-07-928Z-qcub4y` after the chapter-2 fix shipped:

| metric | pre-chapter-2 | broken initial Phase C | **post fix** |
|---|---|---|---|
| swarmSnapP50 | ~3.5 u | ~15 u | **~5 u** |
| swarmSnapP99 | 17.86 u | 39.40 u | **9.92 u** |
| swarmAngleP99 | 0.065 rad | 0.154 rad | **0.057 rad** (~3.3°) |
| swarmAngvelP99 | unbounded pre-Phase-A | 0.029 rad/s | **0.013 rad/s** |
| corrections rate | varied | varied | **5%** |
| spring offset firing rate | 100 % per snap | 100 % per snap | **~0% for in-interest drones** |

User: "Holy fucking shit. Almost flawless. This is a huge milestone."

The regression lock is [`tests/e2e/feel-test-lockstep.spec.ts`](../../tests/e2e/feel-test-lockstep.spec.ts), which drives a Playwright client through the `feel-test` engineering room (10 drones tightly ringed at origin, player anchored at 0,0) and asserts on `swarmSnap*`, `swarmAngle*`, `swarmAngvel*` plus server `gc_pause` and `tick_hitch` counts. The p50 thresholds catch architectural regressions (any return toward pre-fix steady-state). The p99 thresholds tolerate V8 GC noise on the test runner — desktop p99 occasionally spikes when a long scavenge drops several snapshots; mobile doesn't see this because the human player and a real device GC differ from the test environment.

## The architectural rule that came out of this

> **One correction path per state surface.** When two paths both reset the same predicted state at different cadences and to different targets, they cancel each other and produce visible oscillation. If you're adding a NEW correction path (snapshot anchor, schema sync, etc.) for state that already has an EXISTING correction path (binary packet, RPC, etc.), you must REMOVE or GATE the existing path — don't run both.

The diagnostic signature of this class of bug is distinctive: per-event metrics get **worse** after a fix that "should help structurally," not better. If you see that pattern, look for two reset paths.

## Scope and known limits

- **"Lockstep" here means client ↔ server, not client ↔ client.** Each client reconciles only against the server. Two players in the same room receive different `snap.drones` slices (each one's 9-cell interest window), and their replays therefore see different drone reseed populations. This is correct — multi-client coherence is a separate problem the architecture doesn't promise to solve.
- **Out-of-interest drones rely on the binary-channel cadence.** Drones outside a recipient's 3×3 spatial-grid window aren't in `snap.drones`; they get the legacy binary-packet path with its decimated cadence. Acceptable trade-off because they cannot collide with the local ship inside a snapshot window.
- **The post-replay live AI tick still uses predicted player pose.** Client AI on the live (post-replay) tick reads `predWorld.getShipState(localId)`, which is the player at `inputTick` — forward-predicted past where server has seen the player. Server's AI at server-tick uses player at server-tick. The first-replay-tick alignment Phases A + C together produce closes most of this gap; the residual shows up only on aggressive sharp-turn manoeuvres and was small enough to be invisible at the milestone capture.

## Future improvement noted but not shipped

A history-replay design would replace the input-driven replay with **per-tick player-pose lookup**. Server would keep a 12-tick player pose ring and ship a `players_history[]` slice in the snapshot (~12 ticks × 24 bytes/player ≈ 300 B/player). The client's reconciler would replay drones against those historical poses instead of input-driving the player. This eliminates the AI's input-prediction divergence entirely. Mobile feel is already excellent without it; the design is parked in `C:\Users\alecv\.claude\plans\i-m-starting-to-lose-zesty-blanket.md` under "Deferred" for if the residual sharp-turn outliers ever become a real complaint.

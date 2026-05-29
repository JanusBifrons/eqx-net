# HANDOFF — swift-otter (WebRTC DataChannel snapshot transport)

Date paused: **2026-05-29** ~22:10 local
Branch: **`integration/four-branches`**, 8 swift-otter commits beyond `8c593d5` Phase -1
HEAD: **`9033cf6`** — `fix(net): two real WebRTC integration bugs found via Phase 4 iteration (plan: swift-otter, Phase 4 iteration 2)`
Status: **UNPUSHED.** User's call to push.

User direction at end of session: **"continue on this route — it has legs and we should complete it."** No pivot to jitter buffer; finish the plan.

---

## Where the work stopped

Phases 0–4 (skipping Phase -1 per session-start direction) ALL committed locally. The implementation is FUNCTIONAL end-to-end. Phase 4 measurement shows **60 % gap reduction** under synthetic Pattern B — close to but below the plan's 70 % gate, inside the plan-mandated 30-70 % "may help but not decisive, user decides" range.

The work pivoted from "synthetic metric below gate, must be inherent" to "actual integration bugs hiding the real signal" after the user pushed back. Two real bugs surfaced + fixed.

---

## The two real bugs and their root causes

### Bug 1: receiver's reorder guard wrongly dropped duplicate-tick frames

**Symptom**: Phase 4 E2E showed `snap_dropped_old = 30 %` of received DC snapshots. For `ordered: true` SCTP on loopback that's impossible per the wire spec — unless the SENDER is producing duplicates.

**Pivot moment**: The high-rate diagnostic spike at [`scripts/webrtc-spike-high-rate.ts`](../scripts/webrtc-spike-high-rate.ts) — pure node-datachannel ↔ Chromium with msgpackr-encoded snapshots at 20 Hz for 10 s — delivered **200 / 200** in both reliable and unreliable modes. So the wire is clean. The bug had to be in our integration.

**Root cause**:
- `broadcastCounter++` in [`SnapshotBroadcaster.broadcast`](../src/server/rooms/SnapshotBroadcaster.ts) fires on every main-thread `update()` (60 Hz).
- `serverTick = d.serverTick()` is **SAB-read from the physics worker**, which can advance 0, 1, or 2 ticks per main-thread tick (root [`CLAUDE.md`](../CLAUDE.md) acknowledges the 60 Hz / 60 Hz drift — see the `broadcastCounter` comment in `SnapshotBroadcaster.ts:11-14`).
- When the worker stalls, the main thread broadcasts `snap.serverTick === lastBroadcastTick` — semantically a no-op idempotent re-apply.
- **WS path**: client harmlessly re-applies (existing `handleSnapshot` is idempotent state-set). Wasted bytes, invisible effect.
- **DC path**: receiver's strict `<=` guard (inherited from the hostile-#5 `ordered: false` unreliable-mode design) dropped them as `snap_dropped_old`. This made the Phase 4 metric look like ~30 % loss.

**Fix**: [`DataChannelSnapshotReceiver.handleBinary`](../src/client/net/dataChannelTransport.ts) — `<=` changed to `<`. Equal-tick frames now pass through to the same apply pipeline the WS arm has always run. Strictly-older frames still drop — that's the legitimate hostile-#5 case for unreliable mode.

**False trail I went down first**: I tried fixing at the SERVER (skip the broadcast when `serverTick` hasn't advanced). That eliminated duplicates but ALSO dropped per-client perceived rate from 20 Hz to ~14 Hz, because skipped broadcasts sometimes coincided with the per-client phase-stagger gate firings — so BOTH transports lost 2-5× snapshot throughput. Reverted. **The receiver-side fix is structurally correct**: duplicates are wire-level harmless and the apply pipeline doesn't care.

### Bug 2: `ColyseusGameClient.dispose()` leaked the `_dataChannelTransport`

**Symptom**: pre-fix iteration showed `snap_dropped_old` counts that varied widely across reps (8, 33, 37, 42) — same code path, same workload.

**Root cause**: [`src/client/main.tsx`](../src/client/main.tsx) wraps the app in `<StrictMode>`. React 18 dev runs every `useEffect` as mount → cleanup → mount. The cleanup called `gameClient.dispose()` (in [`App.tsx`](../src/client/App.tsx) `:325`) but [`dispose()`](../src/client/net/ColyseusClient.ts) didn't touch `_dataChannelTransport`. So the first instance's PeerConnection stayed open while the second instance opened its own. Both wrote to the same `__eqxLogs`. The brief overlap added variance + extra duplicate-tick drops on top of Bug 1.

**Fix**: `dispose()` now closes the DC transport BEFORE calling `room.leave()` so the signaling channel is shut down before the WS closes. The reorder guard fix (Bug 1) already eliminates the drops; this fix tightens the variance.

---

## Post-fix results (`9033cf6`)

Single Phase 4 run, 3 reps each arm, Pattern B (3× 400 ms latency bursts):

| Arm | recv_gap_long counts | median | IQR | snapshots received |
|---|---|---|---|---|
| WS (`?webrtc=0`) | [21, 12, 15] | 15 | [13.5, 18] | [143, 111, 114] |
| DC (`?webrtc=1`) | [17, 6, 4] | **6** | [5, 11.5] | [107, 49, 22] |

- `drop_old = 0` in every DC rep. The receiver guard fix worked.
- `dc_frac = 1.000` in every DC rep. 100 % of snapshots routed via DataChannel as intended.
- `webrtc_connected = true` in every rep.
- **60 % gap reduction** (DC median 6 vs WS median 15). Below the plan's ≥ 70 % gate.

Control test (`?webrtc=1`, no network injection):
- `webrtc_connected = true`
- 28 snapshots in 10 s = 2.8 Hz
- 5 `recv_gap_long` (control assert was ≤ 2 — still fails, but the absolute count is much smaller than the pre-fix 16-22).

---

## The remaining unknown — DC throughput variance

DC arm got `[107, 49, 22]` snapshots in 10 s windows. WS arm consistent at `[143, 111, 114]`. Wire diagnostic showed 200 / 200 with similar workload — so it's NOT the wire.

**Three working hypotheses for tomorrow:**

1. **Host load** (most likely). The Phase 4 E2E runs Playwright + chromium + dev server on the same Windows machine. The wire diagnostic ran node ↔ headless Chromium with no game logic. Production has the SectorRoom physics worker + persistence worker + Pino logging + msgpackr per-recipient encoding all competing for CPU. The DC variance might be host-side latency that affects message hand-off into the SCTP layer. **Test**: re-run on a quiet host (close everything else) and see if variance tightens.

2. **Chromium-side DataChannel receive limit**. The browser may have a buffer / event-loop saturation point we're hitting. **Test**: instrument `dc.onmessage` count directly via `page.exposeFunction` and compare to server-side `entry.sentViaDc` — if they match, the bottleneck is post-receive in OUR code; if not, it's browser-side.

3. **Genuine 60 % ceiling**. The plan's metric measures inter-arrival gaps. DC reliable mode still pays the SCTP HOL cost — just less than TCP. The 70 % bar might require unreliable mode + a freshness-based metric (not inter-arrival).

---

## Plan for tomorrow

### Step 1 — server-side send-count instrumentation (~15 min)

Add a periodic emit from `WebRtcChannelManager` that exposes `entry.sentViaDc` (server's own counter, not from log events). Surface it to the test via either:
- A `/dev/webrtc-counters?sessionId=X` endpoint on the dev server, OR
- A Colyseus broadcast every 1 s with the per-session counter snapshot.

The test reads server-sent-N and client-received-M for the same session. Three outcomes:

- **N ≈ M ≈ 200**: wire is clean, our integration is clean, the 60 % gate is structural. Decide: ship at 60 % to phone smoke (likely good enough), or pivot.
- **N ≈ 200, M << N**: browser-side receive bottleneck. Investigate Chromium DC internals OR throttle server send rate.
- **N << 200**: server side bottleneck (broadcaster gate, encode time, libdatachannel back-pressure). Most actionable.

### Step 2 — quiet-host re-run (~10 min)

Close every other process on the dev machine. Re-run the Phase 4 E2E. If variance tightens AND median improves to ≥ 70 % reduction, the variance was host-load. Phone smoke (Phase 5) becomes the next user-driven step.

### Step 3 — if both pass — handoff to phone smoke (Phase 5)

Plan Phase 5 spec:
- Phone hard-refresh + `?autocapture=1&webrtc=1`.
- 3 back-to-back smokes of ≥ 60 s each. Same Wi-Fi, same time-of-day window.
- Confirm UA is "Mobile Safari/Chrome" not WebView.
- Analyse `recv_gap_long` count per minute vs anchor captures `5vjj4e` / `g6l26y`.
- Plan exit gate: ≥ 60 % reduction across 3 smokes. (Phase 5's bar is intentionally lower than Phase 4's 70 % synthetic bar.)

### Step 4 — if either fails — alternative configurations

If quiet-host shows persistent variance: try server-side rate-shaping using `setBufferedAmountLowThreshold` + `onBufferedAmountLow` instead of the current bufferedAmount-threshold-then-degrade pattern. Phase 0 spike notes already flagged that bufferedAmount stays at 0 in loopback, so the 8 KB degrade threshold never fires — we have no real back-pressure signal today.

---

## Files changed in this session

Production code:
- [`src/client/net/dataChannelTransport.ts`](../src/client/net/dataChannelTransport.ts) — `ordered: true` (reverted from `ordered: false` experiment), receiver `<=`→`<`, full decision log in comment.
- [`src/client/net/dataChannelTransport.test.ts`](../src/client/net/dataChannelTransport.test.ts) — duplicate-tick test now asserts pass-through; new test locks strictly-older drop.
- [`src/client/net/ColyseusClient.ts`](../src/client/net/ColyseusClient.ts) — `dispose()` closes DC transport before `room.leave()`. Plus the iteration 1 fixes: static import of `DataChannelTransport` (was dynamic, raced welcome), `logSnapshotRecvTelemetry(snap, via)` extracted from WS-only inline so BOTH transports log identically.
- [`src/server/rooms/SectorRoom.ts`](../src/server/rooms/SectorRoom.ts) — removed the `if (this.sectorKey !== null)` gate that blocked engineering rooms from creating the WebRtcChannelManager. Every E2E uses engineering rooms.
- [`src/server/rooms/SnapshotBroadcaster.ts`](../src/server/rooms/SnapshotBroadcaster.ts) — DI seam for `sendSnapshot` callback (unchanged from Phase 1); the broadcaster-side duplicate-tick skip was tried + REVERTED (see Bug 1 false-trail above).
- [`scripts/webrtc-spike-high-rate.ts`](../scripts/webrtc-spike-high-rate.ts) — the diagnostic spike that proved the wire was clean. Run with `pnpm tsx scripts/webrtc-spike-high-rate.ts` (~30 s).

Tests:
- [`tests/e2e/webrtc-vs-ws-recv-gap-comparison.spec.ts`](../tests/e2e/webrtc-vs-ws-recv-gap-comparison.spec.ts) — added drop-counter reads, transport-tag aware metrics, webrtc_connected liveness gate. Currently in `FEATURE_SPECS` in `playwright.config.ts` line 108. **Note**: each full run is ~7-8 min. Run with `pnpm exec playwright test --project=feature tests/e2e/webrtc-vs-ws-recv-gap-comparison.spec.ts --reporter=line`.
- [`src/server/rooms/SnapshotBroadcaster.routing.test.ts`](../src/server/rooms/SnapshotBroadcaster.routing.test.ts) — restored to pre-server-skip-fix state.

Diag outputs:
- [`diag/measurements/2026-05-30-imperative-taco-webrtc/P4-high-rate-spike.json`](../diag/measurements/2026-05-30-imperative-taco-webrtc/P4-high-rate-spike.json) — the wire-is-clean evidence.
- Plus the Phase 0 spike outputs from the start of the session.

---

## Inner-loop status

- `pnpm typecheck` — green
- `pnpm lint` — 0 errors (109 pre-existing warnings, none from new files)
- `pnpm test:gc` — 29 / 29 green
- `pnpm test -- --run src/server/transport/ src/client/net/dataChannelTransport.test.ts src/server/rooms/SnapshotBroadcaster.routing.test.ts` — 34 / 34 green
- 8 s `pnpm dev:server` boot smoke — clean (7 galaxy sectors hydrate, no WebRTC errors)

Pre-existing integration suite failures (4 files / 9 tests using a removed `room._internals` accessor) are NOT in any of this plan's commits — confirmed by `git stash` + re-run on the pre-Phase-1 state earlier in the session. Out of scope for swift-otter; should be triaged separately.

---

## Commit log (most recent first)

```
9033cf6 fix(net): two real WebRTC integration bugs found via Phase 4 iteration (plan: swift-otter, Phase 4 iteration 2)
99730f6 fix(net): WebRTC Phase 4 measurement iteration — DC now opens + meaningful telemetry (plan: swift-otter, Phase 4 iteration)
f2abd59 test(net): WebRTC vs WS Pattern-B comparison + control E2E (plan: swift-otter, Phase 4)
03469a9 test(net): WebRTC DataChannel integration test — end-to-end snapshot + fallback ack (plan: swift-otter, Phase 3)
729dcb5 feat(net): client-side WebRTC DataChannel transport + opt-in URL flag (plan: swift-otter, Phase 2)
19803d5 feat(net): server-side WebRTC DataChannel channel + signaling state machine (plan: swift-otter, Phase 1)
9a3268b perf(net): WebRTC DataChannel Phase 0 spike — library + interop validated (plan: swift-otter, Phase 0)
8c593d5 perf(net): TCP_NODELAY belt-and-braces + audit (plan: swift-otter, Phase -1)  ← already shipped before this session
```

Total: 7 new commits this session + 1 pre-existing from Phase -1. All on `integration/four-branches`. UNPUSHED.

---

## Quick reference for tomorrow

**Resume the work**: `git log --oneline -10` shows the 7 commits. Working tree should be clean post-session (verify with `git status`).

**Re-run Phase 4 E2E** (the canonical signal): kill stale servers first, then:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 2567 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

```
pnpm exec playwright test --project=feature tests/e2e/webrtc-vs-ws-recv-gap-comparison.spec.ts --reporter=line
```

~7-8 min. The full test output goes through line reporter so you'll see the per-rep `[ws rep i]` / `[dc rep i]` lines as they fire.

**Re-run the wire diagnostic** (sanity check that node-datachannel is still clean):

```
pnpm tsx scripts/webrtc-spike-high-rate.ts
```

~30 s. Should print `WIRE OK — loss in Phase 4 must be in our integration`.

**Plan reference**: [`C:\Users\alecv\.claude\plans\i-d-like-you-to-swift-otter.md`](file:///C:/Users/alecv/.claude/plans/i-d-like-you-to-swift-otter.md) — the full multi-phase workflow. Phase 5 starts at "Phase 5 — Phone smoke" near the bottom.

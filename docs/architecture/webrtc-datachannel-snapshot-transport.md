# WebRTC DataChannel snapshot transport

The Phase 1–5 swift-otter plan added a second snapshot transport — WebRTC DataChannel — alongside the existing Colyseus WebSocket channel. This document is the architecture reference for the live system: contracts, ownership, the burst-coalescing pattern, the wire-time interval rule, and the hybrid syncMirror tradeoff.

For the historical context, motivation (phone captures `5vjj4e` / `g6l26y` showed TCP head-of-line burst-decay), and the phased build-out, see the swift-otter plan file at `C:\Users\alecv\.claude\plans\i-d-like-you-to-swift-otter.md` and the Phase 4 iteration 3 handoff at [`docs/HANDOFF-swift-otter-iteration-3-2026-05-30.md`](../HANDOFF-swift-otter-iteration-3-2026-05-30.md).

## Architecture

```
Server                                    Client
──────────────────────────────────         ──────────────────────────────────
SectorRoom.update() (60 Hz)                ColyseusGameClient
  → SnapshotBroadcaster.broadcast(snap)
    → webrtcChannelManager.sendSnapshot(   ╱ DataChannel (binary, msgpackr)
        sessionId, snap,                  ╱   → DataChannelSnapshotReceiver
        onFallback = ws-send-snapshot)   ╱      → enqueueBinary (raw bytes,
      DC sendable?                       ╱        latest-wins)
      ├── yes → DC.sendMessageBinary    ╱       (RAF tick →) drain → decode
      │         entry.sentViaDc++       ╱        → onSnapshot(snap) →
      │                                 ╱          coalescer.enqueue(snap)
      └── no  → onFallback()            ╲
                client.send('snapshot')  ╲  WebSocket (Colyseus message)
                entry.sentViaWs++         ╲   → room.onMessage('snapshot', ...)
                                           ╲    → logSnapshotRecvTelemetry(via='ws')
                                            ╲   → coalescer.enqueue(snap)
                                             ╲
                                              `→ tickPhysics() RAF:
                                                   1. DC drainPending
                                                   2. (hybrid) syncMirror
                                                      drain
                                                   3. processPendingSnapshot
                                                      → applySnapshotNow
                                                      → handleSnapshot
                                                      → reconciler.reconcile
```

Signalling (offer / answer / ICE candidates) rides the existing Colyseus WebSocket — there is no separate signalling server. The DataChannel is a pure data path; the WS connection is always present and handles every Colyseus message except snapshot delivery once the DC is connected.

## Server-side

[`src/server/transport/webrtcChannel.ts`](../../src/server/transport/webrtcChannel.ts) — `WebRtcChannelManager` (one per SectorRoom). Owns a `Map<sessionId, Entry>` where Entry holds `{ pc, dc, signaling, degraded, sentViaDc, sentViaWs, dcThrows, dcBackpressureHits, dcSlowSends }`. Native binding lives in [`webrtcChannelFactory.ts`](../../src/server/transport/webrtcChannelFactory.ts) — separate module so unit tests of the manager don't pay the `node-datachannel` native-init cost.

Three-signal back-pressure (hostile review #4 from the plan):

1. `try/catch` around `dc.sendMessageBinary` — any throw marks entry degraded and routes future snapshots via WS.
2. `dc.bufferedAmount() >= 8 KB` (`BUFFERED_AMOUNT_DEGRADE_BYTES`) — degrade.
3. Per-send timing > 2 ms (`SLOW_SEND_MS`) emits a `webrtc_slow_send` diag event (does not degrade; signal only).

`handleOffer` / `handleIce` / `cleanup` / `expireStale` are the lifecycle hooks. `expireStale` runs every 60 main-thread ticks (~1 s) — sessions in `connecting` past the 5 s ICE deadline transition to `failed` and stay on WS.

`getCounters()` returns a pure-data snapshot of per-session counters. Exposed via `GET /dev/webrtc-counters?roomId=<id>` (`devWebrtcCountersHandler` in [`src/server/routes/diag/devHandlers.ts`](../../src/server/routes/diag/devHandlers.ts)) for the Phase 4 E2E to compare server-sent-N against client-received-M.

`SectorRoom`'s broadcast site (line ~1019, `SnapshotBroadcaster` constructor) calls `webrtcChannelManager!.sendSnapshot(client.sessionId, snap, () => client.send('snapshot', snap))`. The manager owns the routing decision — sendable + not-degraded + not-back-pressured + DC open → DC; otherwise the fallback callback runs (sends via Colyseus WS).

## Client-side

[`src/client/net/dataChannelTransport.ts`](../../src/client/net/dataChannelTransport.ts) — two classes:

### `DataChannelSnapshotReceiver` (pure helper, unit-testable)

Owns `_pendingBytes: Uint8Array | ArrayBuffer | null` (the raw-bytes coalescer slot) and `_lastSeenServerTick` (the reorder guard).

- **`enqueueBinary(buf)`** — production `dc.onmessage` listener calls this. Stores the buffer in `_pendingBytes` (replacing any prior pending). No decode, no allocation. Constant work.
- **`drain()`** — `ColyseusClient.tickPhysics` calls this once per RAF. Decodes the latest pending buffer via `msgpackr`, runs the shape check, runs the reorder guard (`snap.serverTick < _lastSeenServerTick` → drop with `snap_dropped_old`), and invokes `onSnapshot(snap)`.
- **`handleBinary(buf)`** — legacy direct-dispatch path. Preserved for unit / integration tests that pump frames synchronously. Production code goes through `enqueueBinary` + `drain`.

The reorder guard is `<` (not `<=`); equal-tick frames pass through. The server's main-thread broadcaster can fire `snap.serverTick === lastBroadcastTick` no-op duplicates when the worker SAB tick hasn't advanced. The WS path harmlessly re-applies; the DC path used to drop them as `snap_dropped_old` (Phase 4 iteration 2 fix, 2026-05-29).

### `DataChannelTransport` (RTC plumbing)

Owns `RTCPeerConnection` + `RTCDataChannel`. Drives signalling through `room.send('webrtc_offer' | 'webrtc_ice')`. The `dc.message` listener routes to `_receiver.enqueueBinary(data)`. `drainPending()` is the public bridge that calls `_receiver.drain()`.

Phase guard: `dc.message` listener returns early if `_phase !== 'dc-open'` — covers the renegotiation race (hostile review #6). Connect timeout 5 s; on expiry transitions to `failed` and emits `webrtc_fallback` over the signalling channel.

`ordered: true` is the default. Phase 4 evidence (2026-05-29) tested `ordered: false / maxRetransmits: 0` and showed DC arm gap count INCREASED — the `recv_gap_long` metric measures inter-arrival gaps; unreliable mode INTENTIONALLY drops late packets which makes inter-arrival gaps LARGER. Defaults stay ordered + reliable until a freshness-based metric replaces inter-arrival.

## Two load-bearing coalescing rules

### Rule 1: raw-bytes coalescer (DC-side, Phase 4 iteration 3)

**The DC `dc.message` listener MUST `enqueueBinary` (store latest buffer), NEVER `handleBinary` (decode + dispatch) directly.**

Why: Pattern B network bursts (and real Wi-Fi recovery from packet loss) deliver N queued snapshot frames into the JS event loop in a single frame. The pre-iteration-3 path decoded EVERY one synchronously on receipt — N × msgpackr decode on the main thread inside `dc.onmessage`, producing 235 ms loafs in the diagnostic `webrtc-pattern-b-with-scripts` run. The WS path didn't have this problem because Colyseus's frame dispatch plus our `snapshotCoalescer` makes the apply latest-wins; intermediate snapshots are discarded before decode-and-apply. Now both transports coalesce at the byte level.

SCTP `ordered: true` (the default) guarantees no reordering, so "latest enqueued = freshest" is sound. The reorder guard inside `_decodeAndDispatch` is defensive only.

`handleBinary` is preserved as the direct-dispatch path for unit / integration tests that pump frames synchronously; production never calls it.

### Rule 2: wire-arrival time, NOT RAF apply time, for `intervalMs`

[`src/client/net/snapshotPerfStats.ts`](../../src/client/net/snapshotPerfStats.ts) `applySnapshotPerfStats` takes a `wireArrivalAtMs` parameter (the snapshot's wire-recv time from `_lastSnapshotRecvAtMs`, set inside `logSnapshotRecvTelemetry`) and computes `intervalMs = wireArrivalAtMs - lastSnapshotAt`.

Why: the snapshot coalescer (+ deferred / hybrid syncMirror) push the APPLY cadence to RAF boundaries (~16–33 ms). The downstream `rttLookaheadUpdater.ts` REJECTS RTT samples outside the 35–75 ms `STEADY_STATE_INTERVAL_*` band. With RAF-bound intervals mostly outside the band, Welford state went stale → `leadTicks` inflated → `ticksAhead` regressed from 30 to 74 in netgate. Wire cadence is ~50 ms at 20 Hz → samples stay inside the band → RTT Welford healthy → `leadTicks` stable.

This rule is independently load-bearing: even without deferred-syncMirror, the snapshot coalescer alone is enough to break the band-filter with apply-bound intervals. **Pre-Phase-4-iteration-3 this was a latent bug everyone has been paying for.**

Locked by [`tests/unit/snapshotPerfStats.intervalMs.test.ts`](../../tests/unit/snapshotPerfStats.intervalMs.test.ts).

## Hybrid syncMirror

`room.onStateChange((state) => ...)` fires per Colyseus schema mutation (~60 Hz potential under burst recovery). The pre-iteration-3 path called `syncMirror(state)` synchronously every time. Pattern B burst recovery delivers N state-diff messages in one frame; each one was firing syncMirror, which walks `state.ships` + `state.wrecks` and is ~30 ms on a moderately populated sector. The diagnostic attributed the resulting 218–289 ms loafs to `onMessageCallback` (Colyseus library frame).

Hybrid (current production behaviour, 2026-05-30):

```ts
room.onStateChange((state) => {
  this.transitInstr.markOnce('first_state');
  if (this._syncMirrorRanThisRaf) {
    this._pendingStateForSync = state;     // defer
  } else {
    this._syncMirrorRanThisRaf = true;
    this.syncMirror(state);                // inline
  }
});
```

`tickPhysics` drains `_pendingStateForSync` at the top (after DC drainPending, before snapshot apply) and resets `_syncMirrorRanThisRaf = false`. Max 2 syncMirror calls per RAF (one inline + one drained).

The full-defer variant (always defer, never inline) shipped briefly and was reverted: it caused a `maxDriftUnits` regression in the netgate 5-rep median (12 → 36) that could not be reproduced under CDP-emulated jitter. The mechanism is specific to the netgate latency proxy's per-byte TCP-level jitter; we have no proxy-level instrumentation to localise it. Hybrid is the safe middle ground — netgate PASS=true on all metrics; preserves the synchronous-first-call semantics the reconciler's drift baseline depends on.

The tradeoff is that hybrid loses the dramatic loaf-reduction win of full-defer (Pattern B median 9 vs 0 in WS-onmessage loafs per rep). The phone smoke (capture `wb1al4`, 2026-05-30) confirms hybrid's early-session metrics match the WS-only anchor baseline (0.05/s vs 0.02/s), which is the goal.

## URL flags

- `?webrtc=1` — opt in to WebRTC DC transport. Default OFF until Phase 5 phone-smoke validates a healthy rollout default.
- `?webrtc=0` — explicit force off (the negative-control arm in Phase 4 E2E + the safety hatch if the DC path regresses on a future browser).

Server-side, the WebRTC manager is constructed on every SectorRoom regardless of `sectorKey` (the previous `sectorKey === null` gate that skipped engineering rooms was a Phase 4 iteration 1 bug — every E2E uses engineering rooms). The PeerConnection isn't constructed until an offer actually arrives (`handleOffer` runs the factory), so rooms that never see a `?webrtc=1` client pay zero cost.

## Diagnostic surface

- `/dev/webrtc-counters?roomId=<colyseus-roomId>` — server-side per-session counter snapshot.
- `webrtc_pc_state` / `webrtc_connected` / `webrtc_closed` / `webrtc_dc_error` / `webrtc_degraded` / `webrtc_fallback` — lifecycle events.
- `webrtc_slow_send` — server-side timing > 2 ms.
- `snap_route` (server-side, via `serverLogEvent`) — fires per snapshot send with `{ via: 'dc'|'ws', dcBufferedAmount }`.
- `snap_dropped_decode` / `snap_dropped_shape` / `snap_dropped_old` — receiver-side drop reasons.
- `snapshot_received` (client `__eqxLogs`) — carries `via: 'dc'|'ws'` so the Phase 4 E2E can gate on transport routing.
- `snapshot_applied` (client) — extended in Phase 4 iteration 3 with `driftUnits` / `ticksAhead` / `snapshotIndex` per the maxDrift investigation tooling.

## Tests

- Unit: [`webrtcSignaling.test.ts`](../../src/server/transport/webrtcSignaling.test.ts) (12), [`webrtcChannel.test.ts`](../../src/server/transport/webrtcChannel.test.ts) (16), [`dataChannelTransport.test.ts`](../../src/client/net/dataChannelTransport.test.ts) (13 incl. the iteration-3 raw-bytes-coalescer cases), [`snapshotPerfStats.intervalMs.test.ts`](../../tests/unit/snapshotPerfStats.intervalMs.test.ts) (3, wire-time semantic lock).
- Integration: [`tests/integration/sectorRoom/webrtcSnapshot.test.ts`](../../tests/integration/sectorRoom/webrtcSnapshot.test.ts) (handshake + fallback ACK).
- E2E: [`webrtc-vs-ws-recv-gap-comparison.spec.ts`](../../tests/e2e/webrtc-vs-ws-recv-gap-comparison.spec.ts) (Pattern B comparison + control + loaf-invoker dump + topScripts attribution + server-counter fetch).
- Investigation tooling: [`maxdrift-investigation.spec.ts`](../../tests/e2e/maxdrift-investigation.spec.ts), [`webrtc-mobile-emulation-{control,stutter}.spec.ts`](../../tests/e2e/) — diagnostic, not gated.

## Rollback

[`scripts/revert-webrtc.sh`](../../scripts/revert-webrtc.sh) discovers every `(plan: swift-otter, Phase [0-5])` commit and reverts in reverse chronological order. Phase −1 TCP_NODELAY is explicitly excluded (it's a generic fix, not WebRTC-specific).

## What's deliberately NOT in scope

- **TURN deployment** for NAT-restricted clients — separate future plan when production traffic surfaces the need.
- **Schema diff over DataChannel** — schema diffs stay on WS (the WS connection is always present for control messages anyway).
- **WebTransport (HTTP/3 + QUIC)** — revisit when Colyseus v1.0 ships unified WS + WebTransport API.
- **Adaptive jitter buffer** — superseded by this plan.
- **The pre-existing Pixi-side heap leak** that surfaces in long sessions (≥ 4 min) — visible in the `wb1al4` phone capture as ~10 MB/min growth crossing 65 MB → RAF Hz drops 90→58 → stutter cascade. This is the lazy-mochi / imperative-taco lineage; needs a new plan.

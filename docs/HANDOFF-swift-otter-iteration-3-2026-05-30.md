# HANDOFF — swift-otter Phase 4 iteration 3 (2026-05-30)

Date completed: **2026-05-30** evening
Branch: **`integration/four-branches`** — 13 commits beyond yesterday's `1985840`
HEAD: **TBD post-merge** (this handoff is written before the merge commit)
Status: **Phase 5 phone smoke PASSED for the WebRTC iteration.** Merging to `main`.

## Where the work landed

Phase 4 was already shipped on `integration/four-branches` end-of-2026-05-29 with the receiver-side `<=`→`<` fix and DC snapshot routing at 60 % gap reduction under synthetic Pattern B. Phase 5 phone smoke that day exposed a different signal: with WebRTC enabled, the user felt the session degrade after ~2 min (raf_stutter spike, AI stutter, "pretty awful").

The full 2026-05-30 session ran the data-driven investigation that the user demanded. Three targeted fixes landed; one was tried, reverted, and refined into a hybrid:

| Commit | What | Why |
|---|---|---|
| `7f9a9cb` | `/dev/webrtc-counters` endpoint + `WebRtcChannelManager.getCounters()` | Server-side counter introspection for the Phase 4 E2E comparison |
| `f38ccc4` | Phase 4 E2E reads `/dev/webrtc-counters`; server-vs-client counter dump | Localise "server-sent-N vs client-received-M" |
| `34c86a4` | `readRoomId` uses `room.roomId` (colyseus.js field), not `.id` | Phase 4 E2E was silently failing the server-counter fetch for 4 hours |
| `a6bf982` | Mobile-emulator scaffolding (`webrtc-mobile-emulation-{control,stutter}.spec.ts`) | Try to synthetically reproduce the phone-finding — required `channel: 'chromium'` for real WebGL |
| `88d3792` | Loaf-by-invoker dump in Pattern B spec | Phone-finding REPRODUCED synthetically: DC enable → ~2× WS-handler loafs |
| `2f9b647` | **DC raw-bytes coalescer** | Byte-level coalescing in `DataChannelSnapshotReceiver`; collapses N-decode bursts to 1 per RAF |
| `10e3811` → `5e7ee5c` → `7b92393` | Deferred syncMirror — try / revert / restore | Full-defer caused `ticksAhead` regression (74 vs 30) |
| `77e20a7` | **Wire-time `intervalMs`** | `applySnapshotPerfStats` uses wire-arrival time, NOT RAF apply time — fixes a long-standing latent bug that surfaced with full-defer |
| `71ab8c4` | **Hybrid syncMirror** (inline first per RAF, defer rest) | Restored `maxDriftUnits` to baseline; lost full-defer's dramatic loaf reduction but kept netgate PASS=true |
| `3b2ed1f` | maxDrift investigation infra (`maxdrift-investigation.spec.ts`, drift in `snapshot_applied`) | Couldn't reproduce maxDrift in CDP-emulated jitter (got 0.351 vs netgate's 36) — proxy-specific |

## What the phone smoke (capture `wb1al4`, 2026-05-30 15:01) confirmed

4-minute capture, `?autocapture=1&webrtc=1`. Early-session metrics (0–120 s) — the WebRTC iteration's domain:

| Metric | Baseline (pre swift-otter) | Phone (this capture, 0–120 s) | Phone (3-cap avg yesterday, 60–90 s) |
|---|---:|---:|---:|
| via=dc % | n/a | **99.4 %** | 98.2 % |
| `recv_gap_long` (over 4 min) | 6 (g6l26y, 102 s) | **2** | 8–14 |
| `DOMWebSocket.onmessage` loafs / sec | 0.02–0.05 | **0.05** | 0.21–0.51 |
| `webrtc_degraded` / `webrtc_closed` / `webrtc_fallback` | n/a | **0 / 0 / 0** | 0 / 0 / 0 |

**The WebRTC iteration is doing what it was supposed to do.** Early-session phone behaviour matches the WS-only anchor baseline.

After ~120 s, the heap leak threshold cascade dominates (see "Outstanding work" below). The user's "got laggy / AI stuttering toward the end" is the cascade, not the WebRTC.

## Investigation methodology — keep this for future work

The day's biggest lesson is the **diagnostic workflow**, not the individual fixes. The user's pushback on premature conclusions was correct twice; the eventual mechanism was found by adding instrumentation that surfaced the actual hot code instead of guessing.

1. **Pattern B + LongAnimationFrame `topScripts` attribution is THE workflow for localising main-thread loafs.** Extend [`webrtc-vs-ws-recv-gap-comparison.spec.ts`](../tests/e2e/webrtc-vs-ws-recv-gap-comparison.spec.ts) to dump the top-5 longest `loaf` events with their `topScripts[]` (function name + source URL per script invocation). That immediately attributed a 235 ms loaf to `net/dataChannelTransport.ts` — the per-message msgpackr decode. Reach for this first.

2. **Server-vs-client counter pairs localise DC throughput variance.** `/dev/webrtc-counters` exposes the server's authoritative `entry.sentViaDc`; the client logs `snapshot_received via='dc'`. If they match, the wire is clean. If they don't, you know which side to investigate next.

3. **For phone-felt "got laggy" reports, ALWAYS ASK for a capture ≥ 3 min.** Threshold cascades (the one in `wb1al4` triggered at heap ~65 MB) hide in sub-2-min captures. The 70–90 s smoke captures from this morning all showed early growth without crossing the threshold; the 4-min capture made it dominant.

4. **Phone perception of "AI stutter" is the GC cascade's render effect, not necessarily a render-pipeline bug.** Memory pressure → GC pauses → RAF Hz drops → snapshots applied less frequently per RAF → drone interpolation `now` jumps further per frame → visible jitter on what's supposed to be smooth interpolation. The root cause is allocation; the symptom is render.

5. **CDP `Network.emulateNetworkConditions` cannot reproduce the netgate latency proxy's per-byte TCP jitter.** Investigation methodology: if you can't reproduce a netgate regression under CDP, the next move is proxy-level instrumentation, not deeper client-side guessing.

6. **The hybrid pattern (first inline + defer rest) is the safe shape for backpressure-tolerant work inside Colyseus message handlers.** Full-defer broke proxy-specific maxDrift. Full-inline triggered the loaf spike. Hybrid keeps the synchronous-first-call semantics existing code depends on, while collapsing burst overhead.

## Outstanding work — the pre-existing Pixi-side heap leak

The `wb1al4` capture surfaced a **pre-existing** memory leak that is not caused by this iteration's changes:

| Phase | Heap mean | RAF Hz |
|---|---:|---:|
| 0–60 s | 50 MB | 89.8 |
| 60–120 s | 59 MB | 87.7 |
| **120–180 s** | **65 MB** | **58.5** ← threshold cascade |
| 180–240 s | 73 MB | 58.3 |
| 240–300 s | 95 MB | 46.6 |

Same growth pattern in yesterday's `5d0e7d` (17 MB/min growth pre-fix) and `byy76l` (similar trajectory). Today's wb1al4 actually grew SLOWER than pre-fix (~10 MB/min). So this is the same leak class the `lazy-mochi` / `imperative-taco` plans have been chasing — not introduced by swift-otter.

Likely candidates per [user-memory pointer](file:///C:/Users/alecv/.claude/projects/C--Users-alecv-Desktop-eqx-net-eqx-net/memory/MEMORY.md):
- `LaserGlow` / `ShieldAura` — flagged "still need heap-delta locks"
- `damage_number_spawned` — 815 events in 240 s (~3.4/s); pool capped at 20 but text geometry could leak
- Other Pixi sprite caches accumulating across drone spawns/despawns

To localise: use the existing [`tests/e2e/heap-snapshot-diff.spec.ts`](../tests/e2e/heap-snapshot-diff.spec.ts) pattern. Capture heap at t=60 s (early stable) and t=180 s (climbing), diff. New plan candidate.

## Branch state for the next agent

After this handoff is committed and the merge to `main` lands:

- Branch `integration/four-branches` is fully merged into `main` via `--no-ff`.
- 13 swift-otter iteration-3 commits + this handoff doc are in the merge commit's history.
- No outstanding swift-otter work — the plan file at `C:\Users\alecv\.claude\plans\i-d-like-you-to-swift-otter.md` and `C:\Users\alecv\.claude\plans\i-want-you-to-sprightly-backus.md` are both closed.
- The Pixi-effects heap leak is the next plan target. Suggested name when starting that plan: build on the `lazy-mochi` lineage; mention that swift-otter's `wb1al4` capture provides 4 min of evidence showing the leak threshold cascade.

## Reference

- Architecture: [`docs/architecture/webrtc-datachannel-snapshot-transport.md`](architecture/webrtc-datachannel-snapshot-transport.md)
- Lessons: [`docs/LESSONS.md`](LESSONS.md) 2026-05-30 entry
- Client rules: [`src/client/CLAUDE.md`](../src/client/CLAUDE.md) "Snapshot transport — DataChannel + WebSocket coalescing" section
- Phone capture: `diag/captures/2026-05-30T15-01-02Z-wb1al4/`
- Server-counter endpoint: `GET /dev/webrtc-counters?roomId=<id>` (NODE_ENV-gated)
- Diagnostic tooling: [`maxdrift-investigation.spec.ts`](../tests/e2e/maxdrift-investigation.spec.ts), [`webrtc-mobile-emulation-{control,stutter}.spec.ts`](../tests/e2e/), Pattern B spec's loaf+topScripts dump

## Rollback path

If a regression surfaces after merge, [`scripts/revert-webrtc.sh`](../scripts/revert-webrtc.sh) discovers every `(plan: swift-otter, Phase [0-5])` commit and reverts in reverse chronological order with one squashed revert. Tested but not exercised on a real revert. Phase −1 TCP_NODELAY is explicitly excluded.

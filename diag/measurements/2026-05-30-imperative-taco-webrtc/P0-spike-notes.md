# WebRTC plan — Phase 0 spike notes (swift-otter)

Date: 2026-05-29
Plan: `C:\Users\alecv\.claude\plans\i-d-like-you-to-swift-otter.md` (identical to `i-d-like-you-to-imperative-taco.md`)
Branch: `integration/four-branches`
Phase -1 status: already committed as `8c593d5` (TCP_NODELAY belt-and-braces); user instructed to skip this phase for the current session.

## Summary

All Phase 0 exit gates are GREEN. The library installs cleanly on Windows, the W3C polyfill and the native binding both round-trip 1 KB binary frames byte-exact, and the application-layer 5 s fallback timeout has a reliable hook (`connectionState !== 'connected'`). No abort criteria were triggered. Ready to proceed to Phase 1 pending user approval at this stop-and-ask point.

## Step 1 — Library install + boot smoke

| Check | Result |
|---|---|
| `pnpm add node-datachannel` | OK — 19.8 s (prebuilt binary, no native rebuild) |
| Installed version | `node-datachannel 0.32.3` |
| `pnpm dev:server` boot | Clean (`INFO: EQX Peri server started port: 2567`, all 7 sectors hydrated, `server ready — /healthz now reports ready:true`) |
| Exit code | 124 (timeout SIGTERM — expected per CLAUDE.md verification protocol) |

The package exports the native binding (`PeerConnection`, `DataChannel`, etc.) AND a `node-datachannel/polyfill` entry point that surfaces the WHATWG `RTCPeerConnection` / `RTCDataChannel` types. Both will be useful: production-server code will use the native API directly (Phase 1), integration tests (Phase 3) will use the polyfill so the harness code reads symmetrically with the browser client (Phase 2).

CI probe at `.github/workflows/node-datachannel-probe.yml` matrix-tests `pnpm install` + `require('node-datachannel').PeerConnection` resolution on ubuntu/windows/macos-latest. Push-triggered on `package.json` / `pnpm-lock.yaml` changes; not yet executed pending branch push.

## Step 2 — In-process polyfill spike

Script: `scripts/webrtc-spike.ts`
Output: `P0-spike-output.json`

| Metric | Value |
|---|---|
| Handshake (offer → answer → DataChannel `open`) | 1033 ms |
| 1 KB binary round-trip | 17.3 ms |
| Byte-exact match (1024 bytes) | YES |
| connectionState A / B | `connected` / `connected` |
| 1000 × 1 KB burst — sent | 1000 / 1000 |
| 1000 × 1 KB burst — received | 1000 / 1000 |
| 1000 × 1 KB burst — `send()` threw | NEVER |
| 1000 × 1 KB burst — `bufferedAmount` max | **0** |
| sendLoopMs / drainMs | 31 / 38 |

The 1033 ms handshake is dominated by ICE-candidate gathering; it is a one-time per-session cost and is irrelevant for steady-state snapshot delivery.

**The `bufferedAmount: 0` reading is unexpected on its face.** See Step 5 below for the native-API follow-up.

## Step 3 — Browser ↔ node-datachannel spike (Playwright-driven)

Script: `scripts/webrtc-spike-browser.ts`
Output: `P0-spike-browser-output.json`

Replaces the plan's "manually paste offer/answer/ICE via DevTools console" with a fully-automated Playwright run: launches headless Chromium against a `setContent`-rendered HTML page that creates an `RTCPeerConnection` and exchanges signaling over a tiny `ws` server back to node-datachannel.

| Metric | Value |
|---|---|
| End-to-end (server peer ready → browser DataChannel open → 1 KB echoed) | 631 ms |
| 1 KB binary RTT (browser perspective) | 15.9 ms |
| Byte-exact match | YES |
| Server-side ICE-gathering window | 50 ms |
| Selected ICE pair (browser side) | `prflx/host` (peer-reflexive / host — direct LAN connection, no STUN, no TURN) |
| Errors | 0 |

This validates the production path. The polyfill on Node interops with the browser API on the same machine over the loopback interface without needing any STUN server. For production over the open internet a STUN server will be needed for NAT traversal; `stun:stun.l.google.com:19302` is the standard freebie and can be wired into the Phase 1 `RTCPeerConnection` config without code change.

The browser script is intentionally a `tsx` script rather than a Playwright spec — it's a one-shot diagnostic, not a regression. Phase 4 will add a proper Playwright spec to `tests/e2e/network-buffer-and-throttle-repro.spec.ts`.

## Step 4 — Restrictive-network spike (clean failure within 5 s)

Script: `scripts/webrtc-spike-restrictive.ts`
Output: `P0-spike-restrictive-output.json`

| Metric | Value |
|---|---|
| Wall clock waited | 5007 ms |
| `connectionState` (client peer) | `connecting` — never reached `connected` |
| `iceConnectionState` | `checking` |
| DataChannel `readyState` | `connecting` |
| Application-layer 5 s deadline can fire | YES |

Two earlier designs were rejected (documented in the script header) before settling on the **single-peer hanging-offer model**: create one PeerConnection, call `setLocalDescription(offer)`, and never provide a remote description. This is exactly what a client sees when the server's answer or ICE candidates are dropped at the network layer.

The implication for Phase 2: the `RTCPeerConnection.connectionState` event signal is sufficient. We need a 5 s wall-clock timeout that fires if `connectionState !== 'connected'`. The underlying library does not throw, abort, or otherwise self-signal — silence is the failure mode, so the timeout is the only way to detect it.

## Step 5 — `bufferedAmount` behaviour (native API)

Script: `scripts/webrtc-spike-buffered-native.ts`
Output: `P0-spike-buffered-native-output.json`

Replicates the burst from Step 2 directly against the native `DataChannel` binding (no polyfill) to determine whether the `bufferedAmount: 0` reading was polyfill-side or native-side.

| Metric | Value |
|---|---|
| 1000 × 1 KB burst — `sendMessageBinary` returned true | 1000 / 1000 |
| `dc.bufferedAmount()` max during burst | **0** |
| `send()` threw | NEVER |
| Received on peer | 1000 / 1000 |
| sendLoopMs / drainMs | 37 / 30 |

Native confirms the polyfill: in-process loopback drains synchronously. The SCTP layer of `libdatachannel` consumes the queue between every JS-level `send()` call.

**Implication for Phase 1 hostile review #4:** `bufferedAmount` cannot be the *only* back-pressure signal — under normal loopback / in-process / well-conditioned-network operation it stays at 0 and would never trigger the `webrtc_degraded` route-to-WS branch. The Phase 1 mitigation as written already uses three signals:

1. `try { dc.sendMessage(...) } catch` — the native error path. Step 0 evidence: never thrown in loopback over 2000 sends. Production over a flaky network may differ; the catch stays.
2. `dc.bufferedAmount() > 8192` upper-bound canary. Now confirmed as a *late* signal — only useful if the network is so flaky that the SCTP queue actually backs up faster than JS can drain. Keep it as a safety net.
3. **Send-latency timing** — measure how long `dc.sendMessage(...)` takes synchronously and log if `> 2 ms` (already in the Phase 1 spec). This is the *early* signal; it will fire when SCTP is busy retransmitting even if the buffer hasn't yet backed up.

No plan change needed. Phase 1 will land all three.

## Hostile review status after Phase 0

| # | Risk | Status |
|---|---|---|
| 1 | TCP_NODELAY assumption | Phase -1 already shipped (`8c593d5`); not re-litigating per user direction |
| 2 | node-datachannel Windows CI | Local install works; CI matrix probe written (push pending) |
| 3 | Message size fragmentation | Phase 4 to assert max snapshot < 12 KB |
| 4 | bufferedAmount opaque | **Confirmed** — Phase 1 keeps three-signal mitigation (try/catch + threshold + send-latency timing) |
| 5 | Reordering with `ordered:false` | Defer to Phase 2 (we used `ordered:true` in the spike; Phase 1 should default to ordered:true and only consider `ordered:false` if Phase 4 evidence demands it) |
| 6 | Signaling race ICE candidates | Phase 2 implements `connectionState === 'connected'` gate + 5 s timeout |
| 7 | Schema diff ordering | Phase 2 implements `shipInstanceId in state.ships` guard |
| 8 | Browser quirks | Chromium (Playwright) interop CONFIRMED; Safari + iOS WebView are Phase 5 phone-smoke targets |
| 9 | Fallback path ambiguity | Phase 2 implements `webrtc_fallback_ack` |
| 10 | Integration test harness blocker | **Resolved** — in-process polyfill ↔ polyfill round-trip works (Step 2); Phase 3 harness has a foundation |
| 11 | Per-client broadcast CPU | Phase 1 timing log + Phase 3 20-client load test |
| 12 | Notepack encoding drift | Spike payloads were raw Uint8Array; notepack encode/decode parity will be verified at Phase 1 send-site |
| 13 | Phase 5 smoke variance | 3 back-to-back smokes per Phase 5 spec |
| 14 | STUN/NAT for production | LAN spike connected with `prflx/host` (no STUN needed); production over open internet will need a STUN URL (standard `stun:stun.l.google.com:19302`); TURN scoped as separate future plan |
| 15 | Rollback story | Phase 1 to ship `scripts/revert-webrtc.sh` |

## Re-architecture decisions taken in Phase 0

- **Server transport library**: `node-datachannel 0.32.3` (native binding for production, W3C polyfill for tests).
- **Default reliability**: `ordered: true`. Re-evaluate to `ordered: false` only if Phase 4 evidence demands it. (Plan's hostile review #5 was conditional on `ordered: false`.)
- **Back-pressure signal**: three-signal (try/catch + 8 KB threshold + send-latency timing). `bufferedAmount` alone is insufficient.
- **STUN config**: empty `iceServers` works on LAN; Phase 1 will accept a `STUN_URL` env var defaulting to `stun:stun.l.google.com:19302` for production.
- **Fallback trigger**: 5 s wall-clock timeout on `connectionState === 'connected'`. Library does not self-signal failure; silence is the failure mode.

## Outputs

- `diag/measurements/2026-05-30-imperative-taco-webrtc/P0-spike-output.json` (in-process polyfill)
- `diag/measurements/2026-05-30-imperative-taco-webrtc/P0-spike-browser-output.json` (browser ↔ node-datachannel)
- `diag/measurements/2026-05-30-imperative-taco-webrtc/P0-spike-restrictive-output.json` (clean-failure simulation)
- `diag/measurements/2026-05-30-imperative-taco-webrtc/P0-spike-buffered-native-output.json` (native bufferedAmount)

## Stop-and-ask — recommend proceed to Phase 1

Per the plan's standing workflow consent, this is the second stop-and-ask point ("End of Phase 0 — spike result"). All exit gates green, no abort criteria triggered, no plan changes needed.

Phase 1 scope (server-side WebRTC channel):
- `src/server/transport/webrtcSignaling.ts` — pure signaling state machine + unit tests (failing-first per Invariant #13)
- `src/server/transport/webrtcChannel.ts` — `WebRtcChannelManager` per-room, three-signal back-pressure
- Route `SnapshotBroadcaster.ts:626` through `webrtcChannelManager.sendSnapshot()` with DC-or-WS decision
- Register `webrtc_offer` / `webrtc_answer` / `webrtc_ice` handlers in `SectorRoom.onCreate`
- `scripts/revert-webrtc.sh` (rollback)

User direction taken into the session: skip Phase -1, proceed with WebRTC. Phase 0 spike confirms the library and architecture are viable. Pending user OK, the next step is to begin Phase 1 with `webrtcSignaling.ts` + its failing test FIRST.

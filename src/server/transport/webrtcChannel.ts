/**
 * WebRtcChannelManager — per-SectorRoom WebRTC DataChannel transport.
 *
 * Owns one entry per joined sessionId:
 *   - The RTCPeerConnection (server side; answerer role).
 *   - The client-created DataChannel (received via `onDataChannel`).
 *   - The signaling state machine (see `webrtcSignaling.ts`).
 *   - Counters + back-pressure state.
 *
 * Three-signal back-pressure (hostile review #4):
 *   1. try/catch around `sendMessageBinary` — any throw marks the entry
 *      degraded and routes future snapshots to WS.
 *   2. `bufferedAmount() >= BUFFERED_AMOUNT_DEGRADE_BYTES` (8 KB default) —
 *      back-pressure observed; degrade until reconnect.
 *   3. Send-latency timing — log `webrtc_slow_send` when a single call
 *      exceeds `SLOW_SEND_MS` (2 ms default).
 *
 * Production node-datachannel factory is exported separately so tests can
 * substitute a fake. The W3C polyfill is NOT used here — production server
 * code stays on the native `node-datachannel` API surface for the lowest
 * possible overhead.
 *
 * Plan: swift-otter (Phase 1).
 */

import { Packr } from '@colyseus/msgpackr';
import type { Logger } from 'pino';
import { performance } from 'node:perf_hooks';
import { WebRtcSignalingState } from './webrtcSignaling.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

/** Minimal PeerConnection surface the manager needs. */
export interface WebRtcPeerConnection {
  setRemoteDescription(sdp: string, type: 'offer' | 'answer'): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  close(): void;
  onLocalDescription(cb: (sdp: string, type: string) => void): void;
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void;
  onDataChannel(cb: (dc: WebRtcDataChannel) => void): void;
  onStateChange(cb: (state: string) => void): void;
}

/** Minimal DataChannel surface the manager needs. */
export interface WebRtcDataChannel {
  isOpen(): boolean;
  bufferedAmount(): number;
  sendMessageBinary(buf: Buffer): boolean;
  onOpen(cb: () => void): void;
  onClosed(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
  close(): void;
}

export type PeerConnectionFactory = (sessionId: string) => WebRtcPeerConnection;

/**
 * Pure-data snapshot of a single session's counters. Returned by
 * `WebRtcChannelManager.getCounters()` and shipped JSON-as-is over the
 * `/dev/webrtc-counters` endpoint. Phase 4 iteration 3 diagnosis: pair
 * `sentViaDc` (server's authoritative send count) against the client's
 * `snapshot_received via=='dc'` count from `__eqxLogs` to localise where
 * a DC arm's snapshot-throughput variance lives — server-side send,
 * libdatachannel wire, or browser-side decode.
 */
export interface WebRtcEntryCounters {
  sessionId: string;
  sentViaDc: number;
  sentViaWs: number;
  dcThrows: number;
  dcBackpressureHits: number;
  dcSlowSends: number;
  degraded: boolean;
}

export interface WebRtcChannelManagerOptions {
  peerConnectionFactory: PeerConnectionFactory;
  /** Send an SDP answer back over the signaling channel (WS / Colyseus message). */
  sendAnswer: (sessionId: string, sdp: string) => void;
  /** Send a local ICE candidate over the signaling channel. */
  sendCandidate: (sessionId: string, candidate: string, mid: string) => void;
  /** Diag event sink (e.g. SectorRoom.serverLogEvent). */
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
  /** Optional pino logger. */
  logger?: Logger;
  /** Monotonic wall-clock source (overridable for tests). */
  nowMs?: () => number;
  /** Signaling ICE deadline (default 5 s). */
  iceDeadlineMs?: number;
  /** Bytes — entries with bufferedAmount over this are degraded. */
  bufferedAmountDegradeBytes?: number;
  /** Ms — log webrtc_slow_send when a single send exceeds this. */
  slowSendMs?: number;
}

interface Entry {
  pc: WebRtcPeerConnection;
  dc: WebRtcDataChannel | null;
  signaling: WebRtcSignalingState;
  degraded: boolean;
  sentViaDc: number;
  sentViaWs: number;
  dcThrows: number;
  dcBackpressureHits: number;
  dcSlowSends: number;
}

const DEFAULT_BUFFERED_AMOUNT_DEGRADE_BYTES = 8 * 1024;
const DEFAULT_SLOW_SEND_MS = 2;

export class WebRtcChannelManager {
  private readonly _entries = new Map<string, Entry>();
  private readonly _packr: Packr;
  private readonly _opts: WebRtcChannelManagerOptions;
  private readonly _nowMs: () => number;
  private readonly _iceDeadlineMs: number;
  private readonly _bufferedAmountDegradeBytes: number;
  private readonly _slowSendMs: number;
  /** Overridable for tests (deterministic clock). */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  _perfNowForTests?: () => number;

  constructor(opts: WebRtcChannelManagerOptions) {
    this._opts = opts;
    // Match the WebSocket path's notepack semantics: an ABSENT optional snapshot
    // field must decode as `undefined`, NOT `null`. `encodeUndefinedAsNil: true`
    // encoded every `undefined` field (mounts/statAlloc/energy/level/...) as
    // msgpack nil, so the client decoded it as `null` — and readers guarded with
    // `!== undefined` then crashed (Object.keys(null) / null.length) on the
    // DataChannel but NEVER on WebSocket. That asymmetry was a load→spawn
    // showstopper that no E2E caught (every E2E runs WS; real users run DC).
    // msgpackr's default round-trips undefined→undefined via its undefined-ext.
    this._packr = new Packr({ encodeUndefinedAsNil: false });
    this._nowMs = opts.nowMs ?? (() => Date.now());
    this._iceDeadlineMs = opts.iceDeadlineMs ?? 5_000;
    this._bufferedAmountDegradeBytes =
      opts.bufferedAmountDegradeBytes ?? DEFAULT_BUFFERED_AMOUNT_DEGRADE_BYTES;
    this._slowSendMs = opts.slowSendMs ?? DEFAULT_SLOW_SEND_MS;
  }

  handleOffer(sessionId: string, sdp: string): void {
    let entry = this._entries.get(sessionId);
    if (!entry) {
      const pc = this._opts.peerConnectionFactory(sessionId);
      entry = {
        pc,
        dc: null,
        signaling: new WebRtcSignalingState({
          nowMs: this._nowMs,
          iceDeadlineMs: this._iceDeadlineMs,
        }),
        degraded: false,
        sentViaDc: 0,
        sentViaWs: 0,
        dcThrows: 0,
        dcBackpressureHits: 0,
        dcSlowSends: 0,
      };
      this._wirePc(sessionId, entry);
      this._entries.set(sessionId, entry);
    }
    entry.signaling.recvOffer();
    try {
      entry.pc.setRemoteDescription(sdp, 'offer');
    } catch (err) {
      this._logEvent('webrtc_offer_error', { sessionId, error: (err as Error).message });
    }
  }

  handleIce(sessionId: string, candidate: string, mid: string): void {
    const entry = this._entries.get(sessionId);
    if (!entry) return;
    entry.signaling.recvIce();
    try {
      entry.pc.addRemoteCandidate(candidate, mid);
    } catch (err) {
      this._logEvent('webrtc_ice_error', { sessionId, error: (err as Error).message });
    }
  }

  isDcSendable(sessionId: string): boolean {
    const entry = this._entries.get(sessionId);
    if (!entry) return false;
    if (entry.degraded) return false;
    if (!entry.signaling.isDcSendable()) return false;
    if (!entry.dc || !entry.dc.isOpen()) return false;
    return true;
  }

  /**
   * Hot-path send. Returns true when the snapshot was written to the DC; false
   * when the caller MUST send via the WS fallback. The `onFallback` callback
   * is invoked synchronously when the routing decision is "use WS" so callers
   * don't need to inspect the boolean and re-execute logic.
   */
  sendSnapshot(
    sessionId: string,
    snap: SnapshotMessage,
    onFallback: () => void,
  ): boolean {
    const entry = this._entries.get(sessionId);
    if (!entry || !entry.dc || entry.degraded || !entry.signaling.isDcSendable() || !entry.dc.isOpen()) {
      onFallback();
      if (entry) entry.sentViaWs += 1;
      this._logEvent('snap_route', {
        sessionId,
        via: 'ws',
        dcBufferedAmount: 0,
      });
      return false;
    }

    const ba = entry.dc.bufferedAmount();
    if (ba >= this._bufferedAmountDegradeBytes) {
      entry.dcBackpressureHits += 1;
      this._markDegraded(sessionId, entry, 'backpressure', { bufferedAmount: ba });
      onFallback();
      entry.sentViaWs += 1;
      return false;
    }

    const now = this._perfNowForTests ?? performance.now.bind(performance);
    const t0 = now();
    let sent = false;
    try {
      const buf = this._packr.pack(snap);
      sent = entry.dc.sendMessageBinary(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    } catch (err) {
      entry.dcThrows += 1;
      this._markDegraded(sessionId, entry, 'send-throw', { error: (err as Error).message });
      onFallback();
      entry.sentViaWs += 1;
      return false;
    }
    const dt = now() - t0;
    if (dt > this._slowSendMs) {
      entry.dcSlowSends += 1;
      this._logEvent('webrtc_slow_send', { sessionId, latencyMs: dt });
    }

    if (!sent) {
      // Native returned false (queue full, channel closed mid-send, etc.) — degrade.
      this._markDegraded(sessionId, entry, 'send-false', { bufferedAmount: ba });
      onFallback();
      entry.sentViaWs += 1;
      return false;
    }

    entry.sentViaDc += 1;
    this._logEvent('snap_route', {
      sessionId,
      via: 'dc',
      dcBufferedAmount: ba,
    });
    return true;
  }

  /** Iterate every entry and time-out any that have outlived the ICE deadline. */
  expireStale(): void {
    for (const [sessionId, entry] of this._entries) {
      const prev = entry.signaling.phase;
      entry.signaling.expireIfStale();
      if (entry.signaling.phase === 'failed' && prev !== 'failed') {
        this._logEvent('webrtc_ice_timeout', { sessionId });
      }
    }
  }

  cleanup(sessionId: string): void {
    const entry = this._entries.get(sessionId);
    if (!entry) return;
    try { entry.dc?.close(); } catch { /* noop */ }
    try { entry.pc.close(); } catch { /* noop */ }
    entry.signaling.onClose();
    this._entries.delete(sessionId);
  }

  cleanupAll(): void {
    for (const sessionId of [...this._entries.keys()]) this.cleanup(sessionId);
  }

  /**
   * Snapshot the per-session counters. Pure data — no live refs into the
   * internal entry map — so callers can serialise / persist / compare
   * without risk of mutating internal state. Called from the
   * `/dev/webrtc-counters` endpoint (not a hot-loop site, allocation OK).
   */
  getCounters(): WebRtcEntryCounters[] {
    const out: WebRtcEntryCounters[] = [];
    for (const [sessionId, entry] of this._entries) {
      out.push({
        sessionId,
        sentViaDc: entry.sentViaDc,
        sentViaWs: entry.sentViaWs,
        dcThrows: entry.dcThrows,
        dcBackpressureHits: entry.dcBackpressureHits,
        dcSlowSends: entry.dcSlowSends,
        degraded: entry.degraded,
      });
    }
    return out;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private _wirePc(sessionId: string, entry: Entry): void {
    entry.pc.onLocalDescription((sdp, type) => {
      if (type === 'answer') {
        entry.signaling.onLocalAnswerSet();
        try {
          this._opts.sendAnswer(sessionId, sdp);
        } catch (err) {
          this._logEvent('webrtc_send_answer_error', { sessionId, error: (err as Error).message });
        }
      }
    });

    entry.pc.onLocalCandidate((candidate, mid) => {
      try {
        this._opts.sendCandidate(sessionId, candidate, mid);
      } catch (err) {
        this._logEvent('webrtc_send_candidate_error', { sessionId, error: (err as Error).message });
      }
    });

    entry.pc.onDataChannel((dc) => {
      entry.dc = dc;
      dc.onOpen(() => {
        entry.signaling.onConnected();
        this._logEvent('webrtc_connected', { sessionId });
      });
      dc.onClosed(() => {
        if (!entry.degraded) this._markDegraded(sessionId, entry, 'dc-closed', {});
      });
      dc.onError((err) => {
        this._logEvent('webrtc_dc_error', { sessionId, error: err.message });
        this._markDegraded(sessionId, entry, 'dc-error', { error: err.message });
      });
    });

    entry.pc.onStateChange((state) => {
      this._logEvent('webrtc_pc_state', { sessionId, state });
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this._markDegraded(sessionId, entry, 'pc-' + state, {});
      }
    });
  }

  private _markDegraded(
    sessionId: string,
    entry: Entry,
    reason: string,
    extra: Record<string, unknown>,
  ): void {
    if (entry.degraded) return;
    entry.degraded = true;
    this._logEvent('webrtc_degraded', { sessionId, reason, ...extra });
  }

  private _logEvent(tag: string, data: Record<string, unknown>): void {
    try {
      this._opts.serverLogEvent(tag, data);
    } catch (err) {
      this._opts.logger?.warn({ err: (err as Error).message, tag }, 'WebRTC log emit failed');
    }
  }
}

// Production factory lives in `webrtcChannelFactory.ts` — that's where
// the `node-datachannel` native binding is loaded. Keeping this module
// binding-free lets the unit tests run without paying the native init
// cost AND prevents the binding from being loaded inside vitest pool
// workers that have no business spinning up libdatachannel.

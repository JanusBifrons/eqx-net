/**
 * Client-side WebRTC DataChannel transport.
 *
 * Two cooperating classes:
 *
 *   1. `DataChannelSnapshotReceiver` — pure helper that decodes incoming
 *      msgpackr bytes, runs the reordering guard (hostile review #5), and
 *      forwards the resulting `SnapshotMessage` to a callback. Unit-testable
 *      without DOM-level RTCPeerConnection.
 *
 *   2. `DataChannelTransport` — owns the `RTCPeerConnection` + receive-side
 *      `RTCDataChannel`, drives signaling over `colyseus.js` `room.send`,
 *      and wires the receiver to the channel `onmessage` event when the
 *      connection state reaches 'connected' (hostile review #6 — no
 *      message handler until connected, 5 s connect deadline).
 *
 * Production wiring: ColyseusClient holds one DataChannelTransport per
 * room and registers `onSnapshot` to push decoded snapshots back into the
 * existing handleSnapshot path. The Phase 1 server-side manager already
 * routes to the WebSocket on the server when the DC isn't open, so the
 * fallback path is "do nothing" — the WS-side `room.onMessage('snapshot',
 * ...)` keeps doing its existing thing.
 *
 * Plan: swift-otter (Phase 2).
 */

import { Packr, Unpackr } from '@colyseus/msgpackr';
import type { SnapshotMessage } from '../../shared-types/messages.js';

export interface DataChannelSnapshotReceiverOpts {
  onSnapshot: (snap: SnapshotMessage) => void;
  /**
   * Diag event sink. Optional — when absent the receiver silently drops
   * out-of-order / undecodable payloads.
   */
  onDiag?: (tag: string, data: Record<string, unknown>) => void;
}

const unpackr = new Unpackr({});

export class DataChannelSnapshotReceiver {
  private _lastSeenServerTick = -1;
  private readonly _opts: DataChannelSnapshotReceiverOpts;

  constructor(opts: DataChannelSnapshotReceiverOpts) {
    this._opts = opts;
  }

  /** Decode + reorder-guard + dispatch. Never throws. */
  handleBinary(buf: Uint8Array | ArrayBuffer): void {
    const view = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    let decoded: unknown;
    try {
      decoded = unpackr.unpack(view);
    } catch (err) {
      this._opts.onDiag?.('snap_dropped_decode', { error: (err as Error).message });
      return;
    }
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      (decoded as { type?: string }).type !== 'snapshot' ||
      typeof (decoded as { serverTick?: number }).serverTick !== 'number'
    ) {
      this._opts.onDiag?.('snap_dropped_shape', {});
      return;
    }
    const snap = decoded as SnapshotMessage;
    if (snap.serverTick <= this._lastSeenServerTick) {
      this._opts.onDiag?.('snap_dropped_old', {
        serverTick: snap.serverTick,
        lastSeenServerTick: this._lastSeenServerTick,
      });
      return;
    }
    this._lastSeenServerTick = snap.serverTick;
    this._opts.onSnapshot(snap);
  }

  /** Used on sector handoff — server tick resets to 0 at the destination. */
  reset(): void {
    this._lastSeenServerTick = -1;
  }
}

// ── DataChannelTransport — RTC plumbing wrapped around the receiver. ────────
//
// Below this point the code depends on browser globals (RTCPeerConnection,
// performance, addEventListener). Unit tests cover the receiver above; the
// transport-level integration is covered by the Phase 3 in-process node-
// datachannel integration test and the Phase 4 Playwright E2E.

export type TransportPhase =
  | 'idle'
  | 'offer-sent'
  | 'answer-received'
  | 'dc-open'
  | 'failed'
  | 'closed';

export interface DataChannelTransportOpts {
  /** Colyseus `room.send(type, payload)` callable. */
  send: (type: string, payload: unknown) => void;
  /**
   * Forward a decoded snapshot to the existing handleSnapshot pipeline.
   * Same shape the WS `room.onMessage('snapshot', cb)` callback expects.
   */
  onSnapshot: (snap: SnapshotMessage) => void;
  /**
   * Diag event sink. Same surface as the existing client log helpers.
   */
  onDiag?: (tag: string, data: Record<string, unknown>) => void;
  /**
   * STUN / TURN URLs. Defaults to Google's free STUN. The server's
   * Phase 1 manager uses the matching default.
   */
  iceServers?: RTCIceServer[];
  /**
   * Connect deadline in ms. Default 5000 (hostile review #6). On expiry
   * the transport transitions to `failed` and emits `webrtc_fallback`
   * over the signaling channel.
   */
  connectTimeoutMs?: number;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export class DataChannelTransport {
  private readonly _opts: DataChannelTransportOpts;
  private readonly _receiver: DataChannelSnapshotReceiver;
  private _pc: RTCPeerConnection | null = null;
  private _dc: RTCDataChannel | null = null;
  private _phase: TransportPhase = 'idle';
  private _connectTimer: ReturnType<typeof setTimeout> | null = null;
  // The msgpackr packr is unused on the receive-only client path today,
  // but stays available so a future Phase 2c bidirectional channel can
  // pack outgoing acks without a second module import.
  private readonly _packr = new Packr({ encodeUndefinedAsNil: true });

  constructor(opts: DataChannelTransportOpts) {
    this._opts = opts;
    this._receiver = new DataChannelSnapshotReceiver({
      onSnapshot: opts.onSnapshot,
      onDiag: opts.onDiag,
    });
  }

  get phase(): TransportPhase {
    return this._phase;
  }

  /**
   * Start the handshake. Triggered by the welcome handler in ColyseusClient.
   * Idempotent — re-entering returns early when not idle.
   */
  async start(): Promise<void> {
    if (this._phase !== 'idle') return;
    const iceServers = this._opts.iceServers ?? DEFAULT_ICE_SERVERS;
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers });
    } catch (err) {
      this._opts.onDiag?.('webrtc_init_error', { error: (err as Error).message });
      this._phase = 'failed';
      this._fallback('init-error');
      return;
    }
    this._pc = pc;

    pc.addEventListener('icecandidate', (e: RTCPeerConnectionIceEvent) => {
      if (e.candidate) {
        this._opts.send('webrtc_ice', {
          type: 'webrtc_ice',
          candidate: e.candidate.candidate,
          mid: e.candidate.sdpMid ?? '',
        });
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      const state = pc.connectionState;
      this._opts.onDiag?.('webrtc_pc_state', { state });
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        if (this._phase !== 'dc-open' && this._phase !== 'closed') {
          this._fallback('pc-' + state);
        }
      }
    });

    pc.addEventListener('datachannel', (e: RTCDataChannelEvent) => {
      // Server-spawned channel is only attached when the bidirectional
      // model lands later; today we create the channel client-side. Kept
      // for symmetry / future bidirectional traffic.
      this._attachDataChannel(e.channel);
    });

    // Client creates the channel; server receives via `onDataChannel`.
    //
    // `ordered: true, reliable: true` (default) chosen for now. The plan's
    // Phase 0 spike notes left this as a Phase 4 re-evaluation decision.
    // Phase 4 E2E evidence on 2026-05-29:
    //   - Default ordered+reliable: ~25 % gap reduction under Pattern B
    //     (still HOL-affected; below the plan's ≥ 70 % gate).
    //   - ordered:false, maxRetransmits:0 (UDP-semantics): DC arm gap
    //     count INCREASED. The plan's `recv_gap_long` metric measures
    //     inter-arrival gaps; unreliable mode INTENTIONALLY drops late
    //     packets which makes the gap between received snapshots
    //     LARGER, so the metric fires MORE often even though snapshot
    //     freshness improves. The metric isn't appropriate for the
    //     unreliable comparison.
    // Phone smoke (Phase 5) is the user-felt verdict. Defaults stay
    // ordered+reliable until the phone evidence either confirms benefit
    // or motivates the unreliable flip with a freshness-based metric.
    const dc = pc.createDataChannel('snapshot', { ordered: true });
    this._dc = dc;
    this._attachDataChannel(dc);

    let offer: RTCSessionDescriptionInit;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      this._opts.onDiag?.('webrtc_offer_error', { error: (err as Error).message });
      this._fallback('offer-error');
      return;
    }

    this._opts.send('webrtc_offer', {
      type: 'webrtc_offer',
      sdp: pc.localDescription?.sdp ?? offer.sdp ?? '',
    });
    this._phase = 'offer-sent';

    const timeoutMs = this._opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this._connectTimer = setTimeout(() => {
      if (this._phase !== 'dc-open' && this._phase !== 'closed') {
        this._fallback('connect-timeout');
      }
    }, timeoutMs);
  }

  async handleAnswer(sdp: string): Promise<void> {
    if (!this._pc) return;
    if (this._phase !== 'offer-sent') return;
    try {
      await this._pc.setRemoteDescription({ type: 'answer', sdp });
      this._phase = 'answer-received';
    } catch (err) {
      this._opts.onDiag?.('webrtc_answer_error', { error: (err as Error).message });
      this._fallback('answer-error');
    }
  }

  async handleIce(candidate: string, mid: string): Promise<void> {
    if (!this._pc) return;
    if (this._phase === 'closed' || this._phase === 'failed') return;
    try {
      await this._pc.addIceCandidate({ candidate, sdpMid: mid });
    } catch (err) {
      this._opts.onDiag?.('webrtc_ice_error', { error: (err as Error).message });
    }
  }

  /** Server confirmation of fallback. Closes the PC cleanly. */
  handleFallbackAck(): void {
    this.close('fallback-ack');
  }

  /** External shutdown — sector handoff, room leave, etc. */
  close(reason: string): void {
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
    try { this._dc?.close(); } catch { /* noop */ }
    try { this._pc?.close(); } catch { /* noop */ }
    this._dc = null;
    this._pc = null;
    this._phase = 'closed';
    this._opts.onDiag?.('webrtc_closed', { reason });
    this._receiver.reset();
  }

  /** Sector handoff: reset the reordering guard so the destination's
   *  serverTick (which restarts low) is accepted. */
  reset(): void {
    this._receiver.reset();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private _attachDataChannel(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    // Hostile #6: don't attach onmessage until connectionState is connected.
    // We register listeners now but gate the message dispatch on phase.
    dc.addEventListener('open', () => {
      if (this._connectTimer) {
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
      }
      this._phase = 'dc-open';
      this._opts.onDiag?.('webrtc_connected', {});
    });
    dc.addEventListener('close', () => {
      if (this._phase === 'dc-open') {
        this._fallback('dc-close');
      }
    });
    dc.addEventListener('error', (e: Event) => {
      const err = (e as { error?: Error }).error;
      this._opts.onDiag?.('webrtc_dc_error', { error: err?.message ?? 'unknown' });
      this._fallback('dc-error');
    });
    dc.addEventListener('message', (e: MessageEvent) => {
      // Hostile #6 guard — only dispatch when the PC is connected. Anything
      // arriving in `offer-sent` or `answer-received` is a renegotiation
      // artefact; ignore.
      if (this._phase !== 'dc-open') return;
      const data = e.data;
      if (data instanceof ArrayBuffer) this._receiver.handleBinary(data);
      else if (data instanceof Uint8Array) this._receiver.handleBinary(data);
      // The server only sends binary; ignore string frames.
    });
  }

  private _fallback(reason: string): void {
    if (this._phase === 'failed' || this._phase === 'closed') return;
    this._phase = 'failed';
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
    this._opts.onDiag?.('webrtc_fallback', { reason });
    try {
      this._opts.send('webrtc_fallback', { type: 'webrtc_fallback', reason });
    } catch {
      // Signaling channel may be down too; the WS-side snapshot stream
      // is still the path of record at this point.
    }
  }
}

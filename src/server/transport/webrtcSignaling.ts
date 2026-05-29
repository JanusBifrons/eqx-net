/**
 * Pure signaling state machine for the server-side WebRTC channel.
 *
 * The server is always the answerer in this architecture: the client creates
 * the offer (after receiving a `welcome` message) and the server replies
 * with an answer. Trickled ICE candidates flow both directions, but the
 * lifecycle phases below describe the server's perspective.
 *
 * This module has zero `node-datachannel` imports. The
 * `RTCPeerConnection` lives in `WebRtcChannelManager`; the state machine
 * here is a pure reducer over events. Unit-testable in isolation —
 * see `webrtcSignaling.test.ts`.
 *
 * Phases:
 *   idle               — initial; no remote offer received yet
 *   have-remote-offer  — client offer received; server preparing answer
 *   have-local-answer  — server answer sent; ICE-checking
 *   connected          — DataChannel `open` event fired
 *   failed             — ICE deadline (5 s) expired without `connected`
 *   closed             — explicit shutdown (peer leaves room, etc.)
 *
 * `failed` and `closed` are terminal — no further events can leave them.
 *
 * Plan: swift-otter (Phase 1).
 */

export type SignalingPhase =
  | 'idle'
  | 'have-remote-offer'
  | 'have-local-answer'
  | 'connected'
  | 'failed'
  | 'closed';

export interface WebRtcSignalingOptions {
  /** Monotonic wall-clock source for staleness checks. Defaults to `Date.now`. */
  nowMs?: () => number;
  /**
   * How long after the first offer arrives we wait for `onConnected` before
   * declaring failed. Hostile review #6 default: 5000 ms.
   */
  iceDeadlineMs?: number;
}

export interface WebRtcSignalingMetrics {
  /** Number of offer messages seen for this session (re-offers are tracked). */
  offersReceived: number;
  /** Number of local answers generated. */
  answersGenerated: number;
  /** Number of ICE candidates received from the client. */
  iceReceived: number;
  /**
   * ICE candidates dropped because they arrived before any offer (could
   * happen if the client trickles candidates before the offer is processed
   * on the server's event loop turn).
   */
  iceDroppedBeforeOffer: number;
  /** Whether `expireIfStale` fired a failed transition. */
  expiredCount: number;
}

const DEFAULT_ICE_DEADLINE_MS = 5_000;

export class WebRtcSignalingState {
  private _phase: SignalingPhase = 'idle';
  private _offerReceivedAtMs: number | null = null;
  private readonly _nowMs: () => number;
  private readonly _iceDeadlineMs: number;
  private readonly _metrics: WebRtcSignalingMetrics = {
    offersReceived: 0,
    answersGenerated: 0,
    iceReceived: 0,
    iceDroppedBeforeOffer: 0,
    expiredCount: 0,
  };

  constructor(opts: WebRtcSignalingOptions = {}) {
    this._nowMs = opts.nowMs ?? (() => Date.now());
    this._iceDeadlineMs = opts.iceDeadlineMs ?? DEFAULT_ICE_DEADLINE_MS;
  }

  get phase(): SignalingPhase {
    return this._phase;
  }

  get metrics(): Readonly<WebRtcSignalingMetrics> {
    return this._metrics;
  }

  recvOffer(): void {
    if (this._phase === 'failed' || this._phase === 'closed') return;
    this._metrics.offersReceived += 1;
    if (this._offerReceivedAtMs === null) this._offerReceivedAtMs = this._nowMs();
    // Re-offers are valid (re-negotiation); we don't reset phase if already past.
    if (this._phase === 'idle') this._phase = 'have-remote-offer';
  }

  onLocalAnswerSet(): void {
    if (this._phase === 'failed' || this._phase === 'closed') return;
    if (this._phase === 'have-remote-offer') {
      this._metrics.answersGenerated += 1;
      this._phase = 'have-local-answer';
    }
  }

  recvIce(): void {
    if (this._phase === 'failed' || this._phase === 'closed') return;
    if (this._phase === 'idle') {
      this._metrics.iceDroppedBeforeOffer += 1;
      return;
    }
    this._metrics.iceReceived += 1;
  }

  onConnected(): void {
    if (this._phase === 'failed' || this._phase === 'closed') return;
    this._phase = 'connected';
  }

  onClose(): void {
    this._phase = 'closed';
  }

  expireIfStale(): void {
    if (this._phase === 'connected' || this._phase === 'failed' || this._phase === 'closed') return;
    if (this._offerReceivedAtMs === null) return;
    const now = this._nowMs();
    if (now - this._offerReceivedAtMs >= this._iceDeadlineMs) {
      this._metrics.expiredCount += 1;
      this._phase = 'failed';
    }
  }

  isDcSendable(): boolean {
    return this._phase === 'connected';
  }
}

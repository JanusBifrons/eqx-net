/**
 * Phase 1 step 1 — failing-first test for the pure signaling state machine.
 *
 * Invariant #13: smoke-test bug reports require a failing test BEFORE the
 * fix. The same discipline applies to new features: the test goes first,
 * proves it fails (no implementation yet), then the implementation goes in.
 *
 * What this state machine owns:
 *   - The handshake lifecycle from the server's perspective (it's the
 *     answerer; the client is the offerer).
 *   - The 5 s ICE deadline (hostile review #6 mitigation).
 *   - Idempotent shutdown.
 *
 * What it deliberately does NOT own:
 *   - Any node-datachannel import. The PeerConnection lives in
 *     WebRtcChannelManager. The state machine is a pure reducer over
 *     events.
 *   - Network I/O. The caller drives transitions.
 *
 * Plan: swift-otter (Phase 1).
 */

import { describe, expect, it } from 'vitest';
import {
  WebRtcSignalingState,
  type SignalingPhase,
} from './webrtcSignaling.js';

describe('WebRtcSignalingState (pure reducer)', () => {
  it('starts in idle', () => {
    const sm = new WebRtcSignalingState();
    expect(sm.phase).toBe<SignalingPhase>('idle');
  });

  it('idle + recvOffer → have-remote-offer', () => {
    const sm = new WebRtcSignalingState();
    sm.recvOffer();
    expect(sm.phase).toBe<SignalingPhase>('have-remote-offer');
  });

  it('have-remote-offer + onLocalAnswerSet → have-local-answer', () => {
    const sm = new WebRtcSignalingState();
    sm.recvOffer();
    sm.onLocalAnswerSet();
    expect(sm.phase).toBe<SignalingPhase>('have-local-answer');
  });

  it('have-local-answer + onConnected → connected', () => {
    const sm = new WebRtcSignalingState();
    sm.recvOffer();
    sm.onLocalAnswerSet();
    sm.onConnected();
    expect(sm.phase).toBe<SignalingPhase>('connected');
  });

  it('records peer events without leaving idle when out of order', () => {
    // A stray ICE candidate before the offer must not throw. We log + drop.
    const sm = new WebRtcSignalingState();
    expect(() => sm.recvIce()).not.toThrow();
    expect(sm.phase).toBe<SignalingPhase>('idle');
    expect(sm.metrics.iceDroppedBeforeOffer).toBe(1);
  });

  it('have-local-answer accepts ICE candidates without state change', () => {
    const sm = new WebRtcSignalingState();
    sm.recvOffer();
    sm.onLocalAnswerSet();
    sm.recvIce();
    sm.recvIce();
    sm.recvIce();
    expect(sm.phase).toBe<SignalingPhase>('have-local-answer');
    expect(sm.metrics.iceReceived).toBe(3);
  });

  it('any phase + onClose → closed (idempotent)', () => {
    const a = new WebRtcSignalingState();
    a.onClose();
    expect(a.phase).toBe<SignalingPhase>('closed');
    a.onClose();
    a.onClose();
    expect(a.phase).toBe<SignalingPhase>('closed');

    const b = new WebRtcSignalingState();
    b.recvOffer();
    b.onLocalAnswerSet();
    b.onConnected();
    b.onClose();
    expect(b.phase).toBe<SignalingPhase>('closed');
  });

  it('phase events that arrive AFTER close are ignored, not reopened', () => {
    const sm = new WebRtcSignalingState();
    sm.recvOffer();
    sm.onClose();
    sm.onConnected();
    sm.recvIce();
    expect(sm.phase).toBe<SignalingPhase>('closed');
  });

  it('expireIfStale fires when iceDeadlineMs has elapsed and phase is not connected', () => {
    let nowMs = 0;
    const sm = new WebRtcSignalingState({ nowMs: () => nowMs, iceDeadlineMs: 5_000 });
    sm.recvOffer();
    sm.onLocalAnswerSet();
    nowMs = 4_999;
    sm.expireIfStale();
    expect(sm.phase).toBe<SignalingPhase>('have-local-answer');
    nowMs = 5_000;
    sm.expireIfStale();
    expect(sm.phase).toBe<SignalingPhase>('failed');
  });

  it('expireIfStale does NOT fire after onConnected — connected is terminal-ish', () => {
    let nowMs = 0;
    const sm = new WebRtcSignalingState({ nowMs: () => nowMs, iceDeadlineMs: 5_000 });
    sm.recvOffer();
    sm.onLocalAnswerSet();
    sm.onConnected();
    nowMs = 60_000;
    sm.expireIfStale();
    expect(sm.phase).toBe<SignalingPhase>('connected');
  });

  it('metrics: tracks recv/send counts for diagnostic snap_route emission', () => {
    const sm = new WebRtcSignalingState();
    sm.recvOffer();
    sm.recvOffer(); // a second offer is a re-negotiation; tracked but not a fault
    sm.onLocalAnswerSet();
    sm.recvIce();
    sm.recvIce();
    sm.recvIce();
    expect(sm.metrics.offersReceived).toBe(2);
    expect(sm.metrics.iceReceived).toBe(3);
    expect(sm.metrics.answersGenerated).toBe(1);
  });

  it('isDcSendable returns true only when phase === connected', () => {
    const sm = new WebRtcSignalingState();
    expect(sm.isDcSendable()).toBe(false);
    sm.recvOffer();
    expect(sm.isDcSendable()).toBe(false);
    sm.onLocalAnswerSet();
    expect(sm.isDcSendable()).toBe(false);
    sm.onConnected();
    expect(sm.isDcSendable()).toBe(true);
    sm.onClose();
    expect(sm.isDcSendable()).toBe(false);
  });
});

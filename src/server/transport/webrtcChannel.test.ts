/**
 * Phase 1 step 2/3 — WebRtcChannelManager unit + routing tests.
 *
 * Invariant #13: failing tests FIRST. The manager wraps the pure signaling
 * state machine with a peer-connection factory; tests inject a fake factory
 * so we don't need node-datachannel inside the vitest worker.
 *
 * Tests cover:
 *   - Sessions start in the WS-fallback routing state (DC not yet open).
 *   - Offer handling creates a PC + replies with an answer.
 *   - ICE candidates are forwarded to the PC.
 *   - When the client's DataChannel opens, signaling transitions to
 *     connected and isDcSendable() flips true.
 *   - sendSnapshot routes to DC when sendable + buffered amount under
 *     threshold; falls back to WS on degraded entries.
 *   - Cleanup closes the PC and removes the entry.
 *   - Stale offers (no DC open within iceDeadlineMs) expire to failed.
 *
 * Plan: swift-otter (Phase 1).
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { WebRtcChannelManager, type PeerConnectionFactory, type WebRtcPeerConnection, type WebRtcDataChannel } from './webrtcChannel.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

interface FakeDataChannel extends WebRtcDataChannel {
  _emitOpen(): void;
  _emitClosed(): void;
  _emitError(err: Error): void;
  _setBufferedAmount(n: number): void;
  _sendThrows: Error | null;
  sentMessages: Buffer[];
  closed: boolean;
}

interface FakePeerConnection extends WebRtcPeerConnection {
  _emitDataChannel(dc: FakeDataChannel): void;
  _emitLocalDescription(sdp: string, type: string): void;
  _emitLocalCandidate(candidate: string, mid: string): void;
  _emitStateChange(state: string): void;
  remoteSdp?: string;
  remoteSdpType?: string;
  candidates: { candidate: string; mid: string }[];
  closed: boolean;
}

function makeFakeDataChannel(): FakeDataChannel {
  let _bufferedAmount = 0;
  let _open = false;
  let _onOpen: (() => void) | null = null;
  let _onClosed: (() => void) | null = null;
  let _onError: ((err: Error) => void) | null = null;
  const sent: Buffer[] = [];
  let throwsOn: Error | null = null;
  const dc: FakeDataChannel = {
    isOpen: () => _open,
    bufferedAmount: () => _bufferedAmount,
    sendMessageBinary: (buf: Buffer) => {
      if (throwsOn) throw throwsOn;
      sent.push(Buffer.from(buf));
      return true;
    },
    onOpen: (cb) => { _onOpen = cb; },
    onClosed: (cb) => { _onClosed = cb; },
    onError: (cb) => { _onError = cb; },
    close: () => { _open = false; dc.closed = true; },
    closed: false,
    sentMessages: sent,
    get _sendThrows() { return throwsOn; },
    set _sendThrows(e: Error | null) { throwsOn = e; },
    _emitOpen: () => { _open = true; _onOpen?.(); },
    _emitClosed: () => { _open = false; _onClosed?.(); },
    _emitError: (err: Error) => { _onError?.(err); },
    _setBufferedAmount: (n: number) => { _bufferedAmount = n; },
  };
  return dc;
}

function makeFakePeerConnection(): FakePeerConnection {
  let _onLocalDesc: ((sdp: string, type: string) => void) | null = null;
  let _onLocalCand: ((cand: string, mid: string) => void) | null = null;
  let _onDC: ((dc: WebRtcDataChannel) => void) | null = null;
  let _onState: ((state: string) => void) | null = null;
  const candidates: { candidate: string; mid: string }[] = [];
  const pc: FakePeerConnection = {
    setRemoteDescription: (sdp: string, type: string) => {
      pc.remoteSdp = sdp;
      pc.remoteSdpType = type;
    },
    addRemoteCandidate: (candidate: string, mid: string) => {
      candidates.push({ candidate, mid });
    },
    close: () => { pc.closed = true; },
    onLocalDescription: (cb) => { _onLocalDesc = cb; },
    onLocalCandidate: (cb) => { _onLocalCand = cb; },
    onDataChannel: (cb) => { _onDC = cb; },
    onStateChange: (cb) => { _onState = cb; },
    candidates,
    closed: false,
    _emitLocalDescription: (sdp, type) => { _onLocalDesc?.(sdp, type); },
    _emitLocalCandidate: (cand, mid) => { _onLocalCand?.(cand, mid); },
    _emitDataChannel: (dc) => { _onDC?.(dc); },
    _emitStateChange: (state) => { _onState?.(state); },
  };
  return pc;
}

interface SignalingSink {
  answers: { sessionId: string; sdp: string }[];
  candidates: { sessionId: string; candidate: string; mid: string }[];
}

function makeManager(opts: {
  pcs?: Map<string, FakePeerConnection>;
  sink?: SignalingSink;
  nowMs?: () => number;
  iceDeadlineMs?: number;
} = {}) {
  const pcs = opts.pcs ?? new Map<string, FakePeerConnection>();
  const sink: SignalingSink = opts.sink ?? { answers: [], candidates: [] };
  const logEvents: { tag: string; data: Record<string, unknown> }[] = [];

  const factory: PeerConnectionFactory = (sessionId) => {
    const pc = makeFakePeerConnection();
    pcs.set(sessionId, pc);
    return pc;
  };

  const manager = new WebRtcChannelManager({
    peerConnectionFactory: factory,
    sendAnswer: (sessionId, sdp) => sink.answers.push({ sessionId, sdp }),
    sendCandidate: (sessionId, candidate, mid) => sink.candidates.push({ sessionId, candidate, mid }),
    serverLogEvent: (tag, data) => logEvents.push({ tag, data }),
    nowMs: opts.nowMs,
    iceDeadlineMs: opts.iceDeadlineMs,
  });

  // De-flake (2026-06-13): the per-send latency clock defaults to the real
  // `performance.now()`, so the `pack` + send bracketed by it measures real
  // wall-clock — under CI load (GC / scheduling jitter) a normally-instant send
  // exceeds the 2 ms `SLOW_SEND_MS` threshold and bumps `dcSlowSends`, flaking
  // the routing/backpressure tests that assert `dcSlowSends: 0` (it tripped CI
  // on PRs #46/#55/#58 — all unrelated client changes). Pin it to a FIXED clock
  // so dt is deterministically 0; the dedicated "logs webrtc_slow_send" test
  // overrides `_perfNowForTests` AFTER this with its own advancing stub, so the
  // slow-send threshold logic stays covered.
  (manager as unknown as { _perfNowForTests: () => number })._perfNowForTests = () => 0;

  return { manager, pcs, sink, logEvents };
}

function fakeSnap(): SnapshotMessage {
  return {
    type: 'snapshot',
    serverTick: 1,
    states: {},
    ackedTick: 0,
  } as SnapshotMessage;
}

describe('WebRtcChannelManager', () => {
  it('handleOffer creates a PC and replies with an answer once the local description is set', () => {
    const { manager, pcs, sink } = makeManager();

    manager.handleOffer('s1', 'mock-offer-sdp');
    const pc = pcs.get('s1');
    expect(pc).toBeDefined();
    expect(pc!.remoteSdp).toBe('mock-offer-sdp');
    expect(pc!.remoteSdpType).toBe('offer');

    pc!._emitLocalDescription('mock-answer-sdp', 'answer');
    expect(sink.answers).toEqual([{ sessionId: 's1', sdp: 'mock-answer-sdp' }]);
  });

  it('forwards local ICE candidates back to the signaling sink', () => {
    const { manager, pcs, sink } = makeManager();
    manager.handleOffer('s1', 'sdp');
    const pc = pcs.get('s1')!;
    pc._emitLocalCandidate('candidate:1 ...', '0');
    expect(sink.candidates).toEqual([{ sessionId: 's1', candidate: 'candidate:1 ...', mid: '0' }]);
  });

  it('handleIce adds remote candidates to the PC after offer', () => {
    const { manager, pcs } = makeManager();
    manager.handleOffer('s1', 'sdp');
    manager.handleIce('s1', 'cand-A', '0');
    manager.handleIce('s1', 'cand-B', '0');
    expect(pcs.get('s1')!.candidates).toEqual([
      { candidate: 'cand-A', mid: '0' },
      { candidate: 'cand-B', mid: '0' },
    ]);
  });

  it('isDcSendable flips true once the client DC arrives and opens', () => {
    const { manager, pcs } = makeManager();
    manager.handleOffer('s1', 'sdp');
    expect(manager.isDcSendable('s1')).toBe(false);

    const dc = makeFakeDataChannel();
    pcs.get('s1')!._emitDataChannel(dc);
    expect(manager.isDcSendable('s1')).toBe(false); // not open yet

    dc._emitOpen();
    expect(manager.isDcSendable('s1')).toBe(true);
  });

  it('sendSnapshot via DC: encodes + sends binary when sendable + buffered amount under threshold', () => {
    const { manager, pcs } = makeManager();
    manager.handleOffer('s1', 'sdp');
    const dc = makeFakeDataChannel();
    pcs.get('s1')!._emitDataChannel(dc);
    dc._emitOpen();

    const onFallback = vi.fn();
    const sent = manager.sendSnapshot('s1', fakeSnap(), onFallback);
    expect(sent).toBe(true);
    expect(dc.sentMessages.length).toBe(1);
    expect(dc.sentMessages[0]?.byteLength).toBeGreaterThan(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('sendSnapshot falls back to WS when not yet sendable', () => {
    const { manager } = makeManager();
    const onFallback = vi.fn();
    const sent = manager.sendSnapshot('unknown', fakeSnap(), onFallback);
    expect(sent).toBe(false);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('sendSnapshot falls back to WS when DC sendMessageBinary throws — entry stays degraded thereafter', () => {
    const { manager, pcs, logEvents } = makeManager();
    manager.handleOffer('s1', 'sdp');
    const dc = makeFakeDataChannel();
    pcs.get('s1')!._emitDataChannel(dc);
    dc._emitOpen();
    dc._sendThrows = new Error('SCTP fail');

    const onFallback = vi.fn();
    const sent = manager.sendSnapshot('s1', fakeSnap(), onFallback);
    expect(sent).toBe(false);
    expect(onFallback).toHaveBeenCalledTimes(1);

    // Subsequent sends should also fall back without throwing again — entry is now degraded.
    dc._sendThrows = null;
    const sent2 = manager.sendSnapshot('s1', fakeSnap(), onFallback);
    expect(sent2).toBe(false);
    expect(onFallback).toHaveBeenCalledTimes(2);

    expect(logEvents.some((e) => e.tag === 'webrtc_degraded')).toBe(true);
  });

  it('sendSnapshot falls back to WS when bufferedAmount exceeds the configured threshold', () => {
    const { manager, pcs } = makeManager();
    manager.handleOffer('s1', 'sdp');
    const dc = makeFakeDataChannel();
    pcs.get('s1')!._emitDataChannel(dc);
    dc._emitOpen();
    dc._setBufferedAmount(8 * 1024 + 1); // over the 8 KB threshold

    const onFallback = vi.fn();
    const sent = manager.sendSnapshot('s1', fakeSnap(), onFallback);
    expect(sent).toBe(false);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('cleanup(sessionId) closes the PC and removes the entry', () => {
    const { manager, pcs } = makeManager();
    manager.handleOffer('s1', 'sdp');
    const pc = pcs.get('s1')!;
    manager.cleanup('s1');
    expect(pc.closed).toBe(true);
    expect(manager.isDcSendable('s1')).toBe(false);
  });

  it('expireStale moves entries past the deadline into the failed phase', () => {
    let now = 0;
    const { manager, pcs } = makeManager({ nowMs: () => now, iceDeadlineMs: 5_000 });
    manager.handleOffer('s1', 'sdp');
    pcs.get('s1')!._emitLocalDescription('answer-sdp', 'answer');
    now = 6_000;
    manager.expireStale();
    expect(manager.isDcSendable('s1')).toBe(false);
    // After expiration, sendSnapshot must fall back.
    const onFallback = vi.fn();
    manager.sendSnapshot('s1', fakeSnap(), onFallback);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('cleanupAll() removes every entry', () => {
    const { manager, pcs } = makeManager();
    manager.handleOffer('s1', 'sdp');
    manager.handleOffer('s2', 'sdp');
    manager.handleOffer('s3', 'sdp');
    manager.cleanupAll();
    for (const pc of pcs.values()) expect(pc.closed).toBe(true);
    expect(manager.isDcSendable('s1')).toBe(false);
    expect(manager.isDcSendable('s2')).toBe(false);
    expect(manager.isDcSendable('s3')).toBe(false);
  });

  describe('getCounters — Phase 4 iteration 3 diagnostic surface', () => {
    it('returns empty array before any session is opened', () => {
      const { manager } = makeManager();
      expect(manager.getCounters()).toEqual([]);
    });

    it('reports per-session sentViaDc / sentViaWs / degraded after a mixed send sequence', () => {
      const { manager, pcs } = makeManager();
      // Session 1: DC opens + 3 successful DC sends.
      manager.handleOffer('s1', 'sdp');
      const dc1 = makeFakeDataChannel();
      pcs.get('s1')!._emitDataChannel(dc1);
      dc1._emitOpen();
      manager.sendSnapshot('s1', fakeSnap(), vi.fn());
      manager.sendSnapshot('s1', fakeSnap(), vi.fn());
      manager.sendSnapshot('s1', fakeSnap(), vi.fn());

      // Session 2: DC opens, 1 successful DC send, then sendMessageBinary
      // throws — degraded — next send falls back to WS.
      manager.handleOffer('s2', 'sdp');
      const dc2 = makeFakeDataChannel();
      pcs.get('s2')!._emitDataChannel(dc2);
      dc2._emitOpen();
      manager.sendSnapshot('s2', fakeSnap(), vi.fn());
      dc2._sendThrows = new Error('SCTP fail');
      manager.sendSnapshot('s2', fakeSnap(), vi.fn());
      // After degrade, further calls route via WS without re-throwing.
      manager.sendSnapshot('s2', fakeSnap(), vi.fn());

      // Session 3: never sendable — every snapshot routes via WS.
      const onFb3 = vi.fn();
      manager.sendSnapshot('s3', fakeSnap(), onFb3);
      manager.sendSnapshot('s3', fakeSnap(), onFb3);

      const counters = manager.getCounters();
      const bySession = new Map(counters.map((c) => [c.sessionId, c]));

      expect(bySession.get('s1')).toEqual({
        sessionId: 's1',
        sentViaDc: 3,
        sentViaWs: 0,
        dcThrows: 0,
        dcBackpressureHits: 0,
        dcSlowSends: 0,
        degraded: false,
      });
      expect(bySession.get('s2')).toEqual({
        sessionId: 's2',
        sentViaDc: 1,
        // The throw + post-degrade send + final routing call all count as WS.
        sentViaWs: 2,
        dcThrows: 1,
        dcBackpressureHits: 0,
        dcSlowSends: 0,
        degraded: true,
      });
      // s3 never handled an offer so no entry exists.
      expect(bySession.has('s3')).toBe(false);
    });

    it('reports dcBackpressureHits after a bufferedAmount-over-threshold send', () => {
      const { manager, pcs } = makeManager();
      manager.handleOffer('s1', 'sdp');
      const dc = makeFakeDataChannel();
      pcs.get('s1')!._emitDataChannel(dc);
      dc._emitOpen();
      dc._setBufferedAmount(8 * 1024 + 1);
      manager.sendSnapshot('s1', fakeSnap(), vi.fn());
      const [c] = manager.getCounters();
      expect(c?.dcBackpressureHits).toBe(1);
      expect(c?.sentViaDc).toBe(0);
      expect(c?.sentViaWs).toBe(1);
      expect(c?.degraded).toBe(true);
    });

    it('returns an array snapshot — mutating it does not affect internal state', () => {
      const { manager, pcs } = makeManager();
      manager.handleOffer('s1', 'sdp');
      const dc = makeFakeDataChannel();
      pcs.get('s1')!._emitDataChannel(dc);
      dc._emitOpen();
      manager.sendSnapshot('s1', fakeSnap(), vi.fn());

      const snap1 = manager.getCounters();
      // Mutate the returned array + element — should not leak back.
      snap1.length = 0;
      manager.sendSnapshot('s1', fakeSnap(), vi.fn());
      const snap2 = manager.getCounters();
      expect(snap2[0]?.sentViaDc).toBe(2);
    });
  });

  describe('hardening — hostile review #11 (send latency)', () => {
    let nowSeq = 0;
    let nextDtMs = 0;
    beforeEach(() => {
      nowSeq = 0;
      nextDtMs = 0;
    });

    it('logs webrtc_slow_send when a single send exceeds 2 ms', () => {
      // Inject a deterministic clock that advances by nextDtMs between
      // the pre-send sample and the post-send sample.
      let perfCalls = 0;
      const perfNow = () => {
        perfCalls += 1;
        return perfCalls % 2 === 1 ? nowSeq : nowSeq + nextDtMs;
      };

      const { manager, pcs, logEvents } = makeManager();
      // Swap in our deterministic perfNow.
      (manager as unknown as { _perfNowForTests: () => number })._perfNowForTests = perfNow;

      manager.handleOffer('s1', 'sdp');
      const dc = makeFakeDataChannel();
      pcs.get('s1')!._emitDataChannel(dc);
      dc._emitOpen();

      nextDtMs = 5;
      manager.sendSnapshot('s1', fakeSnap(), vi.fn());
      const slowEntries = logEvents.filter((e) => e.tag === 'webrtc_slow_send');
      expect(slowEntries.length).toBe(1);
      expect((slowEntries[0]!.data as { latencyMs: number }).latencyMs).toBeGreaterThan(2);
    });
  });
});

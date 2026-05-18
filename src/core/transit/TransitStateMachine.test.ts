import { describe, it, expect, beforeEach } from 'vitest';
import { TransitStateMachine, SPOOL_DURATION_MS } from './TransitStateMachine.js';
import { Bus, type BusEventPayloads } from '../events/Bus.js';

describe('TransitStateMachine', () => {
  let bus: Bus;
  let events: BusEventPayloads['TRANSIT_STATE_CHANGED'][];
  let m: TransitStateMachine;

  beforeEach(() => {
    bus = new Bus();
    events = [];
    bus.on('TRANSIT_STATE_CHANGED', (e) => events.push(e));
    m = new TransitStateMachine('player-1', bus, 3_000);
  });

  it('starts DOCKED', () => {
    expect(m.state).toBe('DOCKED');
    expect(m.rawState).toBe('DOCKED');
    expect(events).toHaveLength(0);
  });

  it('beginSpool transitions DOCKED → SPOOLING and emits once', () => {
    m.beginSpool(1000);
    expect(m.state).toBe('SPOOLING');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'TRANSIT_STATE_CHANGED', playerId: 'player-1', state: 'SPOOLING' });
  });

  it('beginSpool from non-DOCKED throws', () => {
    m.beginSpool(1000);
    expect(() => m.beginSpool(2000)).toThrow(/cannot beginSpool from SPOOLING/);
  });

  it('progress is 0 outside SPOOLING and monotonic in [0,1] during SPOOLING', () => {
    expect(m.progress(0)).toBe(0);
    m.beginSpool(1000);
    expect(m.progress(1000)).toBe(0);
    expect(m.progress(2500)).toBeCloseTo(0.5, 5);
    expect(m.progress(4000)).toBe(1);
    expect(m.progress(5000)).toBe(1); // clamps
  });

  it('beginTransit only legal from SPOOLING', () => {
    expect(() => m.beginTransit()).toThrow(/cannot beginTransit from DOCKED/);
    m.beginSpool(1000);
    m.beginTransit();
    expect(m.state).toBe('IN_TRANSIT');
    expect(events.map((e) => e.state)).toEqual(['SPOOLING', 'IN_TRANSIT']);
    expect(() => m.beginTransit()).toThrow(/cannot beginTransit from IN_TRANSIT/);
  });

  it('full happy path: DOCKED → SPOOLING → IN_TRANSIT → ARRIVED → DOCKED', () => {
    m.beginSpool(1000);
    m.beginTransit();
    m.arrive();
    expect(m.state).toBe('ARRIVED');
    m.reset();
    expect(m.state).toBe('DOCKED');
    expect(events.map((e) => e.state)).toEqual(['SPOOLING', 'IN_TRANSIT', 'ARRIVED']);
  });

  it('cancel from SPOOLING re-emits DOCKED on the bus and reads as DOCKED', () => {
    m.beginSpool(1000);
    m.cancel();
    // rawState distinguishes CANCELLED from DOCKED for the orchestrator.
    expect(m.rawState).toBe('CANCELLED');
    // Public state collapses CANCELLED into DOCKED so subscribers don't have
    // to handle a fifth case (Bus.ts's discriminated union has no CANCELLED).
    expect(m.state).toBe('DOCKED');
    expect(events.map((e) => e.state)).toEqual(['SPOOLING', 'DOCKED']);
  });

  it('cancel from non-SPOOLING throws', () => {
    expect(() => m.cancel()).toThrow(/cannot cancel from DOCKED/);
    m.beginSpool(1000);
    m.beginTransit();
    expect(() => m.cancel()).toThrow(/cannot cancel from IN_TRANSIT/);
  });

  it('reset from CANCELLED returns to DOCKED without an extra emit', () => {
    m.beginSpool(1000);
    m.cancel();
    const before = events.length;
    m.reset();
    expect(m.state).toBe('DOCKED');
    expect(events.length).toBe(before);
  });

  it('reset from non-{ARRIVED,CANCELLED} throws', () => {
    expect(() => m.reset()).toThrow(/cannot reset from DOCKED/);
    m.beginSpool(1000);
    expect(() => m.reset()).toThrow(/cannot reset from SPOOLING/);
  });

  it('arrive from non-IN_TRANSIT throws', () => {
    expect(() => m.arrive()).toThrow(/cannot arrive from DOCKED/);
    m.beginSpool(1000);
    expect(() => m.arrive()).toThrow(/cannot arrive from SPOOLING/);
  });

  it('scheduledCommitMs reflects spool start + spoolMs', () => {
    m.beginSpool(1000);
    // `m` is constructed in beforeEach with an EXPLICIT spoolMs of 3_000
    // (fast fixture, deliberately decoupled from the catalogue default) so
    // this assertion is independent of SPOOL_DURATION_MS. The default-spool
    // path is covered by the sibling test below via the constant.
    expect(m.scheduledCommitMs).toBe(1000 + 3_000);
  });

  it('default spool duration is SPOOL_DURATION_MS', () => {
    const dflt = new TransitStateMachine('p2');
    dflt.beginSpool(0);
    expect(dflt.scheduledCommitMs).toBe(SPOOL_DURATION_MS);
  });

  it('SPOOL_DURATION_MS is the post-tune 30 s (absolute revert-lock)', () => {
    // Slow-down-gameplay pass 2026-05-18 (plan: i-d-like-you-to-silly-penguin):
    // warp spool 10×, 3 s → 30 s. Every OTHER spool assertion is
    // constant-relative (asserts `=== SPOOL_DURATION_MS` or injects its own
    // fixture spoolMs), so a revert of the constant would pass them all. This
    // absolute literal is the regression lock that fails LOUDLY on a revert —
    // the transit-timing analogue of `ShipKindPhysics.tuning.test.ts`. It
    // also pins the value the server sends clients in the SPOOLING
    // `transit_state` message and that `HyperspaceOverlay` counts down from.
    expect(SPOOL_DURATION_MS).toBe(30_000);
  });

  it('works with no bus injected', () => {
    const noBus = new TransitStateMachine('p3');
    noBus.beginSpool(0);
    noBus.beginTransit();
    noBus.arrive();
    noBus.reset();
    expect(noBus.state).toBe('DOCKED');
  });
});

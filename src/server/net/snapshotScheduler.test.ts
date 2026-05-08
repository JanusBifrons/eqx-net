/**
 * Stage 5 — snapshot cadence & priority scheduler.
 *
 * Test-infra investment per the network-feel roadmap: encoding + priority +
 * phase-stagger logic moves into this pure module so it's testable without
 * spinning up a Colyseus SectorRoom. Each cycle's failing test lives here
 * before the implementation.
 */
import { describe, it, expect } from 'vitest';
import {
  computePhaseOffset,
  shouldBroadcastFar,
  shouldBroadcastClose,
  classifyShipTier,
  createTierState,
  createIdleTracker,
  noteSectorEvent,
  isSectorIdle,
  createLastInputCache,
  shouldIncludeLastInput,
  type ShipInputBits,
} from './snapshotScheduler';

describe('snapshotScheduler — phase offset (Stage 5 cycle 1)', () => {
  it('is deterministic for the same (playerId, modulus) pair', () => {
    const id = 'player-abc-123';
    expect(computePhaseOffset(id, 3)).toBe(computePhaseOffset(id, 3));
    expect(computePhaseOffset(id, 2)).toBe(computePhaseOffset(id, 2));
    expect(computePhaseOffset(id, 6)).toBe(computePhaseOffset(id, 6));
  });

  it('returns an integer in [0, modulus)', () => {
    for (const modulus of [2, 3, 6]) {
      for (const id of ['a', 'longer-id', 'p_42', '8f9d2c-uuid', '']) {
        const offset = computePhaseOffset(id, modulus);
        expect(Number.isInteger(offset)).toBe(true);
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(modulus);
      }
    }
  });

  it('distributes across all buckets for a representative id sample', () => {
    // 99 ids modulo 3 with a non-pathological hash should land in each
    // bucket at least 15% of the time. Fails if the hash returns a constant
    // or is biased toward one slot.
    const modulus = 3;
    const buckets = new Array(modulus).fill(0);
    for (let i = 0; i < 99; i++) {
      const id = `player-${i}-${(i * 31) % 7}`;
      buckets[computePhaseOffset(id, modulus)]++;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(15);
    }
  });

  it('two distinct playerIds produce different offsets often enough to stagger', () => {
    // Not a strict claim per pair — collisions exist for any finite hash —
    // but across 30 ids modulo 6 we should see at least 4 distinct buckets
    // exercised. Catches a stub `return 0` impl.
    const seen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      seen.add(computePhaseOffset(`session-${i}`, 6));
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});

describe('snapshotScheduler — far-tier cadence respects offset (Stage 5 cycle 2)', () => {
  it('fires every 3 ticks with the playerId-derived phase offset', () => {
    // For any id, the predicate should fire exactly when (tick + offset) % 3 === 0.
    for (const id of ['player-1', 'aaaa', 'bbbb', '8f9d2c-uuid']) {
      const offset = computePhaseOffset(id, 3);
      for (let tick = 0; tick < 30; tick++) {
        const expected = (tick + offset) % 3 === 0;
        expect(shouldBroadcastFar(tick, id)).toBe(expected);
      }
    }
  });

  it('over a 60-tick window, fires exactly 20 times (= 20 Hz at 60 Hz physics)', () => {
    for (const id of ['p1', 'p2', 'p3']) {
      let fires = 0;
      for (let tick = 0; tick < 60; tick++) {
        if (shouldBroadcastFar(tick, id)) fires++;
      }
      expect(fires).toBe(20);
    }
  });

  it('clients with different offsets do not all peak on the same tick', () => {
    // Find three ids that hash to distinct offsets in [0, 3) — they exist for any
    // FNV-1a impl over short strings; we just sample and pick.
    const idsByOffset = new Map<number, string>();
    for (let i = 0; i < 100 && idsByOffset.size < 3; i++) {
      const id = `staggertest-${i}`;
      const off = computePhaseOffset(id, 3);
      if (!idsByOffset.has(off)) idsByOffset.set(off, id);
    }
    expect(idsByOffset.size).toBe(3);
    // Across 6 ticks (LCM-ish window), each tick has at most 1 of the 3 firing.
    for (let tick = 0; tick < 6; tick++) {
      const firing = [...idsByOffset.values()].filter((id) => shouldBroadcastFar(tick, id)).length;
      expect(firing).toBeLessThanOrEqual(1);
    }
    // And every tick has SOMEONE firing — spread is even.
    for (let tick = 0; tick < 6; tick++) {
      const firing = [...idsByOffset.values()].filter((id) => shouldBroadcastFar(tick, id)).length;
      expect(firing).toBe(1);
    }
  });
});

describe('snapshotScheduler — close-tier cadence (Stage 5 cycle 3 prep)', () => {
  it('fires every 2 ticks with the playerId-derived phase offset', () => {
    for (const id of ['player-1', 'aaaa', 'bbbb']) {
      const offset = computePhaseOffset(id, 2);
      for (let tick = 0; tick < 30; tick++) {
        const expected = (tick + offset) % 2 === 0;
        expect(shouldBroadcastClose(tick, id)).toBe(expected);
      }
    }
  });

  it('over a 60-tick window, fires exactly 30 times (= 30 Hz at 60 Hz physics)', () => {
    for (const id of ['p1', 'p2']) {
      let fires = 0;
      for (let tick = 0; tick < 60; tick++) {
        if (shouldBroadcastClose(tick, id)) fires++;
      }
      expect(fires).toBe(30);
    }
  });
});

describe('snapshotScheduler — tier classification (Stage 5 cycle 3)', () => {
  const CLOSE = 1000;
  const MARGIN = 100;

  it('classifies a ship inside the close radius as close', () => {
    const state = createTierState();
    const ship = { x: 500, y: 0 };
    const recipient = { x: 0, y: 0 };
    expect(classifyShipTier(state, 'ship1', ship, recipient, CLOSE, MARGIN, 0)).toBe('close');
  });

  it('classifies a ship beyond the close radius as far', () => {
    const state = createTierState();
    const ship = { x: 1500, y: 0 };
    const recipient = { x: 0, y: 0 };
    expect(classifyShipTier(state, 'ship1', ship, recipient, CLOSE, MARGIN, 0)).toBe('far');
  });

  it('uses Euclidean distance — diagonal ships at radius/√2 are close', () => {
    const state = createTierState();
    // (700, 700) is sqrt(700^2 * 2) ≈ 990, just inside radius 1000.
    const ship = { x: 700, y: 700 };
    const recipient = { x: 0, y: 0 };
    expect(classifyShipTier(state, 'ship1', ship, recipient, CLOSE, MARGIN, 0)).toBe('close');
  });

  it('per-recipient state is isolated — same ship different recipients can be different tiers', () => {
    // No shared state across recipients — caller passes the recipient's
    // own TierStateForRecipient. Test that two states don't bleed into
    // each other.
    const stateA = createTierState();
    const stateB = createTierState();
    const ship = { x: 800, y: 0 };
    const recipientA = { x: 0, y: 0 };          // ship is 800 u away → close
    const recipientB = { x: 5000, y: 0 };       // ship is 4200 u away → far
    expect(classifyShipTier(stateA, 'ship1', ship, recipientA, CLOSE, MARGIN, 0)).toBe('close');
    expect(classifyShipTier(stateB, 'ship1', ship, recipientB, CLOSE, MARGIN, 0)).toBe('far');
  });
});

describe('snapshotScheduler — tier hysteresis (Stage 5 cycle 4)', () => {
  const CLOSE = 1000;
  const MARGIN = 100;

  it('a ship oscillating across the boundary does not flip tier every tick', () => {
    const state = createTierState();
    const recipient = { x: 0, y: 0 };
    // Ship hovers around the boundary (1000) with ±20 u jitter — well
    // inside the 100 u hysteresis margin. Should pin to whatever tier
    // it was first classified as.
    let prev: 'close' | 'far' | null = null;
    let flips = 0;
    for (let i = 0; i < 50; i++) {
      const x = 1000 + (i % 2 === 0 ? -20 : 20); // 980 ↔ 1020
      const tier = classifyShipTier(state, 'ship1', { x, y: 0 }, recipient, CLOSE, MARGIN, i);
      if (prev !== null && prev !== tier) flips++;
      prev = tier;
    }
    // After the very first classification, tier should be stable for the
    // remainder — strict zero flips for a ±20 u oscillation against a
    // 100 u margin.
    expect(flips).toBe(0);
  });

  it('crosses tier when the ship moves clearly past the margin', () => {
    const state = createTierState();
    const recipient = { x: 0, y: 0 };
    // Start inside the close radius — first classification is 'close'.
    expect(classifyShipTier(state, 'ship1', { x: 500, y: 0 }, recipient, CLOSE, MARGIN, 0)).toBe('close');
    // Move just past `close + margin = 1100` — should flip to 'far'.
    expect(classifyShipTier(state, 'ship1', { x: 1150, y: 0 }, recipient, CLOSE, MARGIN, 1)).toBe('far');
    // Move back to clearly inside `close - margin = 900` — flip to 'close'.
    expect(classifyShipTier(state, 'ship1', { x: 850, y: 0 }, recipient, CLOSE, MARGIN, 2)).toBe('close');
  });

  it('hysteresis band: ship at 1050 stays close after starting close, but stays far after starting far', () => {
    // Inside the band [close - margin, close + margin] = [900, 1100],
    // the tier should NOT change.
    const stateA = createTierState();
    const recipient = { x: 0, y: 0 };
    expect(classifyShipTier(stateA, 'ship1', { x: 800, y: 0 }, recipient, CLOSE, MARGIN, 0)).toBe('close');
    // Now nudge inside band — should stay close.
    expect(classifyShipTier(stateA, 'ship1', { x: 1050, y: 0 }, recipient, CLOSE, MARGIN, 1)).toBe('close');

    const stateB = createTierState();
    expect(classifyShipTier(stateB, 'ship1', { x: 1500, y: 0 }, recipient, CLOSE, MARGIN, 0)).toBe('far');
    // Same band position but starting far — should stay far.
    expect(classifyShipTier(stateB, 'ship1', { x: 1050, y: 0 }, recipient, CLOSE, MARGIN, 1)).toBe('far');
  });
});

describe('snapshotScheduler — idle suppression (Stage 5 cycle 5)', () => {
  const IDLE_THRESHOLD = 60; // 1 second at 60 Hz

  it('initial state is idle (no events yet)', () => {
    const tracker = createIdleTracker();
    expect(isSectorIdle(tracker, 100, IDLE_THRESHOLD)).toBe(true);
  });

  it('an event flips idle to false immediately', () => {
    const tracker = createIdleTracker();
    noteSectorEvent(tracker, 100);
    expect(isSectorIdle(tracker, 100, IDLE_THRESHOLD)).toBe(false);
  });

  it('stays not-idle for `idleThresholdTicks` ticks after the event', () => {
    const tracker = createIdleTracker();
    noteSectorEvent(tracker, 100);
    expect(isSectorIdle(tracker, 159, IDLE_THRESHOLD)).toBe(false); // 59 ticks later
  });

  it('flips back to idle after `idleThresholdTicks` ticks without an event', () => {
    const tracker = createIdleTracker();
    noteSectorEvent(tracker, 100);
    expect(isSectorIdle(tracker, 160, IDLE_THRESHOLD)).toBe(true); // 60 ticks later
  });

  it('multiple events keep the idle clock reset', () => {
    const tracker = createIdleTracker();
    noteSectorEvent(tracker, 100);
    noteSectorEvent(tracker, 130);
    noteSectorEvent(tracker, 150);
    // Latest event was at 150; still within threshold at 200 (50 ticks elapsed).
    expect(isSectorIdle(tracker, 200, IDLE_THRESHOLD)).toBe(false);
    expect(isSectorIdle(tracker, 210, IDLE_THRESHOLD)).toBe(true); // 60 ticks after 150
  });
});

describe('snapshotScheduler — re-arm on event (Stage 5 cycle 6)', () => {
  const IDLE_THRESHOLD = 60;

  it('event during idle re-arms — next isSectorIdle returns false', () => {
    const tracker = createIdleTracker();
    noteSectorEvent(tracker, 100);
    expect(isSectorIdle(tracker, 200, IDLE_THRESHOLD)).toBe(true); // idle
    noteSectorEvent(tracker, 200);
    expect(isSectorIdle(tracker, 200, IDLE_THRESHOLD)).toBe(false); // re-armed
  });

  it('after re-arm, idle window restarts from the new event tick', () => {
    const tracker = createIdleTracker();
    noteSectorEvent(tracker, 100);
    expect(isSectorIdle(tracker, 200, IDLE_THRESHOLD)).toBe(true); // idle
    noteSectorEvent(tracker, 200);
    // 59 ticks past the new event — still not idle.
    expect(isSectorIdle(tracker, 259, IDLE_THRESHOLD)).toBe(false);
    // 60 ticks past — idle again.
    expect(isSectorIdle(tracker, 260, IDLE_THRESHOLD)).toBe(true);
  });
});

describe('snapshotScheduler — lastInput omission (Stage 5 cycle 7)', () => {
  const idle: ShipInputBits = { thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false };
  const thrustOn: ShipInputBits = { thrust: true, turnLeft: false, turnRight: false, boost: false, reverse: false };
  const thrustAndTurn: ShipInputBits = { thrust: true, turnLeft: true, turnRight: false, boost: false, reverse: false };

  it('first call for a ship always includes lastInput', () => {
    const cache = createLastInputCache();
    expect(shouldIncludeLastInput(cache, 'ship1', idle)).toBe(true);
  });

  it('repeated identical input is omitted on the second send', () => {
    const cache = createLastInputCache();
    expect(shouldIncludeLastInput(cache, 'ship1', idle)).toBe(true);   // 1st send: include
    expect(shouldIncludeLastInput(cache, 'ship1', idle)).toBe(false);  // 2nd send: omit
    expect(shouldIncludeLastInput(cache, 'ship1', idle)).toBe(false);  // 3rd send: omit
  });

  it('a change in any bit re-includes the field', () => {
    const cache = createLastInputCache();
    shouldIncludeLastInput(cache, 'ship1', idle);
    shouldIncludeLastInput(cache, 'ship1', idle); // omitted (same)
    expect(shouldIncludeLastInput(cache, 'ship1', thrustOn)).toBe(true);     // thrust changed
    expect(shouldIncludeLastInput(cache, 'ship1', thrustOn)).toBe(false);    // unchanged again
    expect(shouldIncludeLastInput(cache, 'ship1', thrustAndTurn)).toBe(true); // turnLeft changed
  });

  it('per-ship cache is isolated', () => {
    const cache = createLastInputCache();
    expect(shouldIncludeLastInput(cache, 'shipA', idle)).toBe(true);
    expect(shouldIncludeLastInput(cache, 'shipB', idle)).toBe(true);   // ship B is "first time"
    expect(shouldIncludeLastInput(cache, 'shipA', idle)).toBe(false);  // ship A still cached
    expect(shouldIncludeLastInput(cache, 'shipB', thrustOn)).toBe(true);
    expect(shouldIncludeLastInput(cache, 'shipA', idle)).toBe(false);  // unaffected by ship B's change
  });
});

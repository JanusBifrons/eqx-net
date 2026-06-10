import { describe, it, expect } from 'vitest';
import {
  createFactionState,
  shouldDeEscalate,
  isBaseReady,
  FACTION_PEACEFUL_TIMEOUT_TICKS,
  type FactionState,
} from './Faction.js';

describe('Faction — createFactionState', () => {
  it('starts peaceful, no wave, never-damaged', () => {
    const s = createFactionState('p1');
    expect(s).toEqual({
      id: 'p1',
      hostileToDrones: false,
      lastDealtDamageTick: -Infinity,
      underWave: false,
    });
  });
});

describe('Faction — shouldDeEscalate', () => {
  const base = (over: Partial<FactionState> = {}): FactionState => ({
    ...createFactionState('p1'),
    ...over,
  });

  it('false while any miner survives, no matter how peaceful', () => {
    const s = base({ lastDealtDamageTick: -Infinity });
    expect(
      shouldDeEscalate(s, { minerCount: 1, nowTick: 1_000_000, peacefulTimeoutTicks: 10 }),
    ).toBe(false);
  });

  it('false when miners gone but still within the peaceful window', () => {
    const s = base({ lastDealtDamageTick: 1000 });
    // 1000 + 100 = 1100; nowTick 1050 is still inside the window
    expect(
      shouldDeEscalate(s, { minerCount: 0, nowTick: 1050, peacefulTimeoutTicks: 100 }),
    ).toBe(false);
  });

  it('true when miners gone AND peaceful window elapsed', () => {
    const s = base({ lastDealtDamageTick: 1000 });
    expect(
      shouldDeEscalate(s, { minerCount: 0, nowTick: 1101, peacefulTimeoutTicks: 100 }),
    ).toBe(true);
  });

  it('boundary: exactly at the timeout edge is NOT yet de-escalated (strict >)', () => {
    const s = base({ lastDealtDamageTick: 1000 });
    expect(
      shouldDeEscalate(s, { minerCount: 0, nowTick: 1100, peacefulTimeoutTicks: 100 }),
    ).toBe(false);
    expect(
      shouldDeEscalate(s, { minerCount: 0, nowTick: 1101, peacefulTimeoutTicks: 100 }),
    ).toBe(true);
  });

  it('never-damaged faction with no miners de-escalates immediately (−Infinity anchor)', () => {
    const s = base({ lastDealtDamageTick: -Infinity });
    expect(
      shouldDeEscalate(s, {
        minerCount: 0,
        nowTick: 5,
        peacefulTimeoutTicks: FACTION_PEACEFUL_TIMEOUT_TICKS,
      }),
    ).toBe(true);
  });
});

describe('Faction — isBaseReady', () => {
  const ready = { hasCapital: true, minerCount: 1, solarCount: 1, turretCount: 1 };

  it('true for the full Capital + Miner + Solar + Turret base', () => {
    expect(isBaseReady(ready)).toBe(true);
  });

  it.each([
    ['no capital', { ...ready, hasCapital: false }],
    ['no miner', { ...ready, minerCount: 0 }],
    ['no solar', { ...ready, solarCount: 0 }],
    ['no turret', { ...ready, turretCount: 0 }],
  ])('false when missing %s', (_label, comp) => {
    expect(isBaseReady(comp)).toBe(false);
  });

  it('true with more than the minimum of each', () => {
    expect(isBaseReady({ hasCapital: true, minerCount: 3, solarCount: 2, turretCount: 4 })).toBe(
      true,
    );
  });
});

/**
 * Plan: Equinox Tweaks/Improvements Phase 1 — issue 3 (Street-Fighter
 * chip-damage health bar).
 *
 * The bar shows TWO colours: the solid current-HP bar, and a lighter
 * "recent damage" chip band that lingers at the pre-hit level then drains
 * down to the true HP once the attack stops. Purely visual — true HP drops
 * instantly (the `healthPct` the manager already renders).
 *
 * This spec drives the manager through a `performance.now()` spy so the
 * hold + drain timing is deterministic, and asserts:
 *  - a hull hit (preHealthPct > healthPct) raises a chip band above true HP;
 *  - the chip HOLDS for CHIP_HOLD_MS, then drains toward true HP;
 *  - the chip settles exactly at true HP and stops re-dirtying the bar;
 *  - sustained fire pins the chip (no drain while hits keep landing);
 *  - a fresh hit after a full drain re-raises the chip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { HealthBarManager, CHIP_HOLD_MS, CHIP_DRAIN_PER_SEC } from './HealthBars.js';

vi.mock('pixi.js', () => {
  class FakeContainer {
    x = 0;
    y = 0;
    alpha = 1;
    children: unknown[] = [];
    addChild(c: unknown): void { this.children.push(c); }
    removeChild(c: unknown): void {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    }
    destroy(_opts?: unknown): void { /* noop */ }
  }
  class FakeGraphics extends FakeContainer {
    clear = vi.fn();
    rect = vi.fn().mockReturnThis();
    fill = vi.fn().mockReturnThis();
    destroy = vi.fn();
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

interface MutableMirror {
  ships: Map<string, { x: number; y: number }>;
}

function makeMirror(): RenderMirror {
  const m: MutableMirror = { ships: new Map() };
  return m as unknown as RenderMirror;
}

type ChipEntry = {
  chipHealthPct: number;
  healthPct: number;
  gfx: { clear: { mock: { calls: unknown[] } }; fill: { mock: { calls: unknown[] } } };
};
function entryOf(mgr: HealthBarManager, id: string): ChipEntry {
  return (mgr as unknown as { bars: Map<string, ChipEntry> }).bars.get(id)!;
}

describe('HealthBarManager — Street-Fighter chip-damage band', () => {
  let mgr: HealthBarManager;
  let mirror: RenderMirror;
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const parent = { addChild: vi.fn(), removeChild: vi.fn() };
    mgr = new HealthBarManager(parent as never);
    mirror = makeMirror();
    (mirror as unknown as MutableMirror).ships.set('ship-A', { x: 100, y: 200 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a hull hit raises a chip band above the true HP', () => {
    mgr.onHit('ship-A', 0.4, 0, /*preHealthPct*/ 0.8);
    mgr.update(mirror);
    const e = entryOf(mgr, 'ship-A');
    expect(e.healthPct).toBe(0.4);
    expect(e.chipHealthPct).toBeCloseTo(0.8, 5); // chip pinned at pre-hit level
  });

  it('no chip when preHealthPct omitted (shield-only / unknown)', () => {
    mgr.onHit('ship-A', 0.6, 0); // preHealthPct defaults to healthPct
    mgr.update(mirror);
    const e = entryOf(mgr, 'ship-A');
    expect(e.chipHealthPct).toBeCloseTo(0.6, 5); // equal to HP ⇒ no band
  });

  it('chip HOLDS for CHIP_HOLD_MS then drains toward true HP', () => {
    mgr.onHit('ship-A', 0.4, 0, 0.8);
    mgr.update(mirror); // t=1000, establishes lastUpdate baseline

    // Still within the hold window → chip unchanged.
    nowMs = 1000 + CHIP_HOLD_MS - 10;
    mgr.update(mirror);
    expect(entryOf(mgr, 'ship-A').chipHealthPct).toBeCloseTo(0.8, 5);

    // Step just past the hold, one ~50 ms frame → chip drops by ~rate*dt.
    nowMs += 50;
    mgr.update(mirror);
    const afterFirstDrain = entryOf(mgr, 'ship-A').chipHealthPct;
    expect(afterFirstDrain).toBeLessThan(0.8);
    expect(afterFirstDrain).toBeGreaterThan(0.4);
  });

  it('chip drains all the way to true HP and then stops re-dirtying', () => {
    mgr.onHit('ship-A', 0.4, 0, 0.8);
    mgr.update(mirror);
    // Drive ~2 s of 50 ms frames — far longer than the (0.8-0.4)/rate drain.
    for (let i = 0; i < 40; i++) {
      nowMs += 50;
      mgr.update(mirror);
    }
    const e = entryOf(mgr, 'ship-A');
    expect(e.chipHealthPct).toBeCloseTo(0.4, 5); // settled at true HP

    // Once settled, further frames must NOT rebuild geometry (dirty-flag holds).
    const clearsBefore = e.gfx.clear.mock.calls.length;
    nowMs += 50; mgr.update(mirror);
    nowMs += 50; mgr.update(mirror);
    expect(e.gfx.clear.mock.calls.length).toBe(clearsBefore);
  });

  it('sustained fire pins the chip (no drain while hits keep landing)', () => {
    mgr.onHit('ship-A', 0.9, 0, 1.0);
    mgr.update(mirror);
    // Hits every 100 ms (< CHIP_HOLD_MS) with falling HP — chip stays at 1.0.
    let hp = 0.9;
    for (let i = 0; i < 8; i++) {
      nowMs += 100;
      const prev = hp;
      hp = Math.max(0, hp - 0.1);
      mgr.onHit('ship-A', hp, 0, prev);
      mgr.update(mirror);
    }
    expect(entryOf(mgr, 'ship-A').chipHealthPct).toBeCloseTo(1.0, 5);
    expect(entryOf(mgr, 'ship-A').healthPct).toBeLessThan(0.4);
  });

  it('a fresh hit after a full drain re-raises the chip', () => {
    mgr.onHit('ship-A', 0.4, 0, 0.8);
    mgr.update(mirror);
    for (let i = 0; i < 40; i++) { nowMs += 50; mgr.update(mirror); } // drain to 0.4
    expect(entryOf(mgr, 'ship-A').chipHealthPct).toBeCloseTo(0.4, 5);

    // New attack: 0.4 -> 0.2, pre-hit 0.4 → chip re-raises above the new HP.
    nowMs += 50;
    mgr.onHit('ship-A', 0.2, 0, 0.4);
    mgr.update(mirror);
    const e = entryOf(mgr, 'ship-A');
    expect(e.healthPct).toBe(0.2);
    expect(e.chipHealthPct).toBeCloseTo(0.4, 5);
    expect(e.chipHealthPct).toBeGreaterThan(e.healthPct);
  });

  it('drain is time-based: amount = rate × time spent past the hold', () => {
    // Full gap (chip 1.0 → HP 0.0) so the drain isn't floored by reaching HP.
    mgr.onHit('ship-A', 0.0, 0, 1.0);
    mgr.update(mirror); // baseline at t=1000, lastHitTime=1000
    // 10 frames of 100 ms (each ≤ MAX_DRAIN_DT_MS, none clamped): t=1100..2000.
    // A frame drains iff timeSinceHit > CHIP_HOLD_MS(450) at update time, i.e.
    // t ≥ 1500 → 6 draining frames, each 1.5 × 0.1 = 0.15.
    for (let i = 0; i < 10; i++) { nowMs += 100; mgr.update(mirror); }
    const drained = 1.0 - entryOf(mgr, 'ship-A').chipHealthPct;
    expect(drained).toBeCloseTo(CHIP_DRAIN_PER_SEC * 0.1 * 6, 5); // 0.9
  });
});

/**
 * Warp-to visuals: the phase transitions drive the effects — spooling ships
 * glow, engage leaves a burst (streak + burning trails) that burns out, and a
 * drop leaves an arrival burst. Pooled: a second warp reuses the burst.
 */
import { describe, it, expect } from 'vitest';
import { WarpFx, type WarpFxShip } from './WarpFx.js';

const ship = (warp: 1 | 2 | undefined, x = 0, y = 0): WarpFxShip => ({ x, y, rotation: 0, warp, stern: 30, isLocal: false });

function frame(fx: WarpFx, ms: number, s: WarpFxShip): void {
  fx.beginFrame(ms);
  fx.draw('p1', s);
  fx.endFrame();
}

describe('WarpFx', () => {
  it('glows while spooling, bursts on engage, burns out, bursts again on drop', () => {
    const fx = new WarpFx();
    frame(fx, 0, ship(undefined));
    expect(fx.spoolCount()).toBe(0);
    frame(fx, 100, ship(1));
    expect(fx.spoolCount()).toBe(1);
    expect(fx.burstCount()).toBe(0);
    frame(fx, 3100, ship(2, 0, -5000)); // engage: the ship has already run ahead
    expect(fx.burstCount()).toBe(1);
    frame(fx, 6000, ship(2, 0, -60000)); // trails burnt out (2.6 s)
    expect(fx.burstCount()).toBe(0);
    frame(fx, 6100, ship(undefined, 0, -150000)); // drop
    expect(fx.burstCount()).toBe(1);
    frame(fx, 8000, ship(undefined, 0, -150000));
    expect(fx.burstCount()).toBe(0);
  });

  it('reuses pooled bursts across warps (no growth)', () => {
    const fx = new WarpFx();
    let t = 0;
    for (let i = 0; i < 5; i++) {
      frame(fx, (t += 100), ship(1));
      frame(fx, (t += 3000), ship(2, 0, -5000));
      frame(fx, (t += 3000), ship(undefined));
      frame(fx, (t += 3000), ship(undefined));
    }
    // One depart + one arrive in flight at most ⇒ the pool never needs more than 2.
    expect(fx.layer.children.length).toBeLessThanOrEqual(28 + 4 + 2);
  });

  it('forgets a ship that left the mirror', () => {
    const fx = new WarpFx();
    frame(fx, 0, ship(undefined));
    const n = fx.layer.children.length;
    fx.beginFrame(16); fx.endFrame();
    expect(fx.layer.children.length).toBe(n - 4);
  });

  it("another pilot's warp: departure on 1→2, arrival once on 3", () => {
    const fx = new WarpFx();
    const other = (warp: 1 | 2 | 3 | undefined, x = 0): WarpFxShip => ({ x, y: 0, rotation: 0, warp, stern: 30, isLocal: false });
    const f = (ms: number, s: WarpFxShip): void => { fx.beginFrame(ms); fx.draw('o', s); fx.endFrame(); };
    f(0, other(1));
    f(3000, other(2, 400));
    expect(fx.burstCount()).toBe(1); // departure
    f(6000, other(2, 90_000));
    expect(fx.burstCount()).toBe(0);
    f(6100, other(3, 170_000));
    expect(fx.burstCount()).toBe(1); // arrival
    f(6200, other(3, 170_000));
    f(9000, other(3, 170_000));
    expect(fx.burstCount()).toBe(0); // drawn once, burnt out
  });

  it("another pilot's departure points along its nose, not along a stale position change", () => {
    // Facing +x in Pixi space: rotation π/2 (nose = (sin r, -cos r)).
    const fx = new WarpFx();
    const s = (warp: 1 | 2, x: number, y: number, rotation: number): WarpFxShip => ({ x, y, rotation, warp, stern: 30, isLocal: false });
    const f = (ms: number, sh: WarpFxShip): void => { fx.beginFrame(ms); fx.draw('o', sh); fx.endFrame(); };
    f(0, s(1, 0, 0, Math.PI / 2)); // spooling, aligned to +x
    // On the run the mirror falls back to a stale pose AND heading.
    f(3000, s(2, -500, 800, 0));
    const d = fx.lastBurstDir();
    expect(d.x).toBeCloseTo(1, 5);
    expect(d.y).toBeCloseTo(0, 5);
  });

  it('a spooling ship that vanishes (it left for another sector) leaves along its spool heading', () => {
    const fx = new WarpFx();
    const s: WarpFxShip = { x: 0, y: 0, rotation: Math.PI / 2, warp: 1, stern: 30, isLocal: false };
    fx.beginFrame(0); fx.draw('o', s); fx.endFrame();
    fx.beginFrame(3000); fx.endFrame(); // gone from the mirror mid-spool
    expect(fx.burstCount()).toBe(1);
    expect(fx.lastBurstDir().x).toBeCloseTo(1, 5);
  });

  it('a ship that vanishes while idle leaves no burst', () => {
    const fx = new WarpFx();
    fx.beginFrame(0); fx.draw('o', { x: 0, y: 0, rotation: 0, warp: undefined, stern: 30, isLocal: false }); fx.endFrame();
    fx.beginFrame(100); fx.endFrame();
    expect(fx.burstCount()).toBe(0);
  });

  it("the pilot's own departure trails never reach past the ship (it accelerates away behind them)", () => {
    const fx = new WarpFx();
    // Facing up in Pixi (rotation 0: nose = (0, -1)).
    const me = (warp: 1 | 2, y: number): WarpFxShip => ({ x: 0, y, rotation: 0, warp, stern: 30, isLocal: true });
    const f = (ms: number, s2: WarpFxShip): void => { fx.beginFrame(ms, 1); fx.draw('me', s2); fx.endFrame(); };
    f(0, me(1, 0));
    f(1000, me(2, -40));   // departs: has only moved 40 u
    f(1300, me(2, -120));  // 0.3 s in: 120 u
    expect(fx.departReach()).toBeLessThanOrEqual(120 + 30 + 1);
  });
});

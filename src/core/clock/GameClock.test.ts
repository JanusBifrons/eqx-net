import { describe, it, expect } from 'vitest';
import { GameClock, MAX_TIME_SCALE, MIN_TIME_SCALE, type TimerHost } from './GameClock.js';

/** A fake wall clock with real-timer semantics, advanced by hand. */
class FakeWall implements TimerHost {
  t = 1_000;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  now = (): number => this.t;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void { this.timers.delete(h as number); }
  /** Advance wall time, firing due timers in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1; let nextAt = Infinity;
      for (const [id, tm] of this.timers) if (tm.at < nextAt) { nextAt = tm.at; nextId = id; }
      if (nextId < 0 || nextAt > end) break;
      const tm = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = nextAt;
      tm.fn();
    }
    this.t = end;
  }
}

describe('GameClock', () => {
  it('at 1× it is the wall clock (moving code onto it changes nothing)', () => {
    const w = new FakeWall();
    const c = new GameClock(w.now, w);
    expect(c.now()).toBe(1_000);
    w.advance(250);
    expect(c.now()).toBe(1_250);
  });

  it('runs at the scale, and a speed change never jumps game time', () => {
    const w = new FakeWall();
    const c = new GameClock(w.now, w);
    w.advance(100);
    c.setScale(2);
    expect(c.now()).toBe(1_100);
    w.advance(100);
    expect(c.now()).toBe(1_300);
    c.setScale(0.5);
    w.advance(100);
    expect(c.now()).toBe(1_350);
  });

  it('clamps the speed to 0.25–4×', () => {
    const c = new GameClock(() => 0);
    c.setScale(100);
    expect(c.scale).toBe(MAX_TIME_SCALE);
    c.setScale(0);
    expect(c.scale).toBe(MIN_TIME_SCALE);
    c.setScale(Number.NaN);
    expect(c.scale).toBe(1);
  });

  it('after(): a 1 s game timer takes 0.5 s of wall time at 2× and 2 s at 0.5×', () => {
    for (const [scale, wallMs] of [[2, 500], [0.5, 2_000]] as const) {
      const w = new FakeWall();
      const c = new GameClock(w.now, w);
      c.setScale(scale);
      let fired = 0;
      c.after(1_000, () => fired++);
      w.advance(wallMs - 1);
      expect(fired).toBe(0);
      w.advance(1);
      expect(fired).toBe(1);
    }
  });

  it('a speed change mid-timer re-arms it for the game time left', () => {
    const w = new FakeWall();
    const c = new GameClock(w.now, w);
    let fired = 0;
    c.after(1_000, () => fired++);
    w.advance(500); // half the game time gone at 1×
    c.setScale(4); // the other 500 game ms now take 125 wall ms
    w.advance(124);
    expect(fired).toBe(0);
    w.advance(1);
    expect(fired).toBe(1);
  });

  it('every(): repeats on game time without drifting, and cancels', () => {
    const w = new FakeWall();
    const c = new GameClock(w.now, w);
    c.setScale(2);
    let n = 0;
    const t = c.every(100, () => n++);
    w.advance(500); // 1,000 game ms
    expect(n).toBe(10);
    t.cancel();
    w.advance(500);
    expect(n).toBe(10);
  });

  it('cancelAll stops every pending timer', () => {
    const w = new FakeWall();
    const c = new GameClock(w.now, w);
    let n = 0;
    c.every(10, () => n++);
    c.after(10, () => n++);
    c.cancelAll();
    w.advance(100);
    expect(n).toBe(0);
  });

  it('tells listeners about speed changes', () => {
    const c = new GameClock(() => 0);
    const seen: number[] = [];
    const off = c.onScaleChange((s) => seen.push(s));
    c.setScale(2);
    c.setScale(2); // no change, no call
    off();
    c.setScale(1);
    expect(seen).toEqual([2]);
  });
});

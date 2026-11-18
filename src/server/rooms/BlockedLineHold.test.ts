/**
 * Blocked-line hold (owner 2026-11-18) on the ONE line-of-fire grid: a beam
 * or railgun mount holds once its line to the target has been blocked for
 * the tolerance; the target, the shooter and loot pods never block; a wreck
 * piece blocks a beam but not the railgun's slug; shells and missiles are
 * never held; cleanup and re-keying keep no stale timer.
 */
import { describe, expect, it } from 'vitest';
import { LineOfFireGate, type LineOfFireBody } from './LineOfFireGate.js';
import { BlockedLineHold } from './BlockedLineHold.js';
import { BLOCKED_LINE_HOLD_MS } from '../../core/combat/blockedLineHold.js';
import { rayHitsSphere } from '../../core/combat/Weapons.js';
import { SAB_TOTAL_BYTES, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';

interface Body extends LineOfFireBody { kind: number; shipKind?: string }

function world() {
  const sab = new Float32Array(new ArrayBuffer(SAB_TOTAL_BYTES));
  const recs: Body[] = [];
  let version = 1;
  const add = (id: string, x: number, y: number, radius: number, kind = 0, shipKind?: string): Body => {
    const slot = recs.length;
    const b = slotBase(slot);
    sab[b + SLOT_X_OFF] = x; sab[b + SLOT_Y_OFF] = y;
    const rec: Body = { id, slot, radius, kind, shipKind };
    recs.push(rec);
    version++;
    return rec;
  };
  const remove = (id: string): void => { recs.splice(recs.findIndex((r) => r.id === id), 1); version++; };
  let tick = 0;
  const gate = new LineOfFireGate<Body>({
    registry: { all: () => recs, get version() { return version; } },
    sabF32: sab,
    tick: () => tick,
    rayHit: (rec, fx, fy, dx, dy, max, cx, cy) => rayHitsSphere(fx, fy, dx, dy, max, cx, cy, rec.radius),
  });
  return { add, remove, gate, step: () => { tick++; } };
}

/** Shooter at the origin, target 1000 u ahead (+y). */
function duel() {
  const w = world();
  w.add('shooter', 0, 0, 20, 1, 'fighter');
  w.add('target', 0, 1000, 20, 1, 'fighter');
  return w;
}

describe('BlockedLineHold', () => {
  it('a beam holds only after its line has been blocked for the whole tolerance', () => {
    const w = duel();
    w.add('rock', 0, 500, 60);
    const h = new BlockedLineHold();
    for (let t = 0; t < BLOCKED_LINE_HOLD_MS; t += 50) {
      expect(h.held(w.gate, 'shooter', 0, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', t), `t=${t}`).toBe(false);
      w.step();
    }
    expect(h.held(w.gate, 'shooter', 0, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', BLOCKED_LINE_HOLD_MS)).toBe(true);
  });

  it('fire resumes the instant the line clears', () => {
    const w = duel();
    w.add('rock', 0, 500, 60);
    const h = new BlockedLineHold();
    h.held(w.gate, 'shooter', 0, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', 0);
    expect(h.held(w.gate, 'shooter', 0, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', 1_000)).toBe(true);
    w.remove('rock');
    expect(h.held(w.gate, 'shooter', 0, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', 1_016)).toBe(false);
    // A new block starts its own tolerance.
    w.add('rock2', 0, 400, 60);
    expect(h.held(w.gate, 'shooter', 0, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', 1_032)).toBe(false);
  });

  it('a brief crossing never stops fire', () => {
    const w = duel();
    const h = new BlockedLineHold();
    w.add('crosser', 0, 500, 30, 1, 'fighter');
    for (let t = 0; t < BLOCKED_LINE_HOLD_MS - 100; t += 50) {
      expect(h.held(w.gate, 'shooter', 0, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', t)).toBe(false);
    }
    w.remove('crosser');
    expect(h.held(w.gate, 'shooter', 0, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', BLOCKED_LINE_HOLD_MS + 100)).toBe(false);
  });

  it('shells with a travel time and missiles are never held', () => {
    const w = duel();
    w.add('rock', 0, 500, 60);
    const h = new BlockedLineHold();
    for (const id of ['laser', 'autocannon', 'naval_l', 'heat-seeker'] as const) {
      h.held(w.gate, 'shooter', 0, id, 0, 0, 0, 1000, 'shooter', 'target', 0);
      expect(h.held(w.gate, 'shooter', 0, id, 0, 0, 0, 1000, 'shooter', 'target', 5_000), id).toBe(false);
    }
    expect(h.checks, 'no line query for a weapon it does not cover').toBe(0);
  });

  it('the target, the shooter and loot pods never block', () => {
    const w = duel();
    w.add('pod', 0, 500, 30, 3, 'cargo-pod');
    const h = new BlockedLineHold();
    h.held(w.gate, 'shooter', 0, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', 0);
    expect(h.held(w.gate, 'shooter', 0, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', 5_000)).toBe(false);
  });

  it('a wreck piece blocks a beam but not the railgun slug', () => {
    const w = duel();
    w.add('wreck', 0, 500, 60, 4);
    const h = new BlockedLineHold();
    h.held(w.gate, 'beam', 0, 'heavy_beam', 0, 0, 0, 1000, 'shooter', 'target', 0);
    expect(h.held(w.gate, 'beam', 0, 'heavy_beam', 0, 0, 0, 1000, 'shooter', 'target', 5_000)).toBe(true);
    h.held(w.gate, 'rail', 0, 'railgun', 0, 0, 0, 1000, 'shooter', 'target', 0);
    expect(h.held(w.gate, 'rail', 0, 'railgun', 0, 0, 0, 1000, 'shooter', 'target', 5_000)).toBe(false);
    // ...but a rock stops the slug's line like any other shot.
    w.add('rock', 0, 300, 40);
    h.held(w.gate, 'rail', 0, 'railgun', 0, 0, 0, 1000, 'shooter', 'target', 6_000);
    expect(h.held(w.gate, 'rail', 0, 'railgun', 0, 0, 0, 1000, 'shooter', 'target', 7_000)).toBe(true);
  });

  it('timers are per mount, forgotten on cleanup and carried on a key move', () => {
    const w = duel();
    w.add('rock', 0, 500, 60);
    const h = new BlockedLineHold();
    h.held(w.gate, 'p1', 2, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', 0);
    expect(h.held(w.gate, 'p1', 1, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', 1_000), 'mount 1 starts its own timer').toBe(false);
    expect(h.held(w.gate, 'p1', 2, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', 1_000)).toBe(true);
    h.moved('p1', 'hull-1');
    expect(h.held(w.gate, 'hull-1', 2, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', 1_016), 'the timer moved with the key').toBe(true);
    h.forget('hull-1');
    expect(h.size).toBe(0);
    expect(h.held(w.gate, 'hull-1', 2, 'hitscan', 0, 0, 0, 1000, 'shooter', 'target', 1_032), 'a forgotten timer starts over').toBe(false);
  });
});

/**
 * Gate approach lights: lamp line from a gate pose (count, spacing, outside
 * side), the order the rabbit strobe walks, and the floor's build / sweep /
 * strobe lifecycle (default off behind `?approach=on`).
 */
import { describe, it, expect } from 'vitest';
import { Container, type Graphics } from 'pixi.js';
import {
  APPROACH_FLASH_MS, APPROACH_LAMP_COUNT, APPROACH_LAMP_SPACING, APPROACH_LAMP_START, APPROACH_LAMP_Z, APPROACH_PERIOD_MS,
  APPROACH_STEP_MS, DeckApproachLights, approachFlash, approachLampInto, gateOutsideSign, readApproachFlag,
} from './deckApproachLights.js';
import { StructureDeckPlates } from './structureDeckPlates.js';
import { DECK_HEX_INRADIUS } from '../../../core/hex/deckCorners.js';
import { deckHexCentreInto } from '../../../core/hex/plates.js';
import { DECK_FENCE_GATE_KIND } from '../../../core/structures/deckLinks.js';

const GATE = DECK_FENCE_GATE_KIND;

describe('readApproachFlag', () => {
  it('is off unless ?approach=on', () => {
    expect(readApproachFlag('')).toBe(false);
    expect(readApproachFlag('?approach=off')).toBe(false);
    expect(readApproachFlag('?approach=onward')).toBe(false);
    expect(readApproachFlag('?room=deck-bases&approach=on')).toBe(true);
  });
});

describe('gateOutsideSign', () => {
  it('picks the seam side whose hex is not plated', () => {
    // Gate at the origin, unturned: its local +y is game +y.
    expect(gateOutsideSign(0, 0, 0, (_x, y) => y < 0)).toBe(1);
    expect(gateOutsideSign(0, 0, 0, (_x, y) => y > 0)).toBe(-1);
    // Turned 90°: local +y is game −x.
    expect(gateOutsideSign(0, 0, Math.PI / 2, (x) => x > 0)).toBe(1);
  });

  it('has no outside with plates on both sides or neither', () => {
    expect(gateOutsideSign(0, 0, 0, () => true)).toBe(0);
    expect(gateOutsideSign(0, 0, 0, () => false)).toBe(0);
  });

  it('probes the two hex centres one inradius off the seam', () => {
    const probes: number[] = [];
    gateOutsideSign(10, 20, 0, (x, y) => { probes.push(x, y); return false; });
    expect(probes[0]).toBeCloseTo(10);
    expect(probes[1]).toBeCloseTo(20 + DECK_HEX_INRADIUS);
    expect(probes[3]).toBeCloseTo(20 - DECK_HEX_INRADIUS);
  });
});

describe('approachLampInto', () => {
  const out = new Float64Array(2);
  it('runs a straight line out along the road, evenly spaced, from just outside the seam', () => {
    const a = 0.7, gx = 300, gy = -200;
    const nx = -Math.sin(a), ny = Math.cos(a);
    for (let k = 0; k < APPROACH_LAMP_COUNT; k++) {
      approachLampInto(gx, gy, a, 1, k, out);
      const d = APPROACH_LAMP_START + k * APPROACH_LAMP_SPACING;
      expect(out[0]).toBeCloseTo(gx + nx * d);
      expect(out[1]).toBeCloseTo(gy + ny * d);
    }
    approachLampInto(gx, gy, a, -1, 0, out);
    expect(out[0]).toBeCloseTo(gx - nx * APPROACH_LAMP_START);
    expect(out[1]).toBeCloseTo(gy - ny * APPROACH_LAMP_START);
  });

  it('spacing ~120–150 u, about six lamps', () => {
    expect(APPROACH_LAMP_COUNT).toBe(6);
    expect(APPROACH_LAMP_SPACING).toBeGreaterThanOrEqual(120);
    expect(APPROACH_LAMP_SPACING).toBeLessThanOrEqual(150);
  });
});

describe('approachFlash (the rabbit)', () => {
  const n = APPROACH_LAMP_COUNT;
  /** The lamp at full flash at time t, or -1. */
  const lit = (t: number): number => {
    for (let k = 0; k < n; k++) if (approachFlash(k, n, t) === 1) return k;
    return -1;
  };

  it('walks from the farthest lamp toward the gate, one step at a time', () => {
    const order: number[] = [];
    for (let s = 0; s < n; s++) order.push(lit(s * APPROACH_STEP_MS));
    expect(order).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it('repeats every period, also before time zero', () => {
    for (const t of [0, 55, 300, 640]) {
      for (let k = 0; k < n; k++) {
        expect(approachFlash(k, n, t + APPROACH_PERIOD_MS)).toBeCloseTo(approachFlash(k, n, t));
        expect(approachFlash(k, n, t - 3 * APPROACH_PERIOD_MS)).toBeCloseTo(approachFlash(k, n, t));
      }
    }
    expect(APPROACH_PERIOD_MS).toBe(1500);
  });

  it('fades each flash out, and is dark between runs', () => {
    expect(approachFlash(n - 1, n, APPROACH_FLASH_MS / 2)).toBeGreaterThan(0);
    expect(approachFlash(n - 1, n, APPROACH_FLASH_MS / 2)).toBeLessThan(1);
    expect(approachFlash(n - 1, n, APPROACH_FLASH_MS)).toBe(0);
    const quiet = (n - 1) * APPROACH_STEP_MS + APPROACH_FLASH_MS + 10;
    expect(quiet).toBeLessThan(APPROACH_PERIOD_MS);
    for (let k = 0; k < n; k++) expect(approachFlash(k, n, quiet)).toBe(0);
  });
});

describe('DeckApproachLights', () => {
  const onPlate = (_x: number, y: number): boolean => y < 0;

  it('builds one lamp line per deck gate, on the outside, in the floor band', () => {
    const ships = new Container();
    const lights = new DeckApproachLights(ships, onPlate);
    lights.frame(true, 1, 0, undefined);
    lights.note(7, GATE, 100, 0, 0);
    lights.note(8, 'road', 100, -700, 0); // not a gate
    expect(lights.size).toBe(1);
    const c = lights.containerOf(7)!;
    expect(c.zIndex).toBe(APPROACH_LAMP_Z);
    expect(c.position.x).toBe(100);
    expect(c.children.length).toBe(2 * APPROACH_LAMP_COUNT);
    // Outside is game +y ⇒ Pixi −y, the first lamp just off the seam.
    expect(c.children[0]!.position.y).toBeCloseTo(-APPROACH_LAMP_START);
    expect(c.children[2 * (APPROACH_LAMP_COUNT - 1)]!.position.y)
      .toBeCloseTo(-(APPROACH_LAMP_START + (APPROACH_LAMP_COUNT - 1) * APPROACH_LAMP_SPACING));
  });

  it('strobes only the flash sprites, at effect time, and skips off-screen gates', () => {
    const ships = new Container();
    const lights = new DeckApproachLights(ships, onPlate);
    lights.frame(true, 1, 0, undefined);
    lights.note(7, GATE, 0, 0, 0);
    lights.frame(true, 1, 0, undefined); // t = 0: the farthest lamp is at full flash
    const c = lights.containerOf(7)!;
    lights.note(7, GATE, 0, 0, 0);
    const flash = (k: number): Graphics => c.children[2 * k + 1] as Graphics;
    expect(c.visible).toBe(true);
    expect(flash(APPROACH_LAMP_COUNT - 1).alpha).toBe(1);
    expect(flash(0).visible).toBe(false);
    lights.frame(true, 1, (APPROACH_LAMP_COUNT - 1) * APPROACH_STEP_MS, undefined); // the nearest one's turn
    lights.note(7, GATE, 0, 0, 0);
    expect(flash(0).alpha).toBe(1);
    expect(flash(APPROACH_LAMP_COUNT - 1).visible).toBe(false);
    lights.frame(true, 1, 0, new Float64Array([5000, 5000, 6000, 6000])); // camera far away
    expect(c.visible).toBe(false);
  });

  it('sweeps a gate that is gone, and everything off the deck', () => {
    const ships = new Container();
    const lights = new DeckApproachLights(ships, onPlate);
    lights.frame(true, 1, 0, undefined);
    lights.note(7, GATE, 0, 0, 0);
    lights.note(9, GATE, 2000, 0, 0);
    lights.frame(true, 1, 0, undefined);
    lights.note(9, GATE, 2000, 0, 0);
    lights.frame(true, 1, 0, undefined);
    expect(lights.size).toBe(1);
    expect(ships.children.length).toBe(1);
    lights.frame(false, 1, 0, undefined);
    expect(lights.size).toBe(0);
    expect(ships.children.length).toBe(0);
  });

  it('a gate between two plates (or none) draws no lamps', () => {
    const lights = new DeckApproachLights(new Container(), () => true);
    lights.frame(true, 1, 0, undefined);
    lights.note(7, GATE, 0, 0, 0);
    lights.frame(true, 1, 0, undefined);
    expect(lights.containerOf(7)!.visible).toBe(false);
  });
});

describe('on the deck floor (StructureDeckPlates)', () => {
  it('works out the outside from the floored plates, only with the flag on', () => {
    const plates = { version: 1, count: 1, ij: new Int32Array([0, 0]), deck: true };
    // Plate (0, 0) is its centre hex + ring; a gate on the ring hex's far seam faces out.
    const c = { x: 0, y: 0 };
    deckHexCentreInto(1, 0, c);
    const len = Math.hypot(c.x, c.y);
    const gx = c.x + (c.x / len) * DECK_HEX_INRADIUS, gy = c.y + (c.y / len) * DECK_HEX_INRADIUS;
    const angle = Math.atan2(c.y, c.x) - Math.PI / 2; // local +y points away from the plate
    const floor = new StructureDeckPlates(new Container(), 'plain', false, true);
    floor.sync(plates, 0);
    expect(floor.onPlate(0, 0)).toBe(true);
    floor.note(3, GATE, gx, gy, angle);
    const lamp = floor.approach!.containerOf(3)!.children[0]!.position;
    // The first lamp sits along +local y (away from the plate): farther from the origin than the gate.
    expect(Math.hypot(gx + lamp.x, gy - lamp.y)).toBeGreaterThan(Math.hypot(gx, gy));
    const off = new StructureDeckPlates(new Container(), 'plain', false);
    off.sync(plates, 0);
    off.note(3, GATE, gx, gy, angle);
    expect(off.approach).toBeUndefined();
  });
});

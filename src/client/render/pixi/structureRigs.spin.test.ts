/**
 * Reactor cooling fans (restyle Family 1, `reactor-fans`): the view spins
 * them on the tick clock (game time) while the reactor is fuelled and holds
 * them where they are when it runs dry. The live/dry signal is the reactor's
 * `noFuel` row flag, the same one its dark-core status overlay reads.
 */
import { describe, it, expect } from 'vitest';
import { StructureRigView } from './structureRigs.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { REACTOR_FAN_SPIN } from '../../../core/articulation/rigs/power.js';
import { reactorFanContext } from './structureStyleC.power.js';
import { bodyStatusCode } from './structureSocketNubs.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

const row = (built: boolean, noFuel?: boolean): StructureRenderState =>
  ({ built, noFuel, powered: true, buildPct: 1, deconstructPct: 0, connTo: [] }) as unknown as StructureRenderState;

const rotations = (v: StructureRigView): number[] => v.parts.map((g) => g.rotation);

describe('reactor fans (StructureRigView spin)', () => {
  it('draws every fan from the shared fan art', () => {
    const v = new StructureRigView(rigForStructureKind('reactor')!);
    expect(v.hasSpin).toBe(true);
    expect(v.parts.length).toBe(4);
    for (const g of v.parts) expect(g.context).toBe(reactorFanContext());
  });

  it('spins while fuelled, by the ticks that passed', () => {
    const v = new StructureRigView(rigForStructureKind('reactor')!);
    v.setRunningFrom(row(true));
    expect(v.running).toBe(true);
    v.update(null, 100, 0, 0, 0);
    const a = rotations(v);
    v.update(null, 109, 0, 0, 0);
    const b = rotations(v);
    expect(v.spinClock).toBeCloseTo(9);
    for (let i = 0; i < a.length; i++) expect(Math.abs(Math.sin(b[i]! - a[i]!))).toBeCloseTo(Math.abs(Math.sin(9 * REACTOR_FAN_SPIN)), 6);
  });

  it('stops where it is when dry, and starts again from there', () => {
    const v = new StructureRigView(rigForStructureKind('reactor')!);
    v.setRunningFrom(row(true));
    v.update(null, 0, 0, 0, 0);
    v.update(null, 20, 0, 0, 0);
    const held = rotations(v);
    v.setRunningFrom(row(true, true));
    expect(v.running).toBe(false);
    v.update(null, 50, 0, 0, 0);
    v.update(null, 400, 0, 0, 0);
    expect(rotations(v)).toEqual(held);
    v.setRunningFrom(row(true));
    v.update(null, 405, 0, 0, 0);
    expect(v.spinClock).toBeCloseTo(25);
  });

  it('the same row flag darkens the core (status) and stops the fans', () => {
    const v = new StructureRigView(rigForStructureKind('reactor')!);
    for (const [r, dark, runs] of [
      [row(true), 0, true], [row(true, true), 1, false], [row(false), 0, false], [undefined, 0, false],
    ] as const) {
      expect(bodyStatusCode('reactor', r)).toBe(dark);
      v.setRunningFrom(r);
      expect(v.running).toBe(runs);
    }
  });

  it('a clock that steps back (a reset) does not spin the fans backwards', () => {
    const v = new StructureRigView(rigForStructureKind('reactor')!);
    v.setRunningFrom(row(true));
    v.update(null, 100, 0, 0, 0);
    v.update(null, 110, 0, 0, 0);
    v.update(null, 5, 0, 0, 0);
    expect(v.spinClock).toBeCloseTo(10);
  });

  it('a rig with no spinning part runs no spin clock', () => {
    const v = new StructureRigView(rigForStructureKind('solar')!);
    expect(v.hasSpin).toBe(false);
    v.update(null, 0, 0, 0, 0);
    v.update(null, 60, 0, 0, 0);
    expect(v.spinClock).toBe(0);
  });
});

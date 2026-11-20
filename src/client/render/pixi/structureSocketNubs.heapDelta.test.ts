/**
 * Heap-delta lock (#14) for the socket-nub overlay's live body state (Stage 4
 * F1 step C): `updateSocketNubs` on batteries whose charge moves inside a
 * cell step and a reactor that stays dry allocates nothing per frame.
 *
 * Run with `pnpm test:gc`.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { updateSocketNubs } from './structureSocketNubs.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

function requireGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('--expose-gc not set; run via pnpm test:gc');
  return gc;
}

function row(): StructureRenderState {
  return { powered: true, netPower: 1, connTo: [], connSockSelf: [], built: true, buildPct: 1, deconstructPct: 0 };
}

describe('updateSocketNubs body state — heap', () => {
  it('does not grow the heap over 10k frames (battery, bank, dry reactor)', () => {
    const gc = requireGc();
    const bat = new Container(), bank = new Container(), reactor = new Container();
    const b = { ...row(), storedPower: 150, storedPowerMax: 300 };
    const k = { ...row(), storedPower: 1500, storedPowerMax: 3000 };
    const r = { ...row(), noFuel: true };
    const frame = (f: number): void => {
      b.storedPower = 150 + (f % 3); // inside one cell step
      k.storedPower = 1500 + (f % 7);
      updateSocketNubs(bat, 'battery', b);
      updateSocketNubs(bank, 'battery_bank', k);
      updateSocketNubs(reactor, 'reactor', r);
    };
    for (let f = 0; f < 2000; f++) frame(f);
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let f = 0; f < 10_000; f++) frame(f);
    gc();
    const after = process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(200_000);
  });
});

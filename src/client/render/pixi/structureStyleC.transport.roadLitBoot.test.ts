/**
 * Boot order lock (lit deck spike): the game loads the road style BEFORE the
 * lit road module, through an import cycle (road → deck plates → … → roadLit).
 * roadLit must not read the road's constants at module load, or the browser
 * throws "Cannot access 'ROAD_LANE' before initialization" and the game never
 * boots. This file imports the road FIRST, the browser's order.
 */
import { ROAD_LANE } from './structureStyleC.transport.road.js';
import { describe, it, expect } from 'vitest';

describe('lit road boot order', () => {
  it('loads with the road style imported first', async () => {
    const lit = await import('./structureStyleC.transport.roadLit.js');
    expect(Number.isFinite(lit.roadLitTones().joint)).toBe(true);
    expect(Number.isFinite(lit.roadLitTones().track)).toBe(true);
    expect(typeof ROAD_LANE).toBe('number');
  });
});

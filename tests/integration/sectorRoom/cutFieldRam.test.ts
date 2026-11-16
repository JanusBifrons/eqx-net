/**
 * Macro terrain v2 C2 (ramming, behind the `cutField` room option): a
 * battleship driven into a lane wall wakes the rock it touches, and that
 * rock, shoved on, wakes the fixed rocks it is driven into (chain wake), so
 * the capital ploughs through instead of pinning one woken rock against a
 * still-fixed wall. Same pose as the `cut-field-ram` showcase shot, closer in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

// A lane wall in the `look` field (showcase/shots/cutField.ts) and the
// heading straight into it.
const WALL = { x: -30_002, y: 27_191 };
const HEAD = { x: (-30_120 - WALL.x) / 700, y: (26_501 - WALL.y) / 700 };
const BACK = 2_400;

describe('SectorRoom integration — cut-field ramming', () => {
  it('a ramming battleship wakes rocks, and shoved rocks wake the rocks they hit', { timeout: 60_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: null, testMode: true, pilotCapitals: true, cutField: { seed: 'look' }, asteroidConfig: [], droneCount: 0 });
    const client = await harness.connectActive(randomUUID(), {
      shipKind: 'battleship', initialHull: 1_000_000, initialAngle: 2.972,
      spawnX: Math.round(WALL.x - HEAD.x * BACK), spawnY: Math.round(WALL.y - HEAD.y * BACK),
    });
    const thrust = setInterval(() => {
      client.send('input', { type: 'input', tick: 0, thrust: true, turnLeft: false, turnRight: false, boost: true });
    }, 50);
    try {
      const chain = await harness.events.waitFor(
        { tag: 'field_rock_woke', where: (d) => String((d as { by: string }).by).startsWith('field:') },
        { timeoutMs: 40_000 },
      );
      expect(String((chain.data as { id: string }).id)).toMatch(/^field:/);
      const woke = harness.events.all({ tag: 'field_rock_woke' });
      expect(woke.some((e) => !String((e.data as { by: string }).by).startsWith('field:'))).toBe(true); // the ship's own touch
    } finally {
      clearInterval(thrust);
    }
  });
});

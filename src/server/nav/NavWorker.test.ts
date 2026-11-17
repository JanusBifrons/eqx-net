/**
 * The nav worker through the REAL worker boundary: two sectors' fields build
 * in one worker, replies route to the right sector, and detach frees one.
 */
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { NavWorker } from './NavWorker.js';
import { CoarseFieldMap } from '../../core/nav/coarseField.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { ChunkOpts } from '../../core/terrain/fieldLayout.js';

const opts = (seed: string): ChunkOpts => ({
  seed, battleshipLength: getShipKind('battleship').radius * 2, fighterLength: getShipKind('fighter').radius * 2,
  clearings: [{ x: 60_000, y: -40_000, r: 12_000 }],
});

describe('NavWorker', () => {
  it('builds each sector field in the worker and prints size + build ms', async () => {
    const nav = new NavWorker(pino({ level: 'silent' }));
    const [a, b] = await Promise.all([nav.addField(opts('look')), nav.addField(opts('far-zoom'))]);
    expect(a.worldId).not.toBe(b.worldId);
    const direct = new CoarseFieldMap();
    direct.build(opts('look'));
    expect(a.built).toMatchObject({ type: 'FIELD_BUILT', worldId: a.worldId, cols: direct.cols, rows: direct.rows, bytes: direct.room.byteLength * 3 });
    expect(b.built.worldId).toBe(b.worldId);
    console.log(`[nav worker] coarse ${a.built.cols}x${a.built.rows}, ${(a.built.bytes / 1024).toFixed(0)} KB, built in ${a.built.ms.toFixed(1)} ms (worker)`);
    a.detach();
    a.detach(); // idempotent
    const c = await nav.addField(opts('nav-a')); // still serving after a detach
    expect(c.built.worldId).toBe(c.worldId);
    b.detach(); c.detach();
  }, 30_000);
});

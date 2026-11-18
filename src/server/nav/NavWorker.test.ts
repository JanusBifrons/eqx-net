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
    const a = nav.addField(opts('look')), b = nav.addField(opts('far-zoom'));
    expect(a.worldId).not.toBe(b.worldId);
    // Chunk and rock events posted before the build replies queue in order behind it.
    a.chunk(10, 3, true); a.rockGone(123); a.rockMoved(456, null); a.chunk(10, 3, false);
    const [ab, bb] = await Promise.all([a.built, b.built]);
    const direct = new CoarseFieldMap();
    direct.build(opts('look'));
    expect(ab).toMatchObject({ type: 'FIELD_BUILT', worldId: a.worldId, cols: direct.cols, rows: direct.rows, bytes: direct.room.byteLength * 3 });
    expect(bb.worldId).toBe(b.worldId);
    console.log(`[nav worker] coarse ${ab.cols}x${ab.rows}, ${(ab.bytes / 1024).toFixed(0)} KB, built in ${ab.ms.toFixed(1)} ms (worker)`);
    a.detach();
    a.detach(); // idempotent
    a.chunk(1, 1, true); // after detach: nothing posted
    const c = nav.addField(opts('nav-a')); // still serving after a detach
    expect((await c.built).worldId).toBe(c.worldId);
    b.detach(); c.detach();
  }, 30_000);

  it('answers route requests by reqId, counts them in flight, and answers none after detach', async () => {
    const nav = new NavWorker(pino({ level: 'silent' }));
    const a = nav.addField(opts('look'));
    const R = 150_000 * 1.2, c = getShipKind('battleship').radius;
    const across = a.route(-R, 0, R, 0, c), clear = a.route(R, 0, R, 20_000, c);
    expect(nav.inFlight).toBe(2);
    const [x, y] = await Promise.all([across, clear]);
    expect(nav.inFlight).toBe(0);
    expect(x.status).toBe('route');
    expect(x.points.length).toBeGreaterThan(2);
    expect(Array.from(x.points.slice(-2))).toEqual([R, 0]);
    expect(y).toMatchObject({ status: 'straight', expanded: 0 });
    expect(Array.from(y.points)).toEqual([R, 20_000]);
    console.log(`[nav worker] battleship across: ${x.points.length / 2} waypoints, ${x.expanded} expansions, ${x.ms.toFixed(1)} ms (worker)`);
    a.detach();
    expect(await a.route(-R, 0, R, 0, c)).toMatchObject({ status: 'none' });
    expect(nav.inFlight).toBe(0);
  }, 30_000);
});

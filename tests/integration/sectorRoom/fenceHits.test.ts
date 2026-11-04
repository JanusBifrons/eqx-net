/**
 * Fence hits reach the client (bug, user report 2026-11-04: "the fence thing,
 * that's a bug" — fences showed nothing when shot).
 *
 * When a powered shield fence stops a bolt, the server used to delete the
 * projectile silently (ProjectilePipeline → ShieldWallManager.blockProjectile),
 * so no client could draw the impact. This crosses the real wire: a bolt is
 * fired into a two-pylon fence and the connected client must receive a
 * `wall_hit` with the impact point ON the wall.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

describe('SectorRoom integration — fence hits reach the client', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('a bolt stopped by a fence broadcasts wall_hit at the impact point', async () => {
    // Same layout as shieldFence.test.ts: the pylon pair forms a wall along
    // x = 520 from y = 0 to y = 500.
    harness = await bootSectorTestServer({
      asteroidConfig: [],
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 400, y: 0 },
        { kind: 'shield_pylon', x: 520, y: 0 },
        { kind: 'shield_pylon', x: 520, y: 500 },
      ],
    });
    const client = await harness.connectAs('player-1');
    const internals = harness.getServerRoom()!._internals;
    for (let i = 0; i < 3; i++) internals.pulseStructureGrid();

    const hits: Array<{ x: number; y: number; kind: string }> = [];
    client.onMessage('wall_hit', (m: { x: number; y: number; kind: string }) => { hits.push(m); });

    // A bolt crossing the fence left to right at y = 250.
    internals.spawnTestProjectile('test-shooter', 320, 250, 900, 0);
    for (let i = 0; i < 20 && hits.length === 0; i++) await harness.advance(100);

    expect(hits.length, 'the client hears about the fence hit').toBeGreaterThan(0);
    expect(hits[0]!.kind).toBe('bolt');
    expect(Math.abs(hits[0]!.x - 520)).toBeLessThan(40); // on the wall
    expect(Math.abs(hits[0]!.y - 250)).toBeLessThan(10);
  }, 25_000);
});

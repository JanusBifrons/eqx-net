/**
 * Real-scale ranges slice 7, client side: a naval shell first seen far out
 * (the server now sends it from the first snapshot when its fall point is in
 * the viewer's widest view, up to ~30 km away) is adopted at the server's
 * position with no distance guard, and later snapshots keep it (no re-seed,
 * no drop) so the per-frame straight-line extrapolation carries it.
 */
import { describe, expect, it } from 'vitest';
import { syncProjectiles } from './SnapshotSyncHelpers.js';
import type { RenderMirror, ProjectileRenderState } from '../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

type Proj = NonNullable<SnapshotMessage['projectiles']>[number];

describe('syncProjectiles — a far first-seen naval shell', () => {
  it('is adopted at the server pose 25 km away and kept across snapshots', () => {
    const mirror = { projectiles: new Map<string, ProjectileRenderState>() } as unknown as RenderMirror;
    const seen = new Set<string>();
    const p: Proj = { id: 'proj-1', x: -25_000, y: 0, vx: 1290, vy: 0, ownerId: 'swarm-7', weaponId: 'naval_xl' } as Proj;
    syncProjectiles(mirror, [p], seen);
    const e = mirror.projectiles!.get('proj-1')!;
    expect(e).toBeDefined();
    expect(e.x).toBe(-25_000);
    expect(e.isGhost).toBe(false);
    // Client extrapolation moves it; the next snapshot keeps the same entry.
    e.x += 1290 / 20;
    syncProjectiles(mirror, [{ ...p, x: -25_000 + 1290 / 20 }], seen);
    expect(mirror.projectiles!.get('proj-1')).toBe(e);
  });
});

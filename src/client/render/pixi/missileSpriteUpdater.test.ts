/**
 * Missile sprites resolve on the MAIN-THREAD clock (netcode gap smoothing
 * S5-W). Missile samples are stamped on the main thread; on desktop the
 * renderer is a worker whose `performance.now()` counts from its own, later
 * `timeOrigin`. Passing that clock to `resolveMissileDisplayPose` drew every
 * missile at the wrong point in its history. The pose now resolves at
 * `mirror.frameTimeMs` (main-thread time riding the mirror).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Container, Graphics } from 'pixi.js';

vi.mock('./spriteBuilders.js', () => ({
  buildMissileGfx: (): unknown => ({ x: 0, y: 0, rotation: 0, alpha: 1, destroy: (): void => {} }),
  buildMissileExplosionGfx: (): unknown => ({ x: 0, y: 0, alpha: 1, scale: { x: 1, set: (): void => {} }, destroy: (): void => {} }),
}));

import { missilePoseNowMs, updateMissileSprites, type MissileSpriteCtx } from './missileSpriteUpdater.js';
import { applyMissileSnapshot, resolveMissileDisplayPose } from '../../combat/MissileMirror.js';
import { resetSwarmTickClock } from '../../net/swarmInterpolation.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { SnapshotMessage } from '../../../shared-types/messages/snapshotMessages';

/** How far the worker's clock lags the window's (worker started later). */
const WORKER_CLOCK_OFFSET_MS = 5000;
const MISSILE_ID = 1;

function slice(x: number): NonNullable<SnapshotMessage['missiles']> {
  return [{ id: MISSILE_ID, x, y: 0, vx: 1000, vy: 0, angle: 0, angvel: 0, ownerId: 'p', weaponId: 'heat-seeker', lifePct: 1 }];
}

function makeCtx(): MissileSpriteCtx {
  const container = { addChild: (): void => {}, removeChild: (): void => {} } as unknown as Container;
  return {
    shipContainer: container,
    missileSprites: new Map<number, Graphics>(),
    missileSeenScratch: new Set<number>(),
    activeExplosions: [],
  };
}

function mirrorWithMissile(): RenderMirror {
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
  // Main-thread stamps, 50 ms apart.
  applyMissileSnapshot(slice(0), mirror, 1, 10_000);
  applyMissileSnapshot(slice(50), mirror, 2, 10_050);
  return mirror;
}

describe('missile sprites resolve on the main-thread clock', () => {
  beforeEach(() => resetSwarmTickClock());

  it('a worker clock offset does not move the drawn pose', () => {
    const mirror = mirrorWithMissile();
    const mainNowMs = 10_120;
    mirror.frameTimeMs = mainNowMs;
    const expected = resolveMissileDisplayPose(mirror, MISSILE_ID, mainNowMs)!;
    const ctx = makeCtx();

    updateMissileSprites(mirror, ctx, mainNowMs - WORKER_CLOCK_OFFSET_MS);

    const g = ctx.missileSprites.get(MISSILE_ID)!;
    expect(g.x).toBeCloseTo(expected.x, 6);
    expect(g.y).toBeCloseTo(-expected.y, 6);
    // The worker clock alone would resolve somewhere else entirely.
    const atWorkerClock = resolveMissileDisplayPose(mirror, MISSILE_ID, mainNowMs - WORKER_CLOCK_OFFSET_MS)!;
    expect(Math.abs(atWorkerClock.x - expected.x)).toBeGreaterThan(50);
  });

  it('falls back to the renderer clock when the mirror has no frame time', () => {
    const mirror = mirrorWithMissile();
    expect(missilePoseNowMs(mirror, 10_120)).toBe(10_120);
    mirror.frameTimeMs = Number.NaN;
    expect(missilePoseNowMs(mirror, 10_120)).toBe(10_120);
    mirror.frameTimeMs = 9_000;
    expect(missilePoseNowMs(mirror, 10_120)).toBe(9_000);
  });
});

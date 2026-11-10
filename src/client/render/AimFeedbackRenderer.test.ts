/**
 * Showcase review 2026-11-10 (`pack-battle`, hud 'minimal'): pulsing red lock
 * diamonds on every drone locking the player and a spiky threat ring round the
 * player's ship. Below the full HUD the renderer calls `hide()` instead of
 * `update()` (`PixiRenderer.setHudOverlays`); nothing of the fire-control layer
 * may stay visible.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { AimFeedbackRenderer } from './AimFeedbackRenderer.js';
import type { RenderMirror } from '@core/contracts/IRenderer';

function mirrorWithThreat(): RenderMirror {
  const ships = new Map([
    ['me', { x: 0, y: 0, angle: 0, kind: 'interceptor' }],
  ]);
  const swarm = new Map([[7, { x: 300, y: 0, radius: 16 }]]);
  return {
    localPlayerId: 'me',
    ships,
    swarm,
    localLockedBy: [{ t: 's:7', s: 2, p: 100 }],
  } as unknown as RenderMirror;
}

describe('AimFeedbackRenderer.hide', () => {
  it('draws the threat marks in update() and clears them in hide()', () => {
    const parent = new Container();
    const r = new AimFeedbackRenderer(parent);
    r.update(mirrorWithThreat(), 1);
    expect(r.lastThreats).toBe(1);
    expect(parent.children.some((c) => c.visible)).toBe(true);

    r.hide();
    expect(r.lastThreats).toBe(0);
    expect(r.lastFcLocks).toBe(0);
    expect(parent.children.every((c) => !c.visible)).toBe(true);
  });
});

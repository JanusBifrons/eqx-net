/**
 * Smoke test 2026-11-21 (phone): locking a target drew a long thin line from
 * far off-screen to the start of the lock progress arc (and the threat arcs).
 * `moveTo(arc start)` + `arc()` left two identical points at the head of the
 * stroke polygon; Pixi's `buildLine` then emits NaN vertices, which a phone
 * GPU draws at the Graphics' local origin. Real Pixi Graphics, real
 * tessellation (the sibling AimFeedbackRenderer.test.ts mocks Pixi).
 */
import { describe, it, expect } from 'vitest';
import type { Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { AimFeedbackRenderer } from './AimFeedbackRenderer.js';
import { strokeVertices } from './strokeVertices.testutil';

const SX = 100, SY = 200;

function mirror(extra: Partial<RenderMirror>): RenderMirror {
  return {
    ships: new Map([
      ['me', { x: SX, y: SY, angle: 0, vx: 0, vy: 0, kind: 'fighter' }],
      ['npc', { x: SX + 400, y: SY, angle: 0, vx: 0, vy: 0, kind: 'fighter' }],
    ]),
    swarm: new Map(),
    localPlayerId: 'me',
    ...extra,
  } as unknown as RenderMirror;
}

function drawnVertices(m: RenderMirror): number[] {
  const r = new AimFeedbackRenderer({ addChild: () => undefined } as never);
  r.update(m, 1);
  return strokeVertices((r as unknown as { fc: Graphics }).fc);
}

describe('AimFeedbackRenderer arcs tessellate cleanly (no stray line to the origin)', () => {
  it.each([30, 62, 99])('own lock progress arc at %i%%: every vertex finite', (p) => {
    const v = drawnVertices(mirror({ localGroups: [{ id: 'fore', m: 0, l: [{ t: 'p:npc', s: 1, p }] }] } as Partial<RenderMirror>));
    expect(v.length).toBeGreaterThan(0);
    for (const n of v) expect(Number.isFinite(n)).toBe(true);
  });

  it.each([
    ['acquiring', 1],
    ['locked', 2],
  ])('threat arc while a ship is %s you: every vertex finite', (_l, s) => {
    const v = drawnVertices(mirror({ localLockedBy: [{ t: 'p:npc', s, p: 40 }] }));
    expect(v.length).toBeGreaterThan(0);
    for (const n of v) expect(Number.isFinite(n)).toBe(true);
  });
});

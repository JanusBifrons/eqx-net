/**
 * Regression lock — `resolveWarpFilterCenter` coordinate frame +
 * live entity-tracking.
 *
 * BUG 1 (2026-05-15, "off screen to the bottom right" on spawn): a
 * `{kind:'world'}` anchor carries GAME-space (Y-up) coords; the Pixi
 * `world` is Y-down (`sprite.y = -ship.y`). Projecting without negating
 * Y put the ripple at the ship's vertical mirror. Fix: world branch
 * negates Y. (Superseded theory: a `× renderer.resolution` multiply —
 * disproved on-device; the sandbox screen-centre warp was pixel-exact
 * on a DPR-3 phone with no scaling. Do not re-add it.)
 *
 * BUG 2 (2026-05-15 follow-up, "did the effect at the point when I
 * started charging instead of where I actually was"): App.tsx captured
 * the ship pose ONCE at spool-start and passed a frozen `world` point.
 * The ship keeps flying through the ~3.6s spool — diagnostic
 * `2026-05-15T22-08-40-272Z-s3b9l8` shows it moving ~539u (from
 * (2974,1779) at spool-start to (3460,2013) at curtain) while the
 * ripple stayed frozen. Fix: a `{kind:'entity', entityId}` anchor the
 * renderer re-resolves to that ship's LIVE sprite global position
 * EVERY frame.
 *
 * BUG 2b (user's architectural point: "isn't this a symptom fix —
 * what if a remote or bot ship is warping?"): the first cut special-
 * cased the local ship. The anchor is entity-id based and id-agnostic
 * — local, remote and bot ids resolve through the exact same path, so
 * there is no local special-case. The renderer's per-frame
 * `sprites.get(entityId)` covers every rendered ship.
 *
 * WHY THIS LEVEL: the anchor→centre resolve is pure (no worker seam;
 * `world.toGlobal` + the live entity global are injected). Per
 * Invariant #13 the pure helper is where these live — the
 * `spriteUpdateDecisions`/`shouldDetachWarpVisual` pattern. The
 * `entity` cases fail against the pre-fix helper (no such kind);
 * reverting any branch re-fails its cases.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveWarpFilterCenter } from './PixiRenderer.js';

const NO_PROJECT = (): { x: number; y: number } => ({ x: -1, y: -1 });

describe('resolveWarpFilterCenter', () => {
  // ---- BUG 2: entity live-tracking ----

  it('entity resolves to the LIVE sprite global pos (re-resolved per frame, not frozen)', () => {
    // Frame A: ship at screen (400,300). Frame B (later in the SAME
    // spool, same warpCenter object): ship flew to (612,418). The
    // result MUST follow the live value — proving per-frame resolve.
    const anchor = { kind: 'entity' as const, entityId: 'p1' };
    const a = resolveWarpFilterCenter({
      warpCenter: anchor,
      projectWorld: NO_PROJECT,
      entityGlobal: { x: 400, y: 300 },
      screenW: 800,
      screenH: 600,
    });
    const b = resolveWarpFilterCenter({
      warpCenter: anchor,
      projectWorld: NO_PROJECT,
      entityGlobal: { x: 612, y: 418 },
      screenW: 800,
      screenH: 600,
    });
    expect(a).toEqual({ x: 400, y: 300 });
    expect(b).toEqual({ x: 612, y: 418 });
  });

  it('entity is id-agnostic — a REMOTE/bot ship id resolves identically (no local special-case)', () => {
    // The helper never inspects the id; the renderer pre-resolves
    // ANY ship's sprite into entityGlobal. This is the lock on the
    // user's "what if a remote or bot ship is warping?" point.
    const remote = resolveWarpFilterCenter({
      warpCenter: { kind: 'entity', entityId: 'remote-player-42' },
      projectWorld: NO_PROJECT,
      entityGlobal: { x: 720, y: 110 },
      screenW: 800,
      screenH: 600,
    });
    expect(remote).toEqual({ x: 720, y: 110 });
  });

  it('entity falls back to screen centre when the ship has no live sprite', () => {
    // Despawned mid-warp / not spawned yet — the effect must still
    // render, centred, never vanish.
    const c = resolveWarpFilterCenter({
      warpCenter: { kind: 'entity', entityId: 'gone' },
      projectWorld: NO_PROJECT,
      entityGlobal: null,
      screenW: 800,
      screenH: 600,
    });
    expect(c).toEqual({ x: 400, y: 300 });
  });

  it('entity does NOT call projectWorld (live sprite is already Pixi-placed)', () => {
    const projectWorld = vi.fn(NO_PROJECT);
    resolveWarpFilterCenter({
      warpCenter: { kind: 'entity', entityId: 'p1' },
      projectWorld,
      entityGlobal: { x: 10, y: 20 },
      screenW: 800,
      screenH: 600,
    });
    expect(projectWorld).not.toHaveBeenCalled();
  });

  // ---- BUG 1: world-anchor game→Pixi Y flip (remote warp-out, ship gone) ----

  it('world anchor negates game-space Y before projecting', () => {
    const projectWorld = vi.fn((px: number, py: number) => {
      if (px === 1500 && py === -2500) return { x: 400, y: 300 };
      return { x: 400, y: 5300 };
    });
    const c = resolveWarpFilterCenter({
      warpCenter: { kind: 'world', worldX: 1500, worldY: 2500 },
      projectWorld,
      entityGlobal: null,
      screenW: 800,
      screenH: 600,
    });
    expect(projectWorld).toHaveBeenCalledWith(1500, -2500);
    expect(c).toEqual({ x: 400, y: 300 });
  });

  it('world anchor: negative game Y flips to positive Pixi Y', () => {
    const projectWorld = vi.fn((px: number, py: number) => ({ x: px, y: py }));
    resolveWarpFilterCenter({
      warpCenter: { kind: 'world', worldX: 10, worldY: -3200 },
      projectWorld,
      entityGlobal: null,
      screenW: 800,
      screenH: 600,
    });
    expect(projectWorld).toHaveBeenCalledWith(10, 3200);
  });

  // ---- screen / null pass-through (NO resolution scale) ----

  it('screen anchor (sandbox click) passes through raw', () => {
    const c = resolveWarpFilterCenter({
      warpCenter: { kind: 'screen', screenX: 123, screenY: 456 },
      projectWorld: NO_PROJECT,
      entityGlobal: null,
      screenW: 800,
      screenH: 600,
    });
    expect(c).toEqual({ x: 123, y: 456 });
  });

  it('null anchor → screen centre, NOT × resolution', () => {
    const c = resolveWarpFilterCenter({
      warpCenter: null,
      projectWorld: NO_PROJECT,
      entityGlobal: { x: 999, y: 999 },
      screenW: 800,
      screenH: 600,
    });
    expect(c).toEqual({ x: 400, y: 300 });
  });
});

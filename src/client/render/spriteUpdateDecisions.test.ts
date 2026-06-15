/**
 * Unit tests for the pure renderer-decision module.
 *
 * Regression locks for the Phase 6b "lingering hull invisible" bug
 * class. The previous bug was a too-aggressive `if (!ship.kind)
 * continue;` skip in the renderer that left the sprite uncreated
 * forever when the schema diff with `kind` landed late. These tests
 * lock the contract that "no cache + unknown kind" must produce a
 * `create` action with the fallback kind, NOT a `skip`.
 *
 * Property test (fast-check): for arbitrary `cached` / `currentKind`
 * pairs, the decision is deterministic and the chosen kind (when
 * present) is non-empty.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  decideLingeringSpriteAction,
  type SpriteCacheEntry,
} from './spriteUpdateDecisions.js';

describe('decideLingeringSpriteAction', () => {
  const fallback = 'fighter';

  it('no cache + known kind → create with current kind', () => {
    const d = decideLingeringSpriteAction({
      cached: undefined,
      currentKind: 'interceptor',
      fallbackKind: fallback,
    });
    expect(d).toEqual({ action: 'create', kind: 'interceptor' });
  });

  it('REGRESSION: no cache + unknown kind → create with FALLBACK (NOT skip)', () => {
    // The bug we just shipped from: previous renderer code skipped
    // when kind was unknown, leaving the sprite uncreated forever
    // and the lingering hull permanently invisible. The fallback is
    // the load-bearing fix.
    const d = decideLingeringSpriteAction({
      cached: undefined,
      currentKind: undefined,
      fallbackKind: fallback,
    });
    expect(d).toEqual({ action: 'create', kind: fallback });
  });

  it('cache hit + same kind → reposition (no rebuild)', () => {
    const cached: SpriteCacheEntry = { kind: 'interceptor' };
    const d = decideLingeringSpriteAction({
      cached,
      currentKind: 'interceptor',
      fallbackKind: fallback,
    });
    expect(d).toEqual({ action: 'reposition' });
  });

  it('cache hit + different known kind → rebuild', () => {
    // The Phase 6b "interceptor renders as fighter" scenario: the
    // schema diff with the real kind landed after the initial sprite
    // was built with the fallback. Rebuild is the right action.
    const cached: SpriteCacheEntry = { kind: 'fighter' };
    const d = decideLingeringSpriteAction({
      cached,
      currentKind: 'interceptor',
      fallbackKind: fallback,
    });
    expect(d).toEqual({ action: 'rebuild', kind: 'interceptor' });
  });

  it('cache hit + unknown current kind → reposition (do NOT rebuild on transient diff drop)', () => {
    // If the schema diff happens not to carry kind on this update
    // (defensive scenario — Colyseus schema 3.x always sends full
    // state, but be belt-and-braces), keep the previously-known
    // sprite. Don't tear it down.
    const cached: SpriteCacheEntry = { kind: 'scout' };
    const d = decideLingeringSpriteAction({
      cached,
      currentKind: undefined,
      fallbackKind: fallback,
    });
    expect(d).toEqual({ action: 'reposition' });
  });
});

describe('decideLingeringSpriteAction — property tests', () => {
  it('always returns one of the four action variants', () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom('fighter', 'interceptor', 'scout', 'heavy'), { nil: undefined }),
        fc.option(fc.constantFrom('fighter', 'interceptor', 'scout', 'heavy'), { nil: undefined }),
        fc.constantFrom('fighter', 'scout'),
        (cachedKind, currentKind, fallback) => {
          const cached = cachedKind ? { kind: cachedKind } : undefined;
          const d = decideLingeringSpriteAction({ cached, currentKind, fallbackKind: fallback });
          return ['create', 'rebuild', 'reposition', 'skip'].includes(d.action);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('every create / rebuild decision produces a non-empty kind', () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom('fighter', 'interceptor', 'scout', 'heavy'), { nil: undefined }),
        fc.option(fc.constantFrom('fighter', 'interceptor', 'scout', 'heavy'), { nil: undefined }),
        fc.constantFrom('fighter', 'scout'),
        (cachedKind, currentKind, fallback) => {
          const cached = cachedKind ? { kind: cachedKind } : undefined;
          const d = decideLingeringSpriteAction({ cached, currentKind, fallbackKind: fallback });
          if (d.action === 'create' || d.action === 'rebuild') {
            return typeof d.kind === 'string' && d.kind.length > 0;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('cache + same kind ⇒ reposition (deterministic)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('fighter', 'interceptor', 'scout', 'heavy'),
        (kind) => {
          const d = decideLingeringSpriteAction({
            cached: { kind },
            currentKind: kind,
            fallbackKind: 'fighter',
          });
          return d.action === 'reposition';
        },
      ),
      { numRuns: 50 },
    );
  });
});

/**
 * 2026-05-13 user report: when a lingering hull was destroyed, the
 * explosion VFX spawned at (0,0) instead of the hull's actual
 * position. Root cause: the renderer's explosion handler only checked
 * the `sprites` map (active ships, keyed by playerId), but lingering
 * hulls live in `lingeringSprites` (keyed by shipInstanceId).
 * Lookup miss → defaulted to (0,0) silently.
 *
 * The `decideExplosionPosition` helper consolidates the lookup across
 * both sprite maps so the explosion fires at the visible
 * silhouette's position. Per Invariant #13, the failing test below
 * went in BEFORE the fix in `PixiRenderer.ts`.
 */
import { decideExplosionPosition } from './spriteUpdateDecisions.js';

describe('decideExplosionPosition', () => {
  const empty = new Map<string, { x: number; y: number }>();

  it('returns the active ship\'s pose when the target is a playerId', () => {
    const pos = decideExplosionPosition({
      targetId: 'player-1',
      activeShipsByPlayerId: new Map([['player-1', { x: 100, y: 200 }]]),
      lingeringShipsByShipInstanceId: empty,
    });
    expect(pos).toEqual({ x: 100, y: 200 });
  });

  it('falls back to the lingering-hull pose when the target is a shipInstanceId in the lingering map', () => {
    // The 2026-05-13 bug — this used to return (0,0). Now must return
    // the lingering hull's real pose.
    const pos = decideExplosionPosition({
      targetId: 'ship-instance-A',
      activeShipsByPlayerId: empty,
      lingeringShipsByShipInstanceId: new Map([['ship-instance-A', { x: 50, y: -75 }]]),
    });
    expect(pos).toEqual({ x: 50, y: -75 });
  });

  it('returns null when the target is in no map (caller can decide on fallback)', () => {
    const pos = decideExplosionPosition({
      targetId: 'unknown-id',
      activeShipsByPlayerId: empty,
      lingeringShipsByShipInstanceId: empty,
    });
    expect(pos).toBeNull();
  });

  it('prefers active ships when the same id appears in multiple maps (collision safety)', () => {
    // Defence-in-depth: shipInstanceId and playerId namespaces are
    // distinct in practice, but if they ever collide we want active
    // to win because that's the still-piloted hull.
    const pos = decideExplosionPosition({
      targetId: 'X',
      activeShipsByPlayerId: new Map([['X', { x: 1, y: 1 }]]),
      lingeringShipsByShipInstanceId: new Map([['X', { x: 2, y: 2 }]]),
    });
    expect(pos).toEqual({ x: 1, y: 1 });
  });
});

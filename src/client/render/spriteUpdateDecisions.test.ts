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
  decideWreckSpriteAction,
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

describe('decideWreckSpriteAction', () => {
  it('no cache + known kind → create', () => {
    const d = decideWreckSpriteAction({ cached: undefined, currentKind: 'heavy' });
    expect(d).toEqual({ action: 'create', kind: 'heavy' });
  });

  it('cache hit + same kind → reposition', () => {
    const cached: SpriteCacheEntry = { kind: 'heavy' };
    const d = decideWreckSpriteAction({ cached, currentKind: 'heavy' });
    expect(d).toEqual({ action: 'reposition' });
  });

  it('cache hit + different kind → rebuild', () => {
    const cached: SpriteCacheEntry = { kind: 'fighter' };
    const d = decideWreckSpriteAction({ cached, currentKind: 'heavy' });
    expect(d).toEqual({ action: 'rebuild', kind: 'heavy' });
  });

  it('wreck-kind-missing: emit a skip with a reason (server-side wire-format break diagnostic)', () => {
    // Wrecks always carry kind in the schema. If we observe an undefined
    // kind here, it's a server wire-format break, not a normal scenario.
    // Surface it as a `skip` with a reason so the bug is observable in
    // logs.
    const d = decideWreckSpriteAction({ cached: undefined, currentKind: undefined });
    expect(d.action).toBe('skip');
    if (d.action === 'skip') {
      expect(d.reason).toContain('wreck-kind-missing');
    }
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

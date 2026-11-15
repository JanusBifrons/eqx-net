/**
 * Unit tests for the pure renderer-decision module.
 *
 * Regression locks for the Phase 6b "parked hull invisible" bug class. The
 * previous bug was a too-aggressive `if (!ship.kind) continue;` skip in the
 * renderer that left the sprite uncreated forever when the schema diff with
 * `kind` landed late. These tests lock the contract that "no sprite + unknown
 * kind" must `create` with the fallback kind, NOT skip. Since RTS Part A S3
 * the decision is the ONE ship-sprite decision (`decideShipSpriteAction`) for
 * every ship, parked hulls included.
 *
 * Property test (fast-check): for arbitrary cached / current kinds, the
 * decision is deterministic and the drawn kind is never empty.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  decideArtSwap,
  decideExplosionPosition,
  decideShipSpriteAction,
  isSpriteInView,
  shipSpriteKind,
} from './spriteUpdateDecisions.js';

describe('decideShipSpriteAction', () => {
  it('REGRESSION: no sprite + unknown kind → create, drawn with the FALLBACK (NOT skip)', () => {
    expect(decideShipSpriteAction(undefined, undefined)).toBe('create');
    expect(shipSpriteKind(undefined, undefined, 'fighter')).toBe('fighter');
  });

  it('no sprite + known kind → create with the current kind', () => {
    expect(decideShipSpriteAction(undefined, 'heavy')).toBe('create');
    expect(shipSpriteKind(undefined, 'heavy', 'fighter')).toBe('heavy');
  });

  it('sprite + same kind → reposition (no rebuild)', () => {
    expect(decideShipSpriteAction('heavy', 'heavy')).toBe('reposition');
  });

  it('sprite + a different known kind → rebuild for the new silhouette', () => {
    expect(decideShipSpriteAction('fighter', 'heavy')).toBe('rebuild');
    expect(shipSpriteKind('fighter', 'heavy', 'fighter')).toBe('heavy');
  });

  it('sprite + unknown current kind → reposition, keeping the cached kind (no rebuild on a transient drop)', () => {
    expect(decideShipSpriteAction('heavy', undefined)).toBe('reposition');
    expect(shipSpriteKind('heavy', undefined, 'fighter')).toBe('heavy');
  });
});

describe('decideShipSpriteAction — property tests', () => {
  const kindArb = fc.option(fc.constantFrom('fighter', 'heavy', 'scout', 'interceptor'), { nil: undefined });

  it('always returns one of the three actions, deterministically', () => {
    fc.assert(fc.property(kindArb, kindArb, (cached, current) => {
      const a = decideShipSpriteAction(cached, current);
      expect(['create', 'rebuild', 'reposition']).toContain(a);
      expect(decideShipSpriteAction(cached, current)).toBe(a);
    }));
  });

  it('the drawn kind is never empty', () => {
    fc.assert(fc.property(kindArb, kindArb, (cached, current) => {
      expect(shipSpriteKind(cached, current, 'fighter').length).toBeGreaterThan(0);
    }));
  });

  it('same kind ⇒ reposition', () => {
    fc.assert(fc.property(fc.constantFrom('fighter', 'heavy'), (k) => {
      expect(decideShipSpriteAction(k, k)).toBe('reposition');
    }));
  });
});

/**
 * 2026-05-13 user report: when a parked hull was destroyed, the explosion VFX
 * spawned at (0,0) instead of the hull's position: the lookup checked only the
 * active ships' sprite map, while parked hulls had their own. Since RTS Part
 * A S3 every ship's sprite is in ONE map (parked hulls by shipInstanceId), and
 * the dying ship's mirror entry is already gone, so the pose is its sprite's.
 */
describe('decideExplosionPosition', () => {
  const sprites = new Map([
    ['player-1', { x: 100, y: 200 }],
    ['ship-instance-A', { x: 50, y: -75 }],
  ]);

  it('returns a pilot ship\'s sprite pose (playerId key)', () => {
    expect(decideExplosionPosition({ targetId: 'player-1', shipSprites: sprites })).toEqual({ x: 100, y: 200 });
  });

  it('returns a parked hull\'s sprite pose (shipInstanceId key) — never (0,0)', () => {
    expect(decideExplosionPosition({ targetId: 'ship-instance-A', shipSprites: sprites })).toEqual({ x: 50, y: -75 });
  });

  it('returns null when no sprite is mapped (caller skips the VFX)', () => {
    expect(decideExplosionPosition({ targetId: 'unknown-id', shipSprites: sprites })).toBeNull();
  });
});

describe('isSpriteInView (A3 structure culling)', () => {
  const view = new Float64Array([-100, -100, 100, 100]);
  it('draws a structure whose box reaches into the view, culls one fully outside', () => {
    expect(isSpriteInView(0, 0, 10, view)).toBe(true);
    expect(isSpriteInView(150, 0, 60, view)).toBe(true); // edge pokes in
    expect(isSpriteInView(250, 0, 60, view)).toBe(false);
    expect(isSpriteInView(0, -300, 100, view)).toBe(false);
  });
  it('no bounds ⇒ always drawn', () => {
    expect(isSpriteInView(1e6, 1e6, 1, undefined)).toBe(true);
  });
});

describe('decideArtSwap (Machined art, A3)', () => {
  it('follows the truth table', () => {
    // Art off: today's look; an old Machined sprite is put back to it.
    expect(decideArtSwap(false, null, false)).toBe('keep');
    expect(decideArtSwap(false, null, true)).toBe('toClassic');
    // Pending: keep whatever is shown.
    expect(decideArtSwap(true, 'pending', false)).toBe('keep');
    // Ready: the Machined sprite for THIS handle.
    expect(decideArtSwap(true, 'ready', false)).toBe('toMachined');
    expect(decideArtSwap(true, 'ready', true)).toBe('keep');
    // Failed: today's look.
    expect(decideArtSwap(true, 'failed', false)).toBe('keep');
  });

  it('never asks to rebuild a sprite that already shows ready art', () => {
    fc.assert(fc.property(fc.boolean(), (on) => decideArtSwap(on, 'ready', true) !== 'toMachined'));
  });

  it('applying the swap reaches a fixed point (no rebuild loop)', () => {
    const states = ['pending', 'ready', 'failed', null] as const;
    fc.assert(fc.property(fc.boolean(), fc.constantFrom(...states), fc.boolean(), (on, st, shows) => {
      const first = decideArtSwap(on, st, shows);
      const after = first === 'toMachined' ? true : first === 'toClassic' ? false : shows;
      return decideArtSwap(on, st, after) === 'keep';
    }));
  });
});

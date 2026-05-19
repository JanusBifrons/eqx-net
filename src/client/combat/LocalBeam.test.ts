/**
 * Regression lock — the local-player hitscan beam visual decision.
 *
 * THE BUG (diagnostic capture `2026-05-19T10-55-36-274Z-pe6rdt`,
 * on-device, reported "laser beams visually disconnect from the ship the
 * moment there's a small amount of lag", triggered after a respawn):
 *
 *   While fire is held, the renderer drew the local hitscan beam as TWO
 *   stacked layers:
 *     1. a true continuous beam recomputed from the ship's RENDERED pose
 *        (`mirror.ships`) every frame → correctly ship-attached;
 *     2. a chain of short-lived "ghost" segments, one spawned every
 *        ~cooldown while held, each FROZEN at the `predWorld` pose sampled
 *        inside `sendFire` at input-tick time.
 *
 *   The capture's `fire` events show `predState` ≠ `mirrorPose` on EVERY
 *   shot (~5 u even at `lerpOffset 0`, because the two are sampled at
 *   different points in the frame), widening to the full reconcile
 *   correction magnitude (157 u on the post-respawn snapshot, ts 74819)
 *   under lag. Layer 2 therefore visibly detaches from the ship while
 *   layer 1 stays glued — the "smearing / disconnecting" the player saw.
 *
 * THE FIX, locked here: a local-player HITSCAN fire spawns NO ghost — the
 * continuous `mirror.ships`-derived beam is the sole local hitscan visual
 * (client-drawn, recomputed from the rendered ship every frame, so server
 * lag/correction is invisible). It is persisted for a short window after
 * the last fire tick so a tap / held burst reads as one continuous
 * attached beam instead of a 1-tick flicker. PROJECTILE fires still spawn
 * a ghost — the bolt actually travels, so the moving ghost IS the visual.
 *
 * Pure helpers, exhaustively tested (mirrors the `shouldDetachWarpVisual`
 * precedent: the side-effecting `sendFire` / renderer defer to these).
 */
import { describe, it, expect } from 'vitest';
import { getWeapon } from '@core/combat/WeaponCatalogue';
import {
  localFireSpawnsGhost,
  liveBeamVisible,
  LIVE_BEAM_PERSIST_MS,
} from './LocalBeam.js';

describe('localFireSpawnsGhost', () => {
  it('hitscan → NO ghost (the continuous ship-attached beam is the only local hitscan visual)', () => {
    expect(localFireSpawnsGhost('hitscan')).toBe(false);
  });

  it('projectile → ghost (the bolt travels; the moving ghost IS the visual)', () => {
    expect(localFireSpawnsGhost('projectile')).toBe(true);
  });
});

describe('liveBeamVisible — the post-fire persistence window', () => {
  it('not visible before any fire (lastFireMs === null)', () => {
    expect(liveBeamVisible(1000, null, LIVE_BEAM_PERSIST_MS)).toBe(false);
  });

  it('visible on the fire frame itself', () => {
    expect(liveBeamVisible(1000, 1000, LIVE_BEAM_PERSIST_MS)).toBe(true);
  });

  it('visible right up to and including the persist boundary', () => {
    expect(liveBeamVisible(1000 + LIVE_BEAM_PERSIST_MS, 1000, LIVE_BEAM_PERSIST_MS)).toBe(true);
  });

  it('hidden once the persist window has fully elapsed', () => {
    expect(liveBeamVisible(1000 + LIVE_BEAM_PERSIST_MS + 1, 1000, LIVE_BEAM_PERSIST_MS)).toBe(false);
  });

  it('stays visible across a normal hold (sampled mid-window)', () => {
    expect(liveBeamVisible(1100, 1000, LIVE_BEAM_PERSIST_MS)).toBe(true);
  });
});

describe('LIVE_BEAM_PERSIST_MS bridges consecutive held shots (no beam blink)', () => {
  // While fire is held the client re-fires every `cooldownTicks`. If the
  // persistence window were shorter than that interval, the continuous
  // beam would blink off between shots — the exact flicker the ghost
  // layer used to paper over. Tie the constant to the catalogue so a
  // future cooldown change that would reintroduce the blink fails here.
  it('is at least the hitscan inter-shot interval', () => {
    const cooldownMs = (getWeapon('hitscan').cooldownTicks / 60) * 1000;
    expect(LIVE_BEAM_PERSIST_MS).toBeGreaterThanOrEqual(cooldownMs);
  });

  it('is a sane positive bound (not an accidental huge lingering beam)', () => {
    expect(LIVE_BEAM_PERSIST_MS).toBeGreaterThan(0);
    expect(LIVE_BEAM_PERSIST_MS).toBeLessThanOrEqual(400);
  });
});

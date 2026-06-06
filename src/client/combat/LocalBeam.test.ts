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
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation.js';
import type { SwarmRenderState, PoseRingEntry } from '@core/contracts/IRenderer';
import { POSE_RING_DEPTH } from '@core/contracts/IRenderer';
import {
  localFireSpawnsGhost,
  liveBeamVisible,
  LIVE_BEAM_PERSIST_MS,
  buildLocalAimTargets,
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
    // Sample at +half of the persistence window — confirms the beam is
    // still drawn between the last fire tick and the next one. Pre-
    // smooth-beam retune this was `+100ms` against a 220 ms window;
    // post-retune the window is 80 ms, so we sample at +40 ms.
    const midSample = Math.floor(LIVE_BEAM_PERSIST_MS / 2);
    expect(liveBeamVisible(1000 + midSample, 1000, LIVE_BEAM_PERSIST_MS)).toBe(true);
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

/**
 * THE bug (on-device, capture `2026-05-19T11-22-22-628Z-uf0o8g`, user:
 * "when it autoaims at the enemy bot it aims AHEAD of it, almost at its
 * dead-reckoning target, instead of where it is being DRAWN"):
 *
 *   `tickLocalMountAim` built its turret targets from the raw swarm
 *   mirror entry `{ x: sw.x, y: sw.y }`. `decodeSwarmPacket` writes the
 *   AUTHORITATIVE decoded pose into `sw.x/sw.y` on every binary packet
 *   (~20 Hz); `updateMirror` only overwrites it with the ~100 ms
 *   display-delayed `interpolateSwarmPose` result LATER in the frame.
 *   `tickLocalMountAim` runs in `tickPhysics` and frequently read the
 *   freshly-decoded AUTHORITATIVE pose — so the turret aimed at where
 *   the drone *is* (network-truth / dead-reckoned ahead) while the
 *   sprite is drawn ~100 ms behind. The "aims ahead" the player saw.
 *   (The 2941-2944 "we use the post-interpolation rendered pose" comment
 *   was false-by-ordering — the "comment promises X, the data is Y"
 *   defect class src/client/CLAUDE.md flags.)
 *
 * THE FIX (updated 2026-05-19, drone/laser-jitter fix — same goal, the
 * mechanism `0e24448` anticipated): `buildLocalAimTargets` reads the
 * SINGLE per-frame display pose `ColyseusClient.updateMirror` already
 * resolved into `entry.x/y/angle` (one `interpolateSwarmPose` per
 * frame; the same value the sprite + predWorld collision body + laser
 * beam read), via `resolveEntityDisplayPose`. It no longer interpolates
 * itself. `0e24448` had it re-interpolate here — correct in direction
 * (aim the drawn pose, not the raw/ahead one) but it added a THIRD
 * divergent-`now` resolution site (aim @ tickPhysics-now ≠ updateMirror
 * @ now ≠ sprite @ render-now), so the turret aimed at one pose while
 * the sprite was drawn at another → "two things fighting", the laser
 * jittering against the drone (on-device, capture `…-jfagww`). Reading
 * the one written pose makes aim == draw == collide TRUE (≤1-frame
 * smooth lead-lag, never per-frame jitter) AND keeps the
 * aim-the-drawn-not-the-ahead guarantee — `updateMirror` wrote the
 * display-delayed interpolated pose into `entry.x/y`, so that is what
 * is read. The canary `tests/unit/swarmPoseConsistency.test.ts` locks
 * the one-resolution-per-frame invariant directly.
 */
function emptyRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = new Array(POSE_RING_DEPTH);
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring[i] = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true };
  }
  return ring;
}

function movingDrone(arrivals: Array<{ x: number; y: number; arrivalMs: number }>): SwarmRenderState {
  const ring = emptyRing();
  arrivals.forEach((a, i) => {
    const slot = ring[i % POSE_RING_DEPTH]!;
    slot.x = a.x;
    slot.y = a.y;
    slot.angle = 0;
    slot.vx = 0;
    slot.vy = 0;
    slot.angvel = 0;
    slot.arrivalMs = a.arrivalMs;
    slot.serverTick = i;
    slot.empty = false;
  });
  const newest = arrivals[arrivals.length - 1]!;
  return {
    // entry.x/y == the latest AUTHORITATIVE decoded pose (decoder-written).
    x: newest.x, y: newest.y, vx: 0, vy: 0, angle: 0,
    prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: newest.arrivalMs,
    poseRing: ring,
    ringHead: arrivals.length % POSE_RING_DEPTH,
    radius: 16, kind: 1, sleeping: false, lastUpdateTick: 0,
  };
}

describe('buildLocalAimTargets — turret aims where the drone is DRAWN, not its authoritative/ahead pose', () => {
  it('returns the SINGLE per-frame pose updateMirror wrote (display-delayed, behind the raw/ahead sample) — no re-interpolation', () => {
    // Drone travelled (0,0) → (2000,0) over 1 s = 2000 u/s — fast but
    // below TELEPORT_MAX_PLAUSIBLE_SPEED (2500), so interpolateSwarmPose
    // genuinely lerps (no teleport snap). entry.x/y starts at the newest
    // AUTHORITATIVE pose (2000,0) — what the decoder writes.
    const drone = movingDrone([
      { x: 0, y: 0, arrivalMs: 0 },
      { x: 2000, y: 0, arrivalMs: 1000 },
    ]);
    const swarm = new Map<number, SwarmRenderState>([[7, drone]]);
    const now = 1000;

    // Simulate ColyseusClient.updateMirror (lines 2481-2484): the ONE
    // per-frame interpolation, written into entry.x/y/angle — the value
    // the sprite + predWorld collision body + laser beam also read.
    const resolved: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    interpolateSwarmPose(drone, now, resolved);
    drone.x = resolved.x; drone.y = resolved.y; drone.angle = resolved.angle;

    const scratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    const targets = buildLocalAimTargets(swarm, scratch);

    expect(targets).toHaveLength(1);
    const t = targets[0]!;
    expect(t.id).toBe('swarm-7');

    // Reads exactly the written per-frame pose (aim == draw == collide).
    expect(t.x).toBeCloseTo(drone.x, 6);
    expect(t.y).toBeCloseTo(drone.y, 6);
    // 0e24448's guarantee preserved: that pose is the display-delayed
    // one, meaningfully BEHIND the raw/ahead authoritative sample (the
    // original bug was aiming at the raw 2000 lead).
    expect(t.x).toBeLessThan(2000 - 100);
  });

  it('excludes asteroids (kind !== 1) — they are not turret targets', () => {
    const drone = movingDrone([{ x: 10, y: 20, arrivalMs: 0 }]);
    const asteroid = movingDrone([{ x: 1, y: 2, arrivalMs: 0 }]);
    asteroid.kind = 0;
    const swarm = new Map<number, SwarmRenderState>([
      [1, drone],
      [2, asteroid],
    ]);
    const scratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    const targets = buildLocalAimTargets(swarm, scratch);
    expect(targets.map((t) => t.id)).toEqual(['swarm-1']);
  });

  it('an empty / absent swarm yields no targets (turret slews back to forward)', () => {
    const scratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    expect(buildLocalAimTargets(new Map(), scratch)).toEqual([]);
  });

  it('carries hostility + health for Part C aim weighting', () => {
    const wounded = movingDrone([{ x: 10, y: 0, arrivalMs: 0 }]);
    wounded.isHostileToLocal = true;
    wounded.healthFrac = 0.2;
    const fresh = movingDrone([{ x: 20, y: 0, arrivalMs: 0 }]);
    // isHostileToLocal + healthFrac left undefined → defaults (neutral, full).
    const swarm = new Map<number, SwarmRenderState>([[1, wounded], [2, fresh]]);
    const scratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    const [w, f] = buildLocalAimTargets(swarm, scratch);
    expect(w!.hostile).toBe(true);
    expect(w!.health).toBeCloseTo(0.2, 6);
    expect(w!.maxHealth).toBe(1);
    // Defaults: not hostile, full health (absent hp ⇒ 1).
    expect(f!.hostile).toBe(false);
    expect(f!.health).toBe(1);
  });
});

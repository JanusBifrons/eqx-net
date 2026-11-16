/**
 * Regression lock — an AI capital's heavy beam aimed at a viewer who cannot
 * see its turret angles must still be drawn at the target.
 *
 * Showcase report (2026-11-15, beam-slice-subcap): an AI `battlecruiser-lance`
 * killed the local player's missile frigate with heavy beams at 8 km and
 * 18.5 km; the server logged the slice kill and the damage numbers showed,
 * but no beam was ever on screen. From a heavy cruiser at 8 km the same beam
 * drew fine.
 *
 * Cause: per-mount turret angles ride `snapshot.drones[].mountAngles` only for
 * drones in the viewer's interest window, and that window scales with the
 * viewer's hull (`SpatialGrid.viewerReach`): a frigate's reaches 1 cell, a
 * heavy cruiser's 2, and the battlecruiser's own reach is 2, so at 8 km
 * (~4 cells) it is out of a frigate's window and in a heavy cruiser's. Out of
 * interest the capital still has a coarse 10 Hz pose in `mirror.swarm`, so
 * the renderer took the swarm-shooter branch with the turret angle defaulted
 * to 0: the beam left along the mount's BASE angle (bow / stern), 8+ km off
 * at the wrong bearing, never crossing the frigate's screen.
 *
 * Fix: with no turret angle known for the shooter, the beam is aimed from the
 * live barrel origin at the wire end point the server sent (`laser_fired.to`).
 */
import { describe, it, expect } from 'vitest';
import { findMount, remoteBeamFireAngle, remoteBeamLine } from './beamStyles.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

/** Game-space forward of a fire angle (the renderer's convention). */
function fwd(a: number): { x: number; y: number } {
  return { x: -Math.sin(a), y: Math.cos(a) };
}

describe('remote beam aim (heavy beam, out-of-interest capital)', () => {
  const mount = findMount(getShipKind('battlecruiser-lance').mounts, 'main-1')!;

  it('the lance main battery is a heavy beam on a turning turret', () => {
    expect(mount.weaponId).toBe('heavy_beam');
  });

  it('with no turret angle known, the beam points at the wire end point (the frigate 8 km away)', () => {
    // Battlecruiser at the origin, hull turned to face -x (angle pi/2); the
    // frigate it burns sits 8 km off along +y — 90 degrees off the bow.
    const a = remoteBeamFireAngle(Math.PI / 2, mount.baseAngle ?? 0, undefined, 0, 0, 0, 8000);
    const f = fwd(a);
    // The beam end, 8 km out, lands inside the frigate's 48 u hull.
    expect(Math.hypot(f.x * 8000 - 0, f.y * 8000 - 8000)).toBeLessThan(48);
  });

  it('with no turret angle known, a stern turret still aims at the wire end point', () => {
    const stern = findMount(getShipKind('battlecruiser-lance').mounts, 'main-3')!;
    const a = remoteBeamFireAngle(0, stern.baseAngle ?? 0, undefined, 100, -50, 5000, 18_500);
    const f = fwd(a);
    const len = Math.hypot(5000 - 100, 18_500 + 50);
    expect(Math.hypot(100 + f.x * len - 5000, -50 + f.y * len - 18_500)).toBeLessThan(48);
  });

  it('with the turret angle known (in interest), the beam follows the drawn barrel', () => {
    const a = remoteBeamFireAngle(0.3, 0, 0.5, 0, 0, 0, 8000);
    expect(a).toBeCloseTo(0.8, 9);
  });
});

/**
 * Regression lock — a heavy-beam pulse follows the LIVE barrel and stops
 * where the client ray stops (owner's model: "the laser beam should just
 * extend from the tip of the barrel the full length that it should fire,
 * unless it intercepts with something").
 *
 * Film review (2026-11-16, PR #698 "still jumps"): a remote heavy beam fires
 * a pulse every 10 ticks and each pulse was drawn FROZEN on the line it was
 * fired along (muzzle to `laser_fired.to`) for its 450 ms life. While the
 * turret was still turning, pulse 1 sat on one line and pulse 2 on another:
 * the beam jumped ~50 px between them.
 *
 * Fix: `ColyseusClient` ray-traces each styled remote pulse every frame down
 * the live barrel (`combat/remoteBeamRay.ts`, the local beam's own hitscan)
 * and writes the stop distance onto the entry (`dist`); the pulse is drawn
 * down the live barrel for that distance. With no live turret angle (out of
 * the viewer's interest) or no client distance it still aims at the wire end.
 */
describe('remote beam line (heavy pulse follows the live barrel to the client ray stop)', () => {
  const mount = findMount(getShipKind('battlecruiser-lance').mounts, 'main-1')!;
  const base = mount.baseAngle ?? 0;
  const muzzle = 60;
  const out = { fromX: 0, fromY: 0, toX: 0, toY: 0 };
  /** Angle of a drawn line (game-space forward = (-sin a, cos a)). */
  const lineAngle = (l: typeof out): number => Math.atan2(-(l.toX - l.fromX), l.toY - l.fromY);

  // Shooter at the origin, hull angle 0, turret trained 0.3 rad when it fired:
  // the server's ray hit the cut 8 km out along that bearing.
  const fired = 0.3;
  const hit = { x: -Math.sin(fired) * 8000, y: Math.cos(fired) * 8000 };

  it('as the turret turns between frames, the drawn pulse turns with the barrel (no frozen line)', () => {
    remoteBeamLine(true, 0, base, fired - base, 0, 0, muzzle, 8000, hit.x, hit.y, out, 7900);
    expect(lineAngle(out)).toBeCloseTo(fired, 6);
    for (const slew of [0.005, 0.033, 0.35]) {
      remoteBeamLine(true, 0, base, fired + slew - base, 0, 0, muzzle, 8000, hit.x, hit.y, out, 7900);
      expect(lineAngle(out)).toBeCloseTo(fired + slew, 6);
    }
  });

  it('the pulse leaves the barrel tip and stops at the client ray distance, not at full range', () => {
    remoteBeamLine(true, 0, base, 0.9 - base, 40, -25, muzzle, 20_000, hit.x, hit.y, out, 3000);
    expect(Math.hypot(out.fromX - 40, out.fromY + 25)).toBeCloseTo(muzzle, 6);
    expect(Math.hypot(out.toX - out.fromX, out.toY - out.fromY)).toBeCloseTo(3000, 6);
    expect(lineAngle(out)).toBeCloseTo(0.9, 6);
  });

  it('with no live turret angle, the pulse still aims at the wire end point and stops there', () => {
    remoteBeamLine(true, 0, base, undefined, 0, 0, muzzle, 8000, hit.x, hit.y, out, 2000);
    expect(lineAngle(out)).toBeCloseTo(fired, 6);
    expect(out.toX).toBe(hit.x);
    expect(out.toY).toBe(hit.y);
  });

  it('with no client distance, the pulse falls back to the wire end point', () => {
    remoteBeamLine(true, 0, base, fired + 0.35 - base, 0, 0, muzzle, 8000, hit.x, hit.y, out);
    expect(out.toX).toBe(hit.x);
    expect(out.toY).toBe(hit.y);
  });

  it('a fallback pulse never runs past where the server stopped it', () => {
    const end = { x: -Math.sin(fired) * 3000, y: Math.cos(fired) * 3000 };
    remoteBeamLine(true, 0, 0, undefined, 0, 0, muzzle, 3000, end.x, end.y, out);
    expect(Math.hypot(out.toX - end.x, out.toY - end.y)).toBe(0);
  });

  it('fighter beams (not styled) keep leaving down the live barrel for their range', () => {
    remoteBeamLine(false, 0.2, 0, 0.1, 0, 0, 10, 500, 999, 999, out);
    expect(lineAngle(out)).toBeCloseTo(0.3, 9);
    expect(Math.hypot(out.toX - out.fromX, out.toY - out.fromY)).toBeCloseTo(500, 6);
  });

  it('a point-blank fallback end point inside the barrel draws nothing, never backwards', () => {
    remoteBeamLine(true, 0, 0, undefined, 0, 0, muzzle, 20, 0, 20, out);
    expect(out.toX).toBe(out.fromX);
    expect(out.toY).toBe(out.fromY);
  });
});

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
import { findMount, remoteBeamFireAngle } from './beamStyles.js';
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

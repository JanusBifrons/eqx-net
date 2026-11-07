/**
 * Hostile audit (2026-11-07, capital-guns-bystander clip): capital turrets
 * turned in 20 Hz steps because each snapshot's mount angles were drawn
 * as-is. The raw snapshot angles step every third frame; the drawn angles
 * must change evenly every frame while the turret turns.
 */
import { describe, expect, it } from 'vitest';
import { slewDisplayMountAngles, type DisplayMountEntry } from './displayMountAngles';

const DT = 1 / 60;
const SPEED = 0.07; // a 16" turret, rad/s

describe('drawn turret angles between snapshots', () => {
  it('raw snapshot angles step at 20 Hz, drawn angles turn every frame', () => {
    const mounts = [{ rotationSpeed: SPEED }];
    const entry: DisplayMountEntry = {};
    const raw: number[] = [], drawn: number[] = [];
    for (let f = 0; f < 120; f++) {
      // The server turret turns at its traverse rate; a snapshot lands every 3rd frame.
      if (f % 3 === 0) entry.mountAngles = [SPEED * f * DT]; // a fresh array per snapshot, as the apply does
      slewDisplayMountAngles(entry, mounts, DT);
      raw.push(entry.mountAngles![0]!);
      drawn.push(entry.displayMountAngles![0]!);
    }
    const steps = (a: number[]): number[] => a.slice(31).map((v, i) => v - a[30 + i]!);
    // The bug: two frames in three, the raw angle doesn't move.
    expect(steps(raw).filter((s) => s === 0).length).toBeGreaterThan(50);
    // The fix: every frame moves, by an even amount.
    const d = steps(drawn);
    expect(d.every((s) => s > 0)).toBe(true);
    expect(Math.max(...d) / Math.min(...d)).toBeLessThan(1.6);
    // And it stays within a snapshot of the server's angle.
    expect(Math.abs(drawn[119]! - raw[119]!)).toBeLessThan(SPEED * 4 * DT);
  });

  it('snaps on a reset, follows nothing once the angles go away', () => {
    const entry: DisplayMountEntry = { mountAngles: [0] };
    slewDisplayMountAngles(entry, [{ rotationSpeed: SPEED }], DT);
    entry.mountAngles = [1.2];
    slewDisplayMountAngles(entry, [{ rotationSpeed: SPEED }], DT);
    expect(entry.displayMountAngles![0]).toBe(1.2);
    entry.mountAngles = undefined;
    slewDisplayMountAngles(entry, [{ rotationSpeed: SPEED }], DT);
    expect(entry.displayMountAngles).toBeUndefined();
  });

  it('stays smooth when snapshots arrive unevenly (every 2-4 frames)', () => {
    const mounts = [{ rotationSpeed: SPEED }];
    const entry: DisplayMountEntry = {};
    const gaps = [3, 2, 4, 3, 3, 2, 4, 4, 2, 3];
    let next = 0, g = 0;
    const drawn: number[] = [];
    for (let f = 0; f < 150; f++) {
      if (f === next) { entry.mountAngles = [SPEED * f * DT]; next += gaps[g++ % gaps.length]!; }
      slewDisplayMountAngles(entry, mounts, DT);
      drawn.push(entry.displayMountAngles![0]!);
    }
    const d = drawn.slice(31).map((v, i) => v - drawn[30 + i]!);
    expect(d.every((x) => x > 0), 'never holds').toBe(true);
    expect(Math.max(...d) / Math.min(...d)).toBeLessThan(2.5);
  });
});


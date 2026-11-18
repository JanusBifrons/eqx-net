/**
 * Macro terrain C2 (rock mass, owner 2026-11-16): field rocks are mountains.
 * A rock wakes only to a body at least as heavy as itself
 * (`fieldRockWakes`), so a fighter at full speed never moves one (it bounces
 * off, the rock never wakes); a battleship cannot move a rock its own size
 * (about a hundred times its mass); and a battleship pressed against a much
 * smaller rock shoves it aside, so a capital snagged in the field gets free.
 * Rocks and approaches are found in the `look` field: each target sits at the
 * field's rim, with open space on the approach side.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { fieldRockId } from '../../../src/core/terrain/chunkStreamer.js';

let harness: SectorTestHarness | undefined;
afterEach(async () => { await harness?.cleanup(); harness = undefined; });

/** A field rock of the `look` field: key, centre, bounding radius, a
 *  direction (radians) from its centre with open space beyond it (no other
 *  rock's outline within a battleship's half-width of that line), and how
 *  far out along it the rock's own outline is. */
interface Target { key: number; x: number; y: number; r: number; dir: number; surf: number }
/** r 339: a typical (median-sized) rock at the field's rim, open to +x. */
const MEDIAN: Target = { key: 2759917568, x: 149128, y: 4940, r: 339, dir: 0, surf: 248 };
/** r 191: a small rock (~0.44 battleship masses). */
const SMALL: Target = { key: 1788477442, x: -88146, y: 108087, r: 191, dir: Math.PI, surf: 100 };
/** r 4616: a rock bigger than a battleship (~200 battleship masses). */
const BIG: Target = { key: 1752367104, x: -95102, y: -52529, r: 4616, dir: 2.3562, surf: 2907 };

/** A ship `gap` off the target's outline along its open direction, `along`
 *  further back, nose (forward = (-sin a, cos a)) at the rock. */
function approach(t: Target, gap: number, along: number): { x: number; y: number; angle: number; ux: number; uy: number } {
  const ux = Math.cos(t.dir), uy = Math.sin(t.dir), d = t.surf + gap + along;
  return { x: t.x + ux * d, y: t.y + uy * d, angle: Math.atan2(ux, -uy), ux, uy };
}

async function boot(shipKind: string, at: { x: number; y: number; angle: number }) {
  harness = await bootSectorTestServer({ sectorKey: null, testMode: true, cutField: { seed: 'look' }, asteroidConfig: [], droneCount: 0 });
  const pid = randomUUID();
  const client = await harness.connectActive(pid, { shipKind, initialHull: 1_000_000, initialAngle: at.angle, spawnX: Math.round(at.x), spawnY: Math.round(at.y) });
  const int = (harness.getServerRoom() as unknown as SectorRoom)._internals;
  return { pid, client, int };
}

async function rockPose(int: SectorRoom['_internals'], id: string): Promise<{ x: number; y: number; angle: number }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const p = int.swarmPose(id);
    if (p) return p;
    await harness!.advance(250);
  }
  throw new Error(`field rock ${id} never streamed in`);
}

function wokeIds(): string[] {
  return harness!.events.all({ tag: 'field_rock_woke' }).map((e) => String((e.data as { id: string }).id));
}

describe('SectorRoom integration — cut-field rock mass', () => {
  it('a fighter at full speed bounces off a field rock: it never wakes, never moves', { timeout: 60_000 }, async () => {
    const at = approach(MEDIAN, 60, 30);
    const { pid, client, int } = await boot('fighter', at);
    const id = fieldRockId(MEDIAN.key);
    const before = await rockPose(int, id);
    const v = 601; // the fighter's top speed
    int.postToWorker({ type: 'SET_POSITION', entityId: pid, x: at.x, y: at.y, angle: at.angle, vx: -at.ux * v, vy: -at.uy * v, angvel: 0 });
    // One second coasting in at top speed from 338 u out: unchecked it would
    // be 263 u past the centre; it stopped at the outline instead.
    for (let i = 0; i < 4; i++) await harness!.advance(250);
    const ship = int.playerPose(pid)!;
    expect((ship.x - MEDIAN.x) * at.ux + (ship.y - MEDIAN.y) * at.uy, 'fighter stopped at the rock').toBeGreaterThan(MEDIAN.surf / 2);
    // Then two seconds pressing in under full thrust and boost.
    const thrust = setInterval(() => {
      client.send('input', { type: 'input', tick: 0, thrust: true, turnLeft: false, turnRight: false, boost: true });
    }, 50);
    try {
      for (let i = 0; i < 8; i++) await harness!.advance(250);
    } finally {
      clearInterval(thrust);
    }
    const after = int.swarmPose(id)!;
    expect(int.swarmRegistry.get(id)?.fieldAwake, 'the rock never woke').not.toBe(true);
    expect(wokeIds(), 'no rock woke').toEqual([]);
    expect(Math.hypot(after.x - before.x, after.y - before.y), 'rock position').toBeLessThan(1e-3);
    expect(Math.abs(after.angle - before.angle), 'rock angle').toBeLessThan(1e-6);
  });

  it('a battleship cannot move a rock bigger than itself', { timeout: 60_000 }, async () => {
    const at = approach(BIG, 80, 2_900);
    const { pid, client, int } = await boot('battleship', at);
    const id = fieldRockId(BIG.key);
    const before = await rockPose(int, id);
    const thrust = setInterval(() => {
      client.send('input', { type: 'input', tick: 0, thrust: true, turnLeft: false, turnRight: false, boost: true });
    }, 50);
    let closest = Infinity;
    try {
      for (let i = 0; i < 40; i++) {
        await harness!.advance(250);
        const s = int.playerPose(pid)!;
        closest = Math.min(closest, (s.x - BIG.x) * at.ux + (s.y - BIG.y) * at.uy);
      }
    } finally {
      clearInterval(thrust);
    }
    const after = int.swarmPose(id)!;
    expect(int.swarmRegistry.get(id)?.fieldAwake, 'the big rock never woke').not.toBe(true);
    expect(wokeIds(), 'the big rock never woke').not.toContain(id);
    expect(Math.hypot(after.x - before.x, after.y - before.y), 'rock position').toBeLessThan(1e-3);
    expect(Math.abs(after.angle - before.angle), 'rock angle').toBeLessThan(1e-6);
    // It drove in and stopped against the rock (not short of it, not through it).
    expect(closest, 'battleship reached the rock').toBeLessThan(BIG.surf + 2_900 + 40);
    expect(closest, 'battleship stopped at the rock').toBeGreaterThan(0);
  });

  it('a battleship pressed against a much smaller rock shoves it aside', { timeout: 60_000 }, async () => {
    const at = approach(SMALL, 80, 2_900);
    const { pid, client, int } = await boot('battleship', at);
    const id = fieldRockId(SMALL.key);
    const before = await rockPose(int, id);
    // Creeping in (30 u/s), then pressing on under full thrust.
    int.postToWorker({ type: 'SET_POSITION', entityId: pid, x: at.x, y: at.y, angle: at.angle, vx: -at.ux * 30, vy: -at.uy * 30, angvel: 0 });
    const start = int.playerPose(pid)!;
    const thrust = setInterval(() => {
      client.send('input', { type: 'input', tick: 0, thrust: true, turnLeft: false, turnRight: false, boost: true });
    }, 50);
    try {
      for (let i = 0; i < 40; i++) await harness!.advance(250);
    } finally {
      clearInterval(thrust);
    }
    expect(int.swarmRegistry.get(id)?.fieldAwake, 'the small rock woke').toBe(true);
    const after = int.swarmPose(id)!, ship = int.playerPose(pid)!;
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    const advanced = (start.x - ship.x) * at.ux + (start.y - ship.y) * at.uy;
    console.log(`[rock-mass] battleship pressing 10 s: rock moved ${moved.toFixed(1)} u, battleship advanced ${advanced.toFixed(1)} u`);
    // It got free: it drove on well past where it met the rock (80 u in).
    expect(advanced, 'battleship pushed on past the rock').toBeGreaterThan(80 + 100);
    expect(moved, 'the rock was shoved aside').toBeGreaterThan(100);
  });
});

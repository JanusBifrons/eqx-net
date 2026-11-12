/**
 * Capitals collide solidly (owner decision 2026-11-12, verbatim: "They
 * absolutely should collide by design.").
 *
 * Reported symptom (filmed `showcase-capitals-combat` clip): a pilot's heavy
 * cruiser under thrust drove INTO an NPC battleship's hull and the overlap
 * grew for about 7 s; the hulls never pushed apart. A second report: a pilot
 * capital spawned inside an NPC capital and the two stayed interpenetrated for
 * the whole 14 s take.
 *
 * Root cause (measured in `World.capitalContact.test.ts`):
 *  1. A capital's shield-up collider was a ROUND convex hull. Rapier builds a
 *     round-shape contact by GJK on the un-rounded cores, and once the cores
 *     overlap (penetration past twice the shield pad) it reports NO contact at
 *     all, so the hulls pass through each other freely and thrust drives them
 *     deeper.
 *  2. Where there is a contact, Rapier's position correction is capped at
 *     `normalized max corrective velocity × lengthUnit` = 10 u/s, so a 350 u
 *     overlap took over half a minute to clear, and the bodies fell asleep on
 *     the way.
 *
 * Overlap is measured on the real collision hulls (`shipCollisionParts`, convex
 * parts, SAT penetration depth) at the live SAB poses.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { SHOWCASE_CAPITALS_COMBAT_OPTS } from '../../../src/server/rooms/showcaseRooms.js';
import { shipCollisionParts } from '../../../src/core/geometry/shipHullDecomp.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF } from '../../../src/shared-types/sabLayout.js';

type Pose = { x: number; y: number; angle: number };
type V = { x: number; y: number };

function roomOf(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

function slotPose(room: SectorRoom, slot: number): Pose {
  const sab = (room as unknown as { sabF32: Float32Array }).sabF32;
  const b = slotBase(slot);
  return { x: sab[b + SLOT_X_OFF]!, y: sab[b + SLOT_Y_OFF]!, angle: sab[b + SLOT_ANGLE_OFF]! };
}

function worldParts(kind: string, p: Pose): V[][] {
  const c = Math.cos(p.angle), s = Math.sin(p.angle);
  return shipCollisionParts(kind).map((part) => part.map((v) => ({ x: p.x + v.x * c - v.y * s, y: p.y + v.x * s + v.y * c })));
}

/** SAT penetration depth of two convex polygons (0 when separated). */
function penetration(a: V[], b: V[]): number {
  let min = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
      let nx = -(q.y - p.y), ny = q.x - p.x;
      const len = Math.hypot(nx, ny);
      if (len === 0) continue;
      nx /= len; ny /= len;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const v of a) { const d = v.x * nx + v.y * ny; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d); }
      for (const v of b) { const d = v.x * nx + v.y * ny; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
      const o = Math.min(aMax, bMax) - Math.max(aMin, bMin);
      if (o <= 0) return 0;
      min = Math.min(min, o);
    }
  }
  return min;
}

function hullPenetration(ka: string, pa: Pose, kb: string, pb: Pose): number {
  let worst = 0;
  for (const a of worldParts(ka, pa)) for (const b of worldParts(kb, pb)) worst = Math.max(worst, penetration(a, b));
  return worst;
}

function npcSlot(room: SectorRoom, kind: string, x: number, y: number): number {
  let best: { slot: number; d: number } | null = null;
  for (const rec of room._internals.swarmRegistry.all()) {
    if (rec.kind !== 1 || rec.shipKind !== kind) continue;
    const p = slotPose(room, rec.slot);
    const d = Math.hypot(p.x - x, p.y - y);
    if (!best || d < best.d) best = { slot: rec.slot, d };
  }
  if (!best) throw new Error(`no NPC ${kind}`);
  return best.slot;
}

/** An overlap must clear within this (goal: "visibly within about 1–2 s"). */
const SETTLE_MS = 2500;
/** A few units of contact skin / solver slop is not an overlap. */
const SLOP = 30;
/** Two heavy cruisers posed 2,500 u apart, nose to tail: the overlap as posed
 *  (checked on the requested poses, since the fix may already be pushing by
 *  the time a join completes). */
const POSED_OVERLAP = hullPenetration('heavy-cruiser', { x: 0, y: -2500, angle: 0 }, 'heavy-cruiser', { x: 0, y: 0, angle: 0 });

function capitalOpts(dronePoses: Array<{ kind: string; x: number; y: number; angle: number }>): Record<string, unknown> {
  // The capital line-up's brains and rules, no structures (a structure would
  // nudge the explicit spawn).
  const opts = structuredClone(SHOWCASE_CAPITALS_COMBAT_OPTS) as unknown as Record<string, unknown>;
  opts.dronePoses = dronePoses;
  opts.prebuiltStructures = [];
  return opts;
}

describe('capitals collide solidly (owner: "They absolutely should collide by design")', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it('a heavy cruiser under full thrust cannot drive into a parked battleship', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer(capitalOpts([{ kind: 'battleship', x: 0, y: 0, angle: 0 }]));
    const pilot = randomUUID();
    // Battleship at the origin, nose +y; the pilot's cruiser dead astern of
    // it, nose +y, just short of its stern, so full thrust rams the stern.
    const cr = await harness.connectActive(pilot, { shipKind: 'heavy-cruiser', initialHull: 1_000_000, noselfdmg: 1, spawnX: 0, spawnY: -5400 });
    const room = roomOf(cr.roomId);
    const slotOf = (): number => (room as unknown as { playerToSlot: Map<string, number> }).playerToSlot.get(pilot)!;
    const bs = npcSlot(room, 'battleship', 0, 0);
    expect(hullPenetration('heavy-cruiser', slotPose(room, slotOf()), 'battleship', slotPose(room, bs)), 'starts clear').toBe(0);
    let worst = 0;
    let moved = 0;
    const y0 = slotPose(room, slotOf()).y;
    for (let i = 0; i < 40; i++) {
      cr.send('input', { type: 'input', tick: 0, thrust: true, boost: true, turnLeft: false, turnRight: false });
      await harness.advance(50);
      const p = slotPose(room, slotOf());
      moved = Math.max(moved, p.y - y0);
      worst = Math.max(worst, hullPenetration('heavy-cruiser', p, 'battleship', slotPose(room, bs)));
    }
    expect(moved, 'the cruiser really flew at the battleship').toBeGreaterThan(300);
    expect(worst, `worst hull penetration under thrust ${worst.toFixed(0)} u`).toBeLessThan(SLOP);
  });

  it('a heavy cruiser rammed bow-to-bow into a battleship under full thrust is pushed out, never deeper', { timeout: 40_000 }, async () => {
    // The filmed case: the cruiser's bow already well inside the battleship
    // (a hard ram, a warp drop or a spawn) and full thrust held. The
    // battleship lies nose -y at the origin; the cruiser (nose +y) sits under
    // it with ~200 u of hull overlap. On main it was still 53 u deep after
    // 2 s of thrust (runs that held thrust 5 s ended 120–140 u deep: the
    // contact came and went), and a pure-physics replay of this pose ends
    // 237 u deep after 8 s. Goal: cleared within 2 s, never deeper.
    harness = await bootSectorTestServer(capitalOpts([{ kind: 'battleship', x: 0, y: 0, angle: Math.PI }]));
    const pilot = randomUUID();
    const cr = await harness.connectActive(pilot, { shipKind: 'heavy-cruiser', initialHull: 1_000_000, noselfdmg: 1, spawnX: 0, spawnY: -3930 });
    const room = roomOf(cr.roomId);
    const slotOf = (): number => (room as unknown as { playerToSlot: Map<string, number> }).playerToSlot.get(pilot)!;
    const bs = npcSlot(room, 'battleship', 0, 0);
    // The overlap as posed (the pass may already be pushing by the time the
    // join completes, so the precondition is checked on the requested poses).
    const start = hullPenetration('heavy-cruiser', { x: 0, y: -3930, angle: 0 }, 'battleship', { x: 0, y: 0, angle: Math.PI });
    expect(start, 'the setup really overlaps').toBeGreaterThan(3 * SLOP);
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      cr.send('input', { type: 'input', tick: 0, thrust: true, boost: true, turnLeft: false, turnRight: false });
      await harness.advance(50);
      worst = Math.max(worst, hullPenetration('heavy-cruiser', slotPose(room, slotOf()), 'battleship', slotPose(room, bs)));
    }
    const end = hullPenetration('heavy-cruiser', slotPose(room, slotOf()), 'battleship', slotPose(room, bs));
    expect(worst, `overlap grew under thrust: ${start.toFixed(0)} u → worst ${worst.toFixed(0)} u`).toBeLessThan(start + SLOP);
    expect(end, `penetration under thrust ${start.toFixed(0)} u → ${end.toFixed(0)} u`).toBeLessThan(SLOP);
  });

  it('a flying pilot capital spawned inside an NPC capital separates', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer(capitalOpts([{ kind: 'heavy-cruiser', x: 0, y: 0, angle: 0 }]));
    const pilot = randomUUID();
    // The pilot's heavy cruiser 2,500 u astern of the NPC's: its bow is deep
    // in the NPC's stern.
    const cr = await harness.connectActive(pilot, { shipKind: 'heavy-cruiser', initialHull: 1_000_000, noselfdmg: 1, spawnX: 0, spawnY: -2500 });
    const room = roomOf(cr.roomId);
    const npc = npcSlot(room, 'heavy-cruiser', 0, 0);
    const slotOf = (): number => (room as unknown as { playerToSlot: Map<string, number> }).playerToSlot.get(pilot)!;
    const start = POSED_OVERLAP;
    expect(start, 'the setup really overlaps').toBeGreaterThan(SLOP);
    await harness.advance(SETTLE_MS);
    const end = hullPenetration('heavy-cruiser', slotPose(room, slotOf()), 'heavy-cruiser', slotPose(room, npc));
    expect(end, `penetration ${start.toFixed(0)} u → ${end.toFixed(0)} u`).toBeLessThan(SLOP);
  });

  it('a parked (Spectate) pilot capital overlapping an NPC capital separates', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer(capitalOpts([{ kind: 'heavy-cruiser', x: 0, y: 0, angle: 0 }]));
    const cr = await harness.connectActive(randomUUID(), { shipKind: 'heavy-cruiser', initialHull: 1_000_000, noselfdmg: 1, spawnX: 0, spawnY: -2500 });
    const room = roomOf(cr.roomId);
    const npc = npcSlot(room, 'heavy-cruiser', 0, 0);
    cr.send('spectate', { type: 'spectate' });
    const slots = (room as unknown as { lingeringSlots: Map<string, number> }).lingeringSlots;
    for (let i = 0; i < 75 && slots.size === 0; i++) await harness.advance(40);
    expect(slots.size, 'hull parked').toBeGreaterThan(0);
    const parked = [...slots.values()][0]!;
    const start = POSED_OVERLAP;
    expect(start, 'the setup really overlaps').toBeGreaterThan(SLOP);
    await harness.advance(SETTLE_MS);
    const end = hullPenetration('heavy-cruiser', slotPose(room, parked), 'heavy-cruiser', slotPose(room, npc));
    expect(end, `penetration ${start.toFixed(0)} u → ${end.toFixed(0)} u`).toBeLessThan(SLOP);
  });

  it('two NPC capitals posed overlapping separate', { timeout: 40_000 }, async () => {
    const opts = capitalOpts([
      { kind: 'heavy-cruiser', x: 0, y: 0, angle: 0 },
      { kind: 'heavy-cruiser', x: 0, y: -2500, angle: 0 },
    ]);
    opts.defaultSpawnX = 20_000;
    opts.defaultSpawnY = 0;
    harness = await bootSectorTestServer(opts);
    const cr = await harness.connectActive(randomUUID());
    const room = roomOf(cr.roomId);
    const a = npcSlot(room, 'heavy-cruiser', 0, 0), b = npcSlot(room, 'heavy-cruiser', 0, -2500);
    const start = POSED_OVERLAP;
    expect(start, 'the setup really overlaps').toBeGreaterThan(SLOP);
    await harness.advance(SETTLE_MS);
    const end = hullPenetration('heavy-cruiser', slotPose(room, a), 'heavy-cruiser', slotPose(room, b));
    expect(end, `penetration ${start.toFixed(0)} u → ${end.toFixed(0)} u`).toBeLessThan(SLOP);
  });
});

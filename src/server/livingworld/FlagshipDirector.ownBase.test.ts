/**
 * Bug 2026-11-21 (gameplay audit, fresh world): a power's flagship parked on
 * its own outer base pocket, where the garrison (`npc:core:mil`) grows, and
 * ground its ~3 km hull through the base's connectors and turrets until its
 * own rams killed it. The fleet's post, spawn and wander courses must keep the
 * flagship's whole hull (its size from `tuningFor`, #18) clear of structures,
 * through the room's one structure query (`clearPointNear`).
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { FlagshipDirector, FLEET_ESCORT_KINDS, FLAGSHIP_STATE_VERSION } from './FlagshipDirector.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';
import { sectorSites } from '../../core/galaxy/sectorSites.js';
import { nearestClearPoint, type SiteBox } from '../../core/bases/baseSite.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';

const A = 'sol-prime';
const BASE = sectorSites(A).find((s) => s.id === 'base:0')!;
/** The garrison: a square filling the base pocket (its centre included). */
const BOX: SiteBox = { x: BASE.x, y: BASE.y, hw: 3000, hh: 3000 };

/** Gap between a hull circle at (x, y) and the box (negative = overlap). */
function gap(x: number, y: number, r: number): number {
  const dx = Math.max(Math.abs(x - BOX.x) - BOX.hw, 0), dy = Math.max(Math.abs(y - BOX.y) - BOX.hh, 0);
  return Math.hypot(dx, dy) - r;
}

function roomWithBase() {
  const bus = new EventEmitter();
  const bots = new Map<string, { kind: string; x: number; y: number }>();
  const points: Array<{ what: string; id: string; x: number; y: number }> = [];
  const room = {
    bots, points,
    eventBus: () => bus,
    hasFreeSlot: () => true,
    spawnLivingWorldBot: (s: { botId: string; kind: string; x: number; y: number }) => { bots.set(s.botId, { kind: s.kind, x: s.x, y: s.y }); points.push({ what: 'spawn', id: s.botId, x: s.x, y: s.y }); return true; },
    despawnLivingWorldBot: (id: string) => { bots.delete(id); return null; },
    markElite: () => true,
    setBotFlockFollow: () => {},
    setBotFlockLeaderCourse: (id: string, x: number, y: number) => { points.push({ what: 'course', id, x, y }); const b = bots.get(id); if (b) { b.x = x; b.y = y; } },
    setBotMoveTarget: (id: string, x: number, y: number) => { points.push({ what: 'move', id, x, y }); },
    setBotGuardPost: (id: string, x: number, y: number, _r: number, anchor?: string) => { if (anchor === undefined) points.push({ what: 'post', id, x, y }); },
    getBotPose: (id: string) => { const b = bots.get(id); return b ? { x: b.x, y: b.y, angle: 0 } : null; },
    warpBot: () => true,
    botWarpPhase: () => 0 as const,
    broadcastWorldNotice: () => {},
    clearPointNear: (x: number, y: number, clearance = 150) => nearestClearPoint(x, y, [BOX], clearance, 20_000),
  };
  return room;
}

describe('FlagshipDirector: a flagship keeps clear of its own base', () => {
  it('parks, spawns and wanders in its base pocket with its whole hull clear of the structures', () => {
    const room = roomWithBase();
    let t = 1_000_000;
    const kind: ShipKindId = 'battleship-b';
    const d = new FlagshipDirector(new Map([[A, room]]) as unknown as Map<string, LivingWorldRoom>, {
      rng: () => 0.3, nowMs: () => t, powers: ['core'], holderOf: () => 'core', dwellMs: 10 * 60_000,
      restore: { version: FLAGSHIP_STATE_VERSION, fleets: [{ sectorKey: A, pocketId: BASE.id, kind, name: 'Battleship Resolute', moves: 0, escorts: [...FLEET_ESCORT_KINDS], factionId: 'core' }] },
    });
    d.start();
    for (let i = 0; i < 8; i++) { t += 46_000; d.tick(t); }
    expect(d.state().fleets[0]!.pocketId).toBe(BASE.id);
    const leadPts = room.points.filter((p) => p.id.endsWith('-lead'));
    expect(leadPts.some((p) => p.what === 'post')).toBe(true);
    expect(leadPts.some((p) => p.what === 'course')).toBe(true);
    const r = getShipKind(kind).radius;
    for (const p of leadPts) expect(gap(p.x, p.y, r), `${p.what} (${Math.round(p.x)}, ${Math.round(p.y)})`).toBeGreaterThan(0);
    // The post stays in the pocket's reach (it guards that pocket).
    const post = leadPts.filter((p) => p.what === 'post').at(-1)!;
    expect(Math.hypot(post.x - BASE.x, post.y - BASE.y)).toBeLessThan(BASE.r + 3 * r);
    // Escorts spawn clear too.
    for (const p of room.points) {
      if (p.id.endsWith('-lead') || p.what !== 'spawn') continue;
      expect(gap(p.x, p.y, getShipKind(room.bots.get(p.id)!.kind).radius), p.id).toBeGreaterThan(0);
    }
  });
});

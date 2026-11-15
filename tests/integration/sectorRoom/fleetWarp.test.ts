/**
 * RTS fleet warp S3 — the selected parked ships really go to the next sector.
 *
 * Two real galaxy rooms in one process. A commander in Command view (a
 * spectator: no ship of their own) has three parked hulls in A, two of them a
 * squad, all aggressive, one on a patrol route. `engage_transit { shipIds }`
 * spools, then the hulls go through the ONE cross-sector hull hand-off the
 * teleporter uses:
 *  - all three are LINGERING in B, none left in A;
 *  - the largest hull lands nearest the picked point, the others in formation,
 *    none overlapping each other or the commander's own hull already parked
 *    there (the landing nudge does not ignore the owner's own ships);
 *  - their roster rows are re-homed to B (one `sector_change` audit each);
 *  - the AI pilots carry stance and squad, and guard where they land (the
 *    patrol route belonged to A).
 * A hull destroyed mid-spool does not stop the others.
 *
 * Failing-first: before S3 `handOffHulls` was a stub, so nothing moved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import type { SectorSnapshotLingeringHull } from '../../../src/server/rooms/SectorSnapshot.js';
import { tuningFor } from '../../../src/shared-types/shipScale/lookup.js';
import { setAuditSink, type AuditEvent } from '../../../src/server/audit/GameplayAuditLog.js';

const OWNER = 'face0000-0000-4000-8000-0000000000f1';
const A = 'sol-prime';
const B = 'vega-reach';
const SPOOL_MS = 300;

function hullRow(shipId: string, kind: string, x: number, y: number): SectorSnapshotLingeringHull {
  return { shipInstanceId: shipId, playerId: OWNER, kind, x, y, vx: 0, vy: 0, angle: 0.5, angvel: 0, health: 400, shieldDown: false };
}

describe('SectorRoom integration — RTS fleet warp moves the selected hulls (S3)', () => {
  let harness: LivingWorldTestHarness | undefined;
  afterEach(async () => {
    setAuditSink(null);
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 15_000);

  /** A room's live parked-hull poses (private: `lingeringPoseCache`). */
  const posesOf = (key: string): Map<string, { x: number; y: number }> =>
    (harness!.getRoom(key) as unknown as { lingeringPoseCache: Map<string, { x: number; y: number }> }).lingeringPoseCache;

  async function boot(): Promise<{ ia: SectorRoom['_internals']; ib: SectorRoom['_internals'] }> {
    harness = await bootLivingWorldTestServer({ sectors: [A, B], botCount: 0, transitSpoolMsOverride: SPOOL_MS });
    return { ia: harness.getRoom(A)._internals, ib: harness.getRoom(B)._internals };
  }

  /** Three parked hulls in A: the frigate (largest) and two fighters, spaced
   *  well apart. Returns their ids [frigate, fighter1, fighter2]. */
  function parkThree(ia: SectorRoom['_internals']): string[] {
    const store = getPlayerShipStore();
    const mk = (kind: string, x: number, y: number): string =>
      store.create({ playerId: OWNER, userId: null, kind, sectorKey: A, x, y, health: 400 }).shipId;
    const lead = mk('missile-frigate', 1500, 1500);
    const w1 = mk('fighter', 1500 + 400, 1500);
    const w2 = mk('fighter', 1500, 1500 + 400);
    ia.restoreLingeringHulls([
      hullRow(lead, 'missile-frigate', 1500, 1500),
      hullRow(w1, 'fighter', 1900, 1500),
      hullRow(w2, 'fighter', 1500, 1900),
    ]);
    return [lead, w1, w2];
  }

  it('the selected hulls arrive in the next sector in formation, clear of the owner\'s own hull, with stance and squad, guarding where they land', { timeout: 40_000 }, async () => {
    const audits: AuditEvent[] = [];
    setAuditSink((e) => { audits.push(e); });
    const { ia, ib } = await boot();
    const [lead, w1, w2] = parkThree(ia);
    // The commander's own hull already parked in B, right where they will point.
    const store = getPlayerShipStore();
    const ARRIVAL = { x: -1200, y: 2200 };
    const resident = store.create({ playerId: OWNER, userId: null, kind: 'fighter', sectorKey: B, x: ARRIVAL.x, y: ARRIVAL.y, health: 400 }).shipId;
    ib.restoreLingeringHulls([hullRow(resident, 'fighter', ARRIVAL.x, ARRIVAL.y)]);
    expect(ib.lingeringSlots.has(resident)).toBe(true);

    const fleet = ia.fleet;
    expect(fleet.setStance(OWNER, [lead, w1, w2], 'aggressive')).toHaveLength(3);
    expect(fleet.setMode(OWNER, [lead], 'patrol', { route: [[1500, 1500], [3000, 1500]] })).toEqual([lead]);
    expect(fleet.formSquad(OWNER, [w1, w2])).not.toBeNull();

    const cmd = await harness!.connectAs(OWNER, A, { spectator: true });
    cmd.send('client_ready', { type: 'client_ready' });
    await harness!.advance(300);
    cmd.send('engage_transit', { type: 'engage_transit', targetSectorKey: B, arrival: ARRIVAL, shipIds: [lead, w1, w2] });

    const ids = [lead!, w1!, w2!];
    await harness!.waitUntil(() => ids.every((id) => ib.lingeringSlots.has(id)), 8000, 'all three hulls in B');
    // Gone from A.
    for (const id of ids) expect(ia.lingeringSlots.has(id), `${id} left A`).toBe(false);
    // Roster re-homed, one audit per hull.
    for (const id of ids) expect(store.get(id)?.lastSectorKey).toBe(B);
    const hullAudits = audits.filter((e) => e.event === 'sector_change' && (e as { entityKind?: string }).entityKind === 'hull');
    expect(hullAudits.map((e) => (e as { id: string }).id).sort()).toEqual([...ids].sort());

    // Poses: the largest hull lands nearest the picked point; nobody overlaps
    // anybody (the resident own hull included).
    const kinds: Record<string, string> = { [lead!]: 'missile-frigate', [w1!]: 'fighter', [w2!]: 'fighter', [resident]: 'fighter' };
    const pose = (id: string): { x: number; y: number } => {
      const p = posesOf(B).get(id);
      expect(p, `${id} has a pose in B`).toBeDefined();
      return p!;
    };
    const all = [...ids, resident];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = pose(all[i]!), b = pose(all[j]!);
        const need = tuningFor(kinds[all[i]!]!).spawnClearance + tuningFor(kinds[all[j]!]!).spawnClearance;
        expect(Math.hypot(a.x - b.x, a.y - b.y), `${all[i]} vs ${all[j]}`).toBeGreaterThanOrEqual(need * 0.9);
      }
    }
    const dist = (id: string): number => Math.hypot(pose(id).x - ARRIVAL.x, pose(id).y - ARRIVAL.y);
    expect(dist(lead!)).toBeLessThan(3000);
    // The wingmen kept their place relative to the lead (formation), give or
    // take a landing nudge.
    for (const w of [w1!, w2!]) expect(Math.hypot(pose(w).x - pose(lead!).x, pose(w).y - pose(lead!).y)).toBeLessThan(2000);

    // Brains: stance + squad carried; every one guards where it landed.
    const fb = ib.fleet;
    for (const id of ids) {
      const brain = fb.ordersOf(id);
      expect(brain, `${id} has an AI pilot in B`).toBeDefined();
      expect(brain!.stance).toBe('aggressive');
    }
    const leadBrain = fb.ordersOf(lead!)!;
    expect(leadBrain.mode, 'the patrol route stayed in A').toBe('defend');
    expect(leadBrain.guardPostX).toBeCloseTo(pose(lead!).x, 0);
    const squads = fb.exportSquads();
    expect(squads).toHaveLength(1);
    expect([...squads[0]!.memberIds].sort()).toEqual([w1!, w2!].sort());
    expect(squads[0]!.ownerId).toBe(OWNER);
    // The resident hull is untouched.
    expect(ib.lingeringSlots.has(resident)).toBe(true);
  });

  it('a snapshot row for a hull the roster re-homed to another sector is not rebuilt (no crash duplicate)', { timeout: 30_000 }, async () => {
    const { ia, ib } = await boot();
    // A hand-off re-homed the ship to B, but A's last snapshot (written before
    // a crash) still lists it: A's hydrate must leave it to B.
    const id = getPlayerShipStore().create({ playerId: OWNER, userId: null, kind: 'fighter', sectorKey: B, x: 0, y: 0, health: 400 }).shipId;
    ia.restoreLingeringHulls([hullRow(id, 'fighter', 600, 600)]);
    expect(ia.lingeringSlots.has(id)).toBe(false);
    ib.restoreLingeringHulls([hullRow(id, 'fighter', 600, 600)]);
    expect(ib.lingeringSlots.has(id)).toBe(true);
  });

  it('a hull destroyed mid-spool stays dead and the rest still arrive', { timeout: 40_000 }, async () => {
    const { ia, ib } = await boot();
    const [lead, w1, w2] = parkThree(ia);
    const cmd = await harness!.connectAs(OWNER, A, { spectator: true });
    cmd.send('client_ready', { type: 'client_ready' });
    await harness!.advance(300);
    cmd.send('engage_transit', { type: 'engage_transit', targetSectorKey: B, shipIds: [lead, w1, w2] });
    await harness!.advance(60);
    // Kill one while it spools (shield first, then the hull).
    const p = posesOf(A).get(w2!)!;
    for (let i = 0; i < 4 && ia.lingeringSlots.has(w2!); i++) ia.applyDamage(w2!, 'test-kill', 1e9, p.x, p.y);
    expect(ia.lingeringSlots.has(w2!)).toBe(false);

    await harness!.waitUntil(() => ib.lingeringSlots.has(lead!) && ib.lingeringSlots.has(w1!), 8000, 'the survivors in B');
    expect(ib.lingeringSlots.has(w2!)).toBe(false);
    expect(ia.lingeringSlots.has(lead!)).toBe(false);
    expect(ia.lingeringSlots.has(w1!)).toBe(false);
  });
});

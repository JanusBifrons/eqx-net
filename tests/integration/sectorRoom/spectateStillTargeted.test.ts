/**
 * Owner decision 2026-11-12: "A parked ship is still there: NPCs keep their
 * locks and keep firing at it. Spectating is no longer a way to dodge a fight."
 *
 * Reproduction (integration probe, showcase-capital-duel): a heavy-cruiser
 * pilot sends `test_aggro`, the battleship locks it (~2.6 s), the pilot toggles
 * Spectate (`spectate` → the hull parks as a LINGERING hull). Symptom: every
 * NPC dropped its lock on the pilot and nothing fired at the parked hull
 * (whether spectating at 3 s or 28 s after aggro).
 *
 * Root cause: the NPC lock step (`NpcLockSubsystem.pilotPose`) and the capital
 * turret candidates (`WeaponMountTicker.tickDrone`) only saw a pilot's ACTIVE
 * hull, so a spectate-parked hull wiped the locks and left the turrets with no
 * target. Fix: both (and the structure-turret pilot scans) gate on the named
 * ENGAGEABLE pilot-hull predicate (ACTIVE, or LINGERING parked by Spectate).
 * Second cause, found once the turrets fired again: a projectile swept every
 * lingering hull as a fighter-sized circle (`hitRadius`, 24 u), so 16" shells
 * aimed within the 60 u fire tolerance flew through a parked capital. A parked
 * hull now uses the same per-kind shield/hull sweep as an active ship.
 *
 * The room is the showcase-capital-duel layout with the battleship turned so
 * the pilot sits 40° off its bow (the forward 16" turrets need ~10 s to bear
 * instead of ~25 s), so the test runs in well under 30 s of wall time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { SHOWCASE_CAPITAL_DUEL_OPTS } from '../../../src/server/rooms/showcaseRooms.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { DamageEvent } from '../../../src/shared-types/messages.js';

interface LockedBy { t: string; s: number; p: number }
interface RoomPeek { npcLocks: { isLocked(npcId: string, pilotId: string): boolean } }

async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('SectorRoom integration — a spectate-parked hull stays an ordinary target', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    const d = SHOWCASE_CAPITAL_DUEL_OPTS;
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      peacefulDrones: d.peacefulDrones,
      pilotCapitals: d.pilotCapitals,
      prebuiltStructures: d.prebuiltStructures,
      defaultSpawnX: d.defaultSpawnX,
      defaultSpawnY: d.defaultSpawnY,
      // The duel's battleship at the origin, pilot 4,000 u to +x, bow turned
      // to 40° off the pilot's bearing.
      dronePoses: [{ kind: 'battleship', x: 0, y: 0, angle: (-50 * Math.PI) / 180 }],
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  async function joinAndAggro(): Promise<{ pid: string; cr: ClientRoom<SectorState>; server: SectorRoom; shipId: string; npcId: string; hits: DamageEvent[] }> {
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0,
    })) as ClientRoom<SectorState>;
    const server = harness.getServerRoom() as unknown as SectorRoom;
    let shipId = '';
    for (const [, s] of server.state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    expect(shipId).not.toBe('');
    const npc = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1 && r.shipKind === 'battleship')!;
    expect(npc).toBeDefined();
    const hits: DamageEvent[] = [];
    cr.onMessage('damage', (e: DamageEvent) => {
      if (e.targetId === pid || e.targetId === shipId) hits.push(e);
    });
    let lockedBy: LockedBy[] | undefined;
    cr.onMessage('snapshot', (snap: { states?: Record<string, { playerId?: string; lockedBy?: LockedBy[] }> }) => {
      for (const st of Object.values(snap.states ?? {})) if (st.playerId === pid && st.lockedBy) lockedBy = st.lockedBy;
    });
    cr.send('test_aggro', { type: 'test_aggro' });
    await waitUntil(() => lockedBy?.some((l) => l.t === `s:${npc.entityId}` && l.s === 2) === true, 10_000, 'the battleship locks the pilot');
    return { pid, cr, server, shipId, npcId: npc.id, hits };
  }

  it('the battleship keeps its lock and fires on the parked hull', { timeout: 60_000 }, async () => {
    const { pid, cr, server, shipId, npcId, hits } = await joinAndAggro();
    const peek = server as unknown as RoomPeek;
    expect(peek.npcLocks.isLocked(npcId, pid)).toBe(true);

    cr.send('spectate', { type: 'spectate' });
    await waitUntil(() => server._internals.lingeringSlots.has(shipId), 3000, 'the hull is parked');
    // Several lock steps later, the lock is still held.
    await harness.advance(1500);
    expect(peek.npcLocks.isLocked(npcId, pid), 'the battleship dropped its lock on the parked hull').toBe(true);

    // ...and its guns hit the parked hull (hostility decays 30 s after aggro).
    hits.length = 0;
    await waitUntil(() => hits.some((h) => h.targetId === shipId), 25_000, 'a hit on the parked hull').catch(() => undefined);
    expect(hits.some((h) => h.targetId === shipId), 'nothing hit the parked hull').toBe(true);
    expect(peek.npcLocks.isLocked(npcId, pid), 'lock still held after firing').toBe(true);
  });

  it('a shot still damages a spectating pilot\'s parked hull', { timeout: 30_000 }, async () => {
    const pid = randomUUID();
    const cr = (await harness.connectActive(pid, {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0,
    })) as ClientRoom<SectorState>;
    const server = harness.getServerRoom() as unknown as SectorRoom;
    let shipId = '';
    for (const [, s] of server.state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
    cr.send('spectate', { type: 'spectate' });
    await waitUntil(() => server._internals.lingeringSlots.has(shipId), 3000, 'the hull is parked');
    const ship = server.state.ships.get(shipId)!;
    const hp0 = ship.health;
    const pose = (server as unknown as { lingeringPoseCache: Map<string, { x: number; y: number }> }).lingeringPoseCache.get(shipId)!;
    expect(pose).toBeDefined();
    // A bolt fired from 600 u west, passing 60 u off the hull's centre (the
    // capital-turret aim tolerance): inside a heavy cruiser's hull, but it
    // flew through the fighter-sized circle a parked hull used to have.
    server._internals.spawnTestProjectile('test-shooter', pose.x - 600, pose.y + 60, 1200, 0, 'laser', 50);
    await waitUntil(() => ship.health < hp0, 5000, 'the parked hull takes the hit');
    expect(ship.health).toBeLessThan(hp0);
    expect(ship.alive).toBe(true);
  });
});

/**
 * Follow-up to the spectate-parked-hull fix (owner decision 2026-11-12: a
 * parked ship is still there). A PLAYER's hitscan beam tested every lingering
 * hull against the fighter-sized `hitRadius` circle (24 u) in
 * `PlayerFireResolver`'s lingering pass, so a beam passing 60 u off a parked
 * heavy cruiser's centre (well inside its hull) went straight through it.
 * Same bug class as the projectile sweep (fixed in `ProjectilePipeline`): a
 * parked hull must be hit with the same per-kind shield/hull shape as the ship
 * when it was flown.
 *
 * Geometry: shooter at the origin, nose +y. The heavy cruiser parks (Spectate)
 * side-on (bow toward +x), its bow crossing the beam line ~140 u ahead, its
 * centre ~2 km off the line. The shooter's lock is on a drone straight ahead,
 * clear beyond the bow and inside the beam's reach (the fire gate measures
 * range per mount to the target, owner decision 2026-11-14), so the shot is
 * accepted and the beam's first contact decides the hit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room as ClientRoom } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { DamageEvent, SnapshotMessage } from '../../../src/shared-types/messages.js';
import { ColyseusGameClient } from '../../../src/client/net/ColyseusClient.js';
import { PhysicsWorld } from '../../../src/core/physics/World.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipHullDistance } from '../../../src/core/combat/shipHitShape.js';

async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const BOW_EAST = -Math.PI / 2; // forward = (-sin a, cos a) = +x
const HULL_Y = 180;
const DRONE_Y = 340;
/** Cruiser centre x that puts its bow 120 u past the beam line at y = HULL_Y. */
function cruiserX(): number {
  const R = getShipKind('heavy-cruiser').radius;
  for (let c = -3 * R; c < 0; c += 5) {
    if (shipHullDistance('heavy-cruiser', false, 0, HULL_Y, c, HULL_Y, BOW_EAST) === 0) return c + 120;
  }
  throw new Error('no bow');
}

describe('SectorRoom integration — a player beam hits a parked hull by its real shape', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      dronePoses: [{ kind: 'fighter', x: 0, y: DRONE_Y, angle: 0 }],
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('a beam across a parked heavy cruiser\'s bow, far from its centre, hits it', { timeout: 30_000 }, async () => {
    const parkedPid = randomUUID();
    const parked = (await harness.connectActive(parkedPid, {
      shipKind: 'heavy-cruiser', spawnX: cruiserX(), spawnY: HULL_Y, initialAngle: BOW_EAST, initialHull: 1_000_000, initialShield: 0,
    })) as ClientRoom<SectorState>;
    const server = harness.getServerRoom() as unknown as SectorRoom;
    let shipId = '';
    for (const [, s] of server.state.ships) if (s.playerId === parkedPid && s.isActive) shipId = s.shipInstanceId;
    expect(shipId).not.toBe('');
    parked.send('spectate', { type: 'spectate' });
    await waitUntil(() => server._internals.lingeringSlots.has(shipId), 3000, 'the hull is parked');

    const shooterPid = randomUUID();
    const shooter = (await harness.connectActive(shooterPid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    const hits: DamageEvent[] = [];
    shooter.onMessage('damage', (e: DamageEvent) => { if (e.targetId === shipId) hits.push(e); });
    const drone = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1)!;
    harness.lockTarget(shooterPid, drone.id);

    // Fire a few times (each shot is its own ack; cooldown between).
    for (let i = 0; i < 4 && hits.length === 0; i++) {
      shooter.send('fire', {
        type: 'fire', tick: server._internals.serverTick, clientShotId: `s${i}`,
        weapon: 'hitscan', dirAngle: 0, slotId: 'primary',
      });
      await harness.advance(400);
    }
    expect(hits.length, 'the beam went through the parked hull').toBeGreaterThan(0);
  });

  // Shield flash on an AI-flown ship (owner clip 2026-11-14): a shot on the
  // parked hull's raised shield names it by its sid, the REAL client queues a
  // shield-tinted impact for that sid, and the hull is a `mirror.ships` entry
  // with its shield up (the renderer's `_activeShieldIds` / sprite key).
  it('a shot on a parked hull\'s shield reaches the client as a shield impact on its sid', { timeout: 30_000 }, async () => {
    const parkedPid = randomUUID();
    const parked = (await harness.connectActive(parkedPid, {
      shipKind: 'heavy-cruiser', spawnX: 60, spawnY: HULL_Y, initialHull: 1_000_000, initialShield: 1_000_000,
    })) as ClientRoom<SectorState>;
    const server = harness.getServerRoom() as unknown as SectorRoom;
    let shipId = '';
    for (const [, s] of server.state.ships) if (s.playerId === parkedPid && s.isActive) shipId = s.shipInstanceId;
    parked.send('spectate', { type: 'spectate' });
    await waitUntil(() => server._internals.lingeringSlots.has(shipId), 3000, 'the hull is parked');

    const shooterPid = randomUUID();
    const shooter = (await harness.connectActive(shooterPid, {
      shipKind: 'interceptor', spawnX: 0, spawnY: 0, groupMode: 'manual',
    })) as ClientRoom<SectorState>;
    const obs = new ColyseusGameClient();
    const c = obs as unknown as ObserverInternals;
    c.predWorld = await PhysicsWorld.create();
    c.mirror.localPlayerId = 'observer';
    shooter.onStateChange((s) => c.syncMirror(s));
    shooter.onMessage('snapshot', (snap: SnapshotMessage) => c.handleSnapshot(snap));
    const hits: DamageEvent[] = [];
    shooter.onMessage('damage', (e: DamageEvent) => { if (e.targetId === shipId) hits.push(e); });
    const drone = [...server._internals.swarmRegistry.all()].find((r) => r.kind === 1)!;
    harness.lockTarget(shooterPid, drone.id);
    for (let i = 0; i < 4 && hits.length === 0; i++) {
      shooter.send('fire', {
        type: 'fire', tick: server._internals.serverTick, clientShotId: `s${i}`,
        weapon: 'hitscan', dirAngle: 0, slotId: 'primary',
      });
      await harness.advance(400);
    }
    const hit = hits.find((e) => e.hitLayer === 'shield');
    expect(hit, 'a shield-layer hit named by the hull sid').toBeDefined();
    const hull = c.mirror.ships.get(shipId);
    expect(hull, 'the hull is in the client ship list under its sid').toBeDefined();
    expect(hull!.shieldDown, 'its shield is drawn up').not.toBe(true);
    c.mirror.pendingEffectTriggers.length = 0;
    c.handleDamage(hit!);
    expect(c.mirror.pendingEffectTriggers).toContainEqual(
      expect.objectContaining({ kind: 'impact', tint: 0x88ddff, entityId: shipId }),
    );
  });
});

interface ObserverInternals {
  predWorld: PhysicsWorld | null;
  mirror: {
    localPlayerId: string | null;
    ships: Map<string, { shieldDown?: boolean }>;
    pendingEffectTriggers: Array<{ kind: string; tint?: number; entityId?: string }>;
  };
  syncMirror(state: unknown): void;
  handleSnapshot(snap: SnapshotMessage): void;
  handleDamage(evt: DamageEvent): void;
}

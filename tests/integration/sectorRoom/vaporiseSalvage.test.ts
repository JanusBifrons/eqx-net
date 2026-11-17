/**
 * Vaporised salvage, and hull salvage for every ship (owner 2026-11-15).
 *
 * - A ship a cut weapon vaporises (fracture v11) leaves ONE pod, as any kill
 *   does, with its hull's salvage × `VAPORISE_SALVAGE_MUL` ("the beam rendered
 *   the whole ship down").
 * - "Why would the player be special?": a player-flown ship drops the same
 *   kind-based hull loot an AI-flown one would, in the one pod with its hold,
 *   and the vaporise multiplier likewise.
 * - The pod sits beside the kill, off the killing beam's line, so the heavy
 *   beam's follow-through (`followThroughTicks`) never takes it.
 *
 * Expected numbers come from the same seeded roll the server uses
 * (`rollHullLoot`): an AI ship's seed is `<id>:<entityId>`, a player ship's its
 * shipInstanceId. loot-and-cargo.md "Hull salvage".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { DestroyEvent } from '../../../src/shared-types/messages.js';
import { getShipKind, type ShipKindId } from '../../../src/shared-types/shipKinds.js';
import { shipShapeScale } from '../../../src/core/geometry/shipHullOutline.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import { rollHullLoot } from '../../../src/server/cargo/hullLoot.js';
import { VAPORISE_SALVAGE_MUL } from '../../../src/shared-types/lootTables.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import type { Hold } from '../../../src/shared-types/goods.js';

type Internals = SectorRoom['_internals'];

describe('SectorRoom integration — vaporised salvage, every ship (owner 2026-11-15)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  async function boot(): Promise<{ int: Internals; destroys: DestroyEvent[] }> {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      capitalWrecks: true, subcapWrecks: true,
    });
    const observer = await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: -40_000, spawnY: -40_000 });
    const destroys: DestroyEvent[] = [];
    observer.onMessage('destroy', (m: DestroyEvent) => destroys.push(m));
    return { int: (harness.getServerRoom() as unknown as SectorRoom)._internals, destroys };
  }

  /** A heavy-beam shot across the hull from its starboard side. */
  function sideShot(kind: ShipKindId, x: number, y: number, angle: number, halfBeam: number) {
    const s = shipShapeScale(getShipKind(kind));
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    return { hitX: x + halfBeam * s * c, hitY: y + halfBeam * s * sn, dirX: -c, dirY: -sn };
  }

  function podHolds(int: Internals): Hold[] {
    return [...int.loot.podIds()].map((id) => getHoldStore().get(id)!.hold);
  }

  function activeShipId(pid: string): string {
    const room = harness!.getServerRoom() as unknown as SectorRoom;
    for (const [, s] of room.state.ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
    return '';
  }

  it('an AI-flown fighter vaporised by the heavy beam drops one pod with 1.5× its hull salvage; a normal kill 1×', async () => {
    const { int, destroys } = await boot();
    // A normal kill (no cut weapon): its hull roll, as today.
    expect(int.spawnTestDrone('nf', 6000, 0, 'fighter')).toBe(true);
    await harness!.advance(100);
    const nEid = int.swarmRegistry.get('nf')!.entityId;
    expect(int.applyDamage('nf', 'shooter-x', 1e7)).toBe(true);
    // Entity ids are recycled: wait for this kill's event before the next.
    for (let t = 0; t < 20 && !destroys.some((d) => d.targetId === `swarm-${nEid}`); t++) await harness!.advance(50);
    const normal = rollHullLoot(`nf:${nEid}`, 'fighter', false);
    expect(normal.goods.salvage ?? 0, 'a fighter hull rolls salvage').toBeGreaterThan(0);
    let pods = podHolds(int);
    expect(pods).toHaveLength(1);
    expect(pods[0]!.goods.salvage).toBe(normal.goods.salvage);

    // Vaporised: the same kind, the heavy beam across it.
    destroys.length = 0;
    expect(int.spawnTestDrone('vf', 14_000, 0, 'fighter')).toBe(true);
    await harness!.advance(100);
    const vEid = int.swarmRegistry.get('vf')!.entityId;
    const at = int.wreckState('vf')!;
    const shot = sideShot('fighter', at.x, at.y, at.angle, 10);
    expect(int.applyDamage('vf', 'shooter-x', 1e7, shot.hitX, shot.hitY, shot.dirX, shot.dirY, 'heavy_beam')).toBe(true);
    for (let t = 0; t < 20 && !destroys.some((d) => d.targetId === `swarm-${vEid}`); t++) await harness!.advance(50);
    expect(destroys.filter((d) => d.targetId === `swarm-${vEid}`).pop()?.vaporised,'the fighter was vaporised').toBe(true);
    const hull = rollHullLoot(`vf:${vEid}`, 'fighter', false);
    pods = podHolds(int);
    expect(pods, 'one pod per kill').toHaveLength(2);
    const vPod = pods[1]!; // pods list in drop order
    expect(vPod.goods.salvage, 'vaporised: 1.5× the hull salvage')
      .toBe(Math.round((hull.goods.salvage ?? 0) * VAPORISE_SALVAGE_MUL));
    // Only salvage scales.
    expect(vPod.goods.alloy).toBe(hull.goods.alloy);
  }, 30_000);

  it('a player-flown fighter killed normally drops its kind\'s hull loot AND its hold, in one pod', async () => {
    const { int } = await boot();
    const pid = randomUUID();
    await harness!.connectActive(pid, { shipKind: 'fighter', spawnX: 5000, spawnY: 0, initialCargo: { goods: { alloy: 3 }, blueprints: [] } });
    await harness!.advance(100);
    const shipId = activeShipId(pid);
    expect(shipId).not.toBe('');
    const before = int.loot.podCount();
    const room = harness!.getServerRoom() as unknown as SectorRoom;
    for (let i = 0; i < 10 && room.state.ships.get(shipId)?.alive !== false; i++) int.applyDamage(pid, 'killer', 99_999);
    const hull = rollHullLoot(shipId, 'fighter', false);
    expect(hull.goods.salvage ?? 0).toBeGreaterThan(0);
    expect(int.loot.podCount(), 'one pod').toBe(before + 1);
    const pod = podHolds(int)[0]!;
    expect(pod.goods.salvage, 'the hull salvage').toBe(hull.goods.salvage);
    expect(pod.goods.alloy, 'the hold, plus the hull roll').toBe(3 + (hull.goods.alloy ?? 0));
    expect(getHoldStore().get(shipId), 'the dead ship keeps nothing').toBeUndefined();
  }, 30_000);

  it('a vaporised player-flown fighter drops 1.5× its hull salvage plus its hold', async () => {
    const { int, destroys } = await boot();
    const pid = randomUUID();
    await harness!.connectActive(pid, { shipKind: 'fighter', spawnX: 5000, spawnY: 0, initialCargo: { goods: { alloy: 3 }, blueprints: [] } });
    await harness!.advance(100);
    const shipId = activeShipId(pid);
    const pose = int.wreckState(pid) ?? { x: 5000, y: 0, angle: 0 };
    const shot = sideShot('fighter', pose.x, pose.y, pose.angle, 10);
    // The shield takes the first hit whole; the second kills.
    expect(int.applyDamage(pid, 'shooter-x', 1e7, shot.hitX, shot.hitY, shot.dirX, shot.dirY, 'heavy_beam')).toBe(false);
    expect(int.applyDamage(pid, 'shooter-x', 1e7, shot.hitX, shot.hitY, shot.dirX, shot.dirY, 'heavy_beam')).toBe(true);
    for (let t = 0; t < 20 && !destroys.some((d) => d.targetId === pid); t++) await harness!.advance(50);
    expect(destroys.find((d) => d.targetId === pid)?.vaporised).toBe(true);
    const hull = rollHullLoot(shipId, 'fighter', false);
    const pods = podHolds(int);
    expect(pods, 'one pod').toHaveLength(1);
    expect(pods[0]!.goods.salvage).toBe(Math.round((hull.goods.salvage ?? 0) * VAPORISE_SALVAGE_MUL));
    expect(pods[0]!.goods.alloy).toBe(3 + (hull.goods.alloy ?? 0));
  }, 30_000);

  it('an AI beam cruiser vaporises a pilot fighter: the pod sits off the kill line and survives the follow-through', { timeout: 20_000 }, async () => {
    const kind = getShipKind('heavy-cruiser-beam');
    const beamMounts = new Set(kind.mounts.filter((m) => m.weaponId === 'heavy_beam').map((m) => m.id));
    const beam = getWeapon('heavy_beam');
    const follow = beam.followThroughTicks ?? 0;
    expect(follow).toBeGreaterThan(0);
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      capitalWrecks: true, subcapWrecks: true, traverseTicksCap: 0, lockTimeCapS: 0,
      // Heading π: starboard faces −x, at the pilot (the beamFits setup).
      dronePoses: [{ kind: 'heavy-cruiser-beam', x: 5000, y: 0, angle: Math.PI }],
    });
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      shipKind: 'fighter', initialHull: 100, initialShield: 0, startHostile: true, instantLock: true,
      initialCargo: { goods: { alloy: 3 }, blueprints: [] },
    });
    interface LaserFired { mountId?: string; fromX: number; fromY: number; toX: number; toY: number; hit: boolean; targetId?: string }
    const beams: LaserFired[] = [];
    cr.onMessage('laser_fired', (m: LaserFired) => { if (m.mountId && beamMounts.has(m.mountId)) beams.push(m); });
    const destroys: DestroyEvent[] = [];
    cr.onMessage('destroy', (m: DestroyEvent) => destroys.push(m));
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const int = room._internals;
    const shipId = activeShipId(pid);

    const d1 = Date.now() + 8_000;
    while (Date.now() < d1 && !destroys.some((d) => d.targetId === pid)) await harness.advance(20);
    const kill = destroys.find((d) => d.targetId === pid);
    expect(kill, 'the cruiser killed the pilot').toBeDefined();
    expect(kill!.vaporised, 'the heavy beam vaporised the fighter').toBe(true);
    const killShot = beams.filter((b) => b.hit && b.targetId === pid).pop()!;
    expect(killShot, 'the kill was a heavy-beam hit').toBeDefined();
    const pods = [...int.loot.podIds()];
    expect(pods, 'one pod').toHaveLength(1);
    const podId = pods[0]!;
    const podBefore = getHoldStore().get(podId)!;
    const hull = rollHullLoot(shipId, 'fighter', false);
    expect(podBefore.hold.goods.salvage).toBe(Math.round((hull.goods.salvage ?? 0) * VAPORISE_SALVAGE_MUL));
    expect(podBefore.hold.goods.alloy).toBe(3 + (hull.goods.alloy ?? 0));
    // Off the killing beam's line by more than the pod's own radius.
    const lx = killShot.toX - killShot.fromX, ly = killShot.toY - killShot.fromY;
    const ll = Math.hypot(lx, ly);
    const perp = Math.abs((podBefore.x! - killShot.fromX) * ly - (podBefore.y! - killShot.fromY) * lx) / ll;
    expect(perp, 'the pod sits off the kill line').toBeGreaterThan(getShipKind('cargo-pod').radius);

    // Through the follow-through window (and a margin): the pod lives on, whole.
    const nBeams = beams.length;
    const t0 = room._internals.serverTick;
    const d2 = Date.now() + 8_000;
    while (Date.now() < d2 && room._internals.serverTick < t0 + follow + 15) await harness.advance(20);
    expect(beams.length, 'the follow-through beam fired').toBeGreaterThan(nBeams);
    expect(int.loot.isPod(podId), 'the pod survived the follow-through').toBe(true);
    expect(getHoldStore().get(podId)!.hold.goods).toEqual(podBefore.hold.goods);
  });
});

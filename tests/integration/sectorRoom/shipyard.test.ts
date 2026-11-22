/**
 * Economy v2 W5b (plan peppy-jumping-pinwheel) — the SHIPYARD and the
 * ship-picker gate, through a real SectorRoom and the real messages.
 *
 *  1. A powered Shipyard with a gunship blueprint loaded (`set_recipe` +
 *     `load_blueprint`) builds a gunship: a live hull in its owner's fleet
 *     (no crate). It appears on the slipway inside the frame, nose out of the
 *     bow, with the owner's ordinary Move order to a parking spot clear of the
 *     yard, and flies out without touching the frame (loop 3M).
 *  1b. (loop 3R) Builds fill the slipway's bays in turn (0, 1, 2, …), each
 *     hull starting on its bay's keel; the yard's current bay rides its room
 *     state row (`prodBay`) so a late joiner reads it.
 *  2. Unpacking a packed gunship crate (`unpack_hull`) adds one to the roster
 *     and parks it in the world too.
 *  3. The picker gate: a FRESH spawn asking for a gunship gets a starter
 *     fighter (and a notice); resuming the OWNED gunship by its roster id
 *     spawns the gunship.
 *
 * Layout: Capital (0,0) → Connector (0,-380) → Shipyard (0,-790), a hub that
 * also links the fuelled Reactor (650,0) and the Cargo Bay (-550,0), which is
 * the base's storage. (A Capital links only through Connectors; a grid island
 * without a Capital is unpowered.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getPlayerShipStore } from '../../../src/server/db/PersistenceWorker.js';
import { RECIPES } from '../../../src/shared-types/recipes.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { getStructureKind } from '../../../src/shared-types/structureKinds.js';
import { worldToLocal } from '../../../src/core/structures/gateGeometry.js';
import { SHIPYARD_BAY_COUNT, SHIPYARD_SLIP_HALF_W, shipyardBayKeel } from '../../../src/core/articulation/rigs/heavyIndustry.js';
import { decodeProdBay } from '../../../src/shared-types/production.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — Shipyard + hull gate (economy v2 W5b)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('a powered Shipyard builds a gunship into the owner’s fleet: a new hull starts in the yard with a move order, it leaves the frame without colliding; an unpacked crate parks too', { timeout: 90_000 }, async () => {
    const owner = randomUUID();
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 0, y: -380 },
        // Every link goes through a Connector: the reactor and cargo bay join
        // via their own relays, never straight onto the shipyard.
        { kind: 'connector', x: 450, y: -350 },
        { kind: 'connector', x: -450, y: -350 },
        { kind: 'reactor', x: 650, y: 50 },
        { kind: 'cargo_bay', x: -550, y: 0 },
        { kind: 'shipyard', x: 0, y: -790 },
      ],
      prebuiltStructuresOwner: owner,
      defaultSpawnX: 0,
      defaultSpawnY: 1500,
    });
    const cr = await harness.connectActive(owner, { spawnX: 0, spawnY: 1500, shipKind: 'fighter' });
    const internals = harness.getServerRoom()!._internals;
    const all = [...internals.structureRegistry.all()];
    const yard = all.find((r) => r.kind === 'shipyard')!;
    const bay = all.find((r) => r.kind === 'cargo_bay')!;
    const capital = all.find((r) => r.kind === 'capital')!;
    expect(yard && bay && capital, 'layout seeded').toBeTruthy();
    const yardEid = internals.swarmRegistry.get(yard.id)!.entityId;
    capital.hold = { goods: {}, blueprints: [] };
    bay.hold = {
      goods: { fuel: 200, alloy: 40, components: 12, electronics: 6, machinery: 2 },
      blueprints: [{ uid: 'bp-gunship', product: 'hull:gunship', kind: 'bpc', runs: 2, material: 0, output: 0, research: 0 }],
    };

    cr.send('set_recipe', { type: 'set_recipe', entityId: yardEid, recipe: 'build_gunship' });
    await harness.advance(200);
    expect(yard.recipe).toBe('build_gunship');
    cr.send('load_blueprint', { type: 'load_blueprint', entityId: yardEid });
    await harness.advance(200);
    expect(yard.blueprint?.product).toBe('hull:gunship');

    const packedHulls = (): number =>
      [...(bay.hold?.packed ?? []), ...(capital.hold?.packed ?? [])].filter((p) => p.product === 'hull:gunship').length;
    const gunships = (): string[] => getPlayerShipStore().listByPlayer(owner).filter((r) => r.kind === 'gunship').map((r) => r.shipId);
    for (let i = 0; i < RECIPES.build_gunship.cyclePulses * 3 && gunships().length === 0; i++) internals.pulseStructureGrid();
    const built = gunships();
    expect(built, 'the Shipyard built a gunship into the roster').toHaveLength(1);
    expect(packedHulls(), 'no crate: the hull went straight into the world').toBe(0);
    const hullId = built[0]!;
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const hull = (room.state as SectorState).ships.get(hullId);
    expect(hull?.playerId).toBe(owner);
    expect(hull?.isActive, 'a lingering hull, flown by its AI pilot').toBe(false);
    expect(internals.lingeringSlots.has(hullId)).toBe(true);
    expect(internals.fleet.isAttached(hullId), 'in the owner’s fleet (Command view)').toBe(true);

    // Loop 3M — a new hull starts in the yard with a move order.
    const fp = getStructureKind('shipyard').footprint!;
    const yardAngle = ((yard.rot ?? 0) * Math.PI) / 180;
    const local = (x: number, y: number) => worldToLocal(yard.x, yard.y, yardAngle, x, y, { x: 0, y: 0 });
    const inFrame = (l: { x: number; y: number }) => Math.abs(l.x) < fp.w / 2 && Math.abs(l.y) < fp.h / 2;
    const r = getShipKind('gunship').radius;
    const row = getPlayerShipStore().get(hullId)!;
    const start = local(row.lastX, row.lastY);
    expect(inFrame(start), 'printed inside the frame').toBe(true);
    expect(Math.abs(start.y) + r, 'on the slipway').toBeLessThan(SHIPYARD_SLIP_HALF_W);
    const pose0 = internals.lingeringPoseCache.get(hullId)!;
    expect(-Math.sin(pose0.angle), 'nose out of the bow').toBeCloseTo(Math.cos(yardAngle), 2);
    expect(Math.cos(pose0.angle), 'nose out of the bow').toBeCloseTo(Math.sin(yardAngle), 2);
    const order = internals.fleet.ordersOf(hullId)?.order;
    expect(order?.kind, 'the owner’s ordinary Move order').toBe('move');
    const dest = order as unknown as { x: number; y: number };
    expect(inFrame(local(dest.x, dest.y)), 'its parking spot is clear of the yard').toBe(false);

    // Loop 3M — it leaves the frame without colliding: while inside the
    // footprint it stays on the open slipway, and it takes no ram damage.
    const health0 = hull!.health;
    let out = false;
    for (let t = 0; t < 30_000 && !out; t += 250) {
      await harness.advance(250);
      const p = internals.lingeringPoseCache.get(hullId)!;
      const l = local(p.x, p.y);
      if (inFrame(l)) expect(Math.abs(l.y), `in the frame at local (${l.x.toFixed(0)}, ${l.y.toFixed(0)}): still on the slip`).toBeLessThan(SHIPYARD_SLIP_HALF_W);
      else out = true;
    }
    expect(out, 'the new hull flew out of the frame').toBe(true);
    expect((room.state as SectorState).ships.get(hullId)!.health, 'no collision on the way out').toBe(health0);

    // A packed crate (e.g. bought or looted) unpacks the same way (the real client payload, with `type`).
    (bay.hold!.packed ??= []).push({ product: 'hull:gunship', quality: 40 });
    const where = bay;
    const results: Array<{ ok: boolean; message: string }> = [];
    cr.onMessage('blueprint_result', (m: { ok: boolean; message: string }) => results.push(m));
    cr.send('unpack_hull', { type: 'unpack_hull', networkEntityId: internals.swarmRegistry.get(where.id)!.entityId, kind: 'gunship' });
    await harness.advance(300);
    expect(results[0]?.ok, results[0]?.message).toBe(true);
    const unpacked = gunships().find((id) => id !== hullId);
    expect(unpacked).toBeDefined();
    expect(internals.lingeringSlots.has(unpacked!), 'the unpacked hull is parked in the world too').toBe(true);
  });

  it('loop 3R: builds go to bays 0,1,2 in turn, each hull on its bay keel; the bay reaches a late joiner via state', { timeout: 90_000 }, async () => {
    const owner = randomUUID();
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 0, y: -380 },
        { kind: 'connector', x: 450, y: -350 },
        { kind: 'connector', x: -450, y: -350 },
        { kind: 'reactor', x: 650, y: 50 },
        { kind: 'cargo_bay', x: -550, y: 0 },
        { kind: 'shipyard', x: 0, y: -790 },
      ],
      prebuiltStructuresOwner: owner,
      defaultSpawnX: 0,
      defaultSpawnY: 1500,
    });
    const cr = await harness.connectActive(owner, { spawnX: 0, spawnY: 1500, shipKind: 'fighter' });
    const internals = harness.getServerRoom()!._internals;
    const all = [...internals.structureRegistry.all()];
    const yard = all.find((r) => r.kind === 'shipyard')!;
    const bay = all.find((r) => r.kind === 'cargo_bay')!;
    const capital = all.find((r) => r.kind === 'capital')!;
    const yardEid = internals.swarmRegistry.get(yard.id)!.entityId;
    capital.hold = { goods: {}, blueprints: [] };
    bay.hold = {
      goods: { fuel: 400, alloy: 80, components: 30, electronics: 15, machinery: 5 },
      blueprints: [{ uid: 'bp-gunship', product: 'hull:gunship', kind: 'bpo', runs: null, material: 0, output: 0, research: 0 }],
    };
    cr.send('set_recipe', { type: 'set_recipe', entityId: yardEid, recipe: 'build_gunship' });
    await harness.advance(200);
    cr.send('load_blueprint', { type: 'load_blueprint', entityId: yardEid });
    await harness.advance(200);
    expect(yard.blueprint?.product).toBe('hull:gunship');

    const yardAngle = ((yard.rot ?? 0) * Math.PI) / 180;
    const gunships = (): string[] => getPlayerShipStore().listByPlayer(owner).filter((r) => r.kind === 'gunship').map((r) => r.shipId);
    const startBays: number[] = [];
    const seen = new Set<string>();
    const out = { bay: -1, queued: -1 };
    for (let n = 0; n < 3; n++) {
      const before = gunships().length;
      for (let i = 0; i < RECIPES.build_gunship.cyclePulses * 3 && gunships().length === before; i++) internals.pulseStructureGrid();
      const ids = gunships();
      expect(ids, `build ${n} finished`).toHaveLength(before + 1);
      const newId = ids.find((id) => !seen.has(id))!;
      seen.add(newId);
      const row = getPlayerShipStore().get(newId)!;
      const l = worldToLocal(yard.x, yard.y, yardAngle, row.lastX, row.lastY, { x: 0, y: 0 });
      let found = -1;
      for (let b = 0; b < SHIPYARD_BAY_COUNT; b++) if (Math.abs(shipyardBayKeel(b).x - l.x) < 1 && Math.abs(l.y) < 1) found = b;
      startBays.push(found);
    }
    expect(startBays, 'each hull starts on the keel of the next bay').toEqual([0, 1, 2]);

    // A client joining now reads the yard's current bay (the 4th build: bay 3) from room state.
    await harness.advance(300);
    const late = await harness.connectActive(randomUUID(), { spawnX: 0, spawnY: 2000, shipKind: 'fighter' });
    await harness.advance(300);
    const lateRow = (late.state as unknown as SectorState).structures.get(String(yardEid)) as { prodBay?: number } | undefined;
    expect(lateRow).toBeDefined();
    expect(decodeProdBay(lateRow!.prodBay, out)).toEqual({ bay: 3, queued: 0 });
  });

  it('the picker gate: a fresh gunship request gets a fighter; the OWNED gunship spawns as a gunship', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [], enforceHullGate: true,
    });
    const pid = randomUUID();
    const kindOf = (): string => {
      const room = harness.getServerRoom() as unknown as SectorRoom;
      for (const [, s] of (room.state as SectorState).ships) if (s.playerId === pid && s.isActive) return s.kind;
      return '';
    };

    // A fresh request for a non-starter hull: refused down to a fighter.
    const a = await harness.connectActive(pid, { spawnX: 0, spawnY: 0, shipKind: 'gunship', isNewShip: true });
    expect(kindOf()).toBe('fighter');
    await a.leave();
    await harness.advance(300);

    // An owned gunship (e.g. one you unpacked) is picked by its roster id.
    // Quality 100 (an unpacked top-quality hull) ⇒ +10 % max hull.
    const owned = getPlayerShipStore().create({ playerId: pid, userId: null, kind: 'gunship', sectorKey: 'sol-prime', x: 300, y: 300, health: 210, hullQuality: 100 });
    await harness.connectActive(pid, { spawnX: 0, spawnY: 0, shipId: owned.shipId });
    expect(kindOf()).toBe('gunship');
    const room = harness.getServerRoom() as unknown as SectorRoom;
    let max = 0;
    for (const [, s] of (room.state as SectorState).ships) if (s.playerId === pid && s.isActive) max = s.maxHealth;
    expect(max).toBe(Math.round(getShipKind('gunship').maxHealth * 1.1));
  });
});

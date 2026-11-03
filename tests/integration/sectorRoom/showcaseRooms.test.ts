/**
 * Showcase capture rooms (src/server/rooms/showcaseRooms.ts) stage what the
 * showcase video's shot list claims, and the `initialXp` bespoke trigger turns
 * a single kill into a level-up. Boots the EXACT options `index.ts` registers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import { getPlayerShipStore, getWallet } from '../../../src/server/db/PersistenceWorker.js';
import { getDroneMaxHealth } from '../../../src/server/rooms/droneKindHelpers.js';
import { xpForKill, xpToNext } from '../../../src/core/leveling/shipXp.js';
import {
  SHOWCASE_BASE_OPTS,
  SHOWCASE_BOUNTY_OPTS,
  SHOWCASE_HOMESTEAD_OPTS,
  SHOWCASE_DEFENCE_OPTS,
  SHOWCASE_PILOT_ID,
  SHOWCASE_LEVELUP_OPTS,
  SHOWCASE_SHIP_GALLERY_OPTS,
  SHOWCASE_TELEPORT_OPTS,
  SHOWCASE_GARRISON_OPTS,
  SHOWCASE_HUB_OPTS,
  SHOWCASE_PORT_PAD,
} from '../../../src/server/rooms/showcaseRooms.js';

function roomOf(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

/** Deep-mutable copy — the harness takes plain (non-readonly) option objects. */
function opts<T>(o: T): Record<string, unknown> {
  return structuredClone(o) as unknown as Record<string, unknown>;
}

describe('Showcase rooms', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  /** Drive the 10 Hz teleporter tick until the pilot's ship reaches (x, y). */
  async function rideTo(internals: SectorRoom['_internals'], pilot: string, x: number, y: number): Promise<boolean> {
    for (let i = 0; i < 400; i++) {
      internals.tickStructureTurrets();
      await harness.advance(40);
      const p = internals.playerPose(pilot);
      if (p && Math.hypot(p.x - x, p.y - y) < 400) return true;
    }
    return false;
  }

  it('v4 T2: the teleport room carries a pilot on the west pad to the east pad, by itself', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_TELEPORT_OPTS));
    const pilot = randomUUID();
    const cr = await harness.connectActive(pilot, { spawnX: -1300, spawnY: -60 });
    const internals = roomOf(cr.roomId)._internals;
    expect(await rideTo(internals, pilot, 1300, -60), 'arrived on the east pad').toBe(true);
  });

  it('v4 M2: the garrison flies a faction patrol', { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_GARRISON_OPTS));
    const cr = await harness.connectActive(randomUUID());
    const internals = roomOf(cr.roomId)._internals;
    internals.pulseStructureGrid(); // patrol ships launch on the first pulse
    const patrols = [...internals.swarmRegistry.all()].filter((r) => r.id.startsWith('patrol-'));
    expect(patrols.length).toBe(4);
    expect(patrols.every((r) => r.shipKind === 'patrol-fighter')).toBe(true);
  });

  it('v4 M2: a pilot attacking the garrison\'s outer fence from the spawn draws the patrol', { timeout: 30_000 }, async () => {
    // Showcase capture 2026-11-03: the patrol ignored a pilot shooting at the
    // fence, because the range was measured from the base's centre.
    harness = await bootSectorTestServer(opts(SHOWCASE_GARRISON_OPTS));
    const pilot = randomUUID();
    const cr = await harness.connectActive(pilot);
    const internals = roomOf(cr.roomId)._internals;
    const aggro: string[] = [];
    cr.onMessage('bot_aggro', (m: { targetPlayerId: string }) => aggro.push(m.targetPlayerId));
    internals.pulseStructureGrid();
    const south = [...internals.structureRegistry.all()].filter((r) => r.owner === 'npc:core:mil').sort((a, b) => a.y - b.y)[0]!;
    internals.applyDamage(south.id, pilot, 10);
    for (let i = 0; i < 3 && aggro.length === 0; i++) {
      internals.pulseStructureGrid();
      await harness.advance(250);
    }
    expect(aggro).toContain(pilot);
  });

  it('v4 M2: once the pilot attacks, the patrol actually shoots it', { timeout: 60_000 }, async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_GARRISON_OPTS));
    const pilot = randomUUID();
    const cr = await harness.connectActive(pilot, { initialHull: 100_000 });
    const internals = roomOf(cr.roomId)._internals;
    const hits: string[] = [];
    cr.onMessage('damage', (m: { targetId?: string; shooterId?: string }) => {
      if (m.targetId === pilot && typeof m.shooterId === 'string') hits.push(m.shooterId);
    });
    internals.pulseStructureGrid();
    const south = [...internals.structureRegistry.all()].filter((r) => r.owner === 'npc:core:mil').sort((a, b) => a.y - b.y)[0]!;
    internals.applyDamage(south.id, pilot, 10);
    for (let i = 0; i < 40 && !hits.some((h) => h.startsWith('patrol-')); i++) {
      internals.pulseStructureGrid();
      await harness.advance(500);
    }
    expect(hits.some((h) => h.startsWith('patrol-')), `hits on the pilot: ${[...new Set(hits)].join(', ') || 'none'}`).toBe(true);
  });

  it('v4 H: the hub room links its two pads and carries a paying pilot to the port', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_HUB_OPTS));
    const pilot = randomUUID();
    const cr = await harness.connectActive(pilot, { initialWallet: 1000 });
    const internals = roomOf(cr.roomId)._internals;
    const ends = [...internals.structureRegistry.all()].filter((r) => r.npcLink !== undefined);
    expect(ends.length).toBe(2);
    cr.onMessage('teleport_toll', (m: { padId: number }) => {
      cr.send('teleport_toll_answer', { type: 'teleport_toll_answer', padId: m.padId, answer: 'pay' });
    });
    expect(await rideTo(internals, pilot, SHOWCASE_PORT_PAD.x, SHOWCASE_PORT_PAD.y), 'arrived at the port').toBe(true);
    expect(ends[0]!.tpPartner?.uid).toBe(ends[1]!.uid);
    expect(getWallet().balance(pilot)).toBeLessThan(1000);
  });

  it('ship gallery seeds the six player ship kinds', async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_SHIP_GALLERY_OPTS));
    const cr = await harness.connectAs('gallery-viewer');
    const internals = roomOf(cr.roomId)._internals;
    const kinds = [...internals.swarmRegistry.all()].filter((r) => r.kind === 1).map((r) => r.shipKind).sort();
    expect(kinds).toEqual(['fighter', 'gunship', 'heavy', 'interceptor', 'missile-frigate', 'scout']);
  });

  it('showcase base is owned by the showcase pilot, built and powered', async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_BASE_OPTS));
    const cr = await harness.connectAs('base-viewer');
    const internals = roomOf(cr.roomId)._internals;
    const structures = [...internals.structureRegistry.all()];
    expect(structures.length).toBe(SHOWCASE_BASE_OPTS.prebuiltStructures.length);
    for (const s of structures) {
      expect(s.isConstructed).toBe(true);
      expect(s.owner).toBe(SHOWCASE_PILOT_ID);
    }
    internals.pulseStructureGrid();
    for (const s of internals.getStructuresSlice() ?? []) expect(s.powered).toBe(true);
  });

  it('defence base is built, powered, raises a shield wall and fields a drone pack', async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_DEFENCE_OPTS));
    const cr = await harness.connectAs('defender');
    const internals = roomOf(cr.roomId)._internals;

    const structures = [...internals.structureRegistry.all()];
    expect(structures.length).toBe(SHOWCASE_DEFENCE_OPTS.prebuiltStructures.length);
    for (const s of structures) expect(s.isConstructed).toBe(true);

    internals.pulseStructureGrid();
    const slice = internals.getStructuresSlice() ?? [];
    // Every structure is on ONE powered grid (no stranded leaf).
    expect(slice.length).toBe(structures.length);
    for (const s of slice) expect(s.powered).toBe(true);
    // The two pylons project an ACTIVE wall between them.
    const walls = slice.filter((s) => s.shieldWallTo !== undefined);
    expect(walls.length).toBeGreaterThan(0);
    expect(walls.every((w) => w.wallActive === true)).toBe(true);

    const drones = [...internals.swarmRegistry.all()].filter((r) => r.kind === 1);
    expect(drones.length).toBe(SHOWCASE_DEFENCE_OPTS.dronePoses.length);
  });

  it('initialXp + one kill levels the ship up', async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_LEVELUP_OPTS));
    const killer = randomUUID();
    const gain = xpForKill(getDroneMaxHealth('heavy')!);
    const initialXp = xpToNext(1) - gain; // one heavy kill crosses the threshold
    const cr = await harness.connectActive(killer, { shipKind: 'interceptor', initialXp });
    const room = roomOf(cr.roomId);
    const state = (room as unknown as { state: SectorState }).state;
    let instanceId = '';
    for (const [id, ship] of state.ships) if (ship.playerId === killer && ship.isActive) instanceId = id;
    expect(instanceId).not.toBe('');
    expect(getPlayerShipStore().get(instanceId)!.xp).toBe(initialXp);
    expect(getPlayerShipStore().get(instanceId)!.level).toBe(1);

    const target = [...room._internals.swarmRegistry.all()].find((r) => r.kind === 1)!;
    room._internals.applyDamage(target.id, killer, 99_999);

    expect(getPlayerShipStore().get(instanceId)!.level).toBe(2);
    expect(state.ships.get(instanceId)!.level).toBe(2);
  });

  it('bounty room: a named elite on cue pays its bounty into the killer wallet', async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_BOUNTY_OPTS));
    const hunter = randomUUID();
    const cr = await harness.connectActive(hunter, { shipKind: 'interceptor' });
    const room = roomOf(cr.roomId);
    const elite = [...room._internals.swarmRegistry.all()].find((r) => r.elite !== undefined)!;
    expect(elite.elite!.name).toBe('Kestrel Vane');
    const before = getWallet().balance(hunter);
    for (let i = 0; i < 10 && room._internals.swarmRegistry.get(elite.id); i++) room._internals.applyDamage(elite.id, hunter, 99_999);
    expect(room._internals.swarmRegistry.get(elite.id) ?? null).toBeNull();
    expect(getWallet().balance(hunter) - before).toBeGreaterThanOrEqual(elite.elite!.bounty ?? 1);
  });

  it('homestead: the pilot owns a powered base with a miner on its asteroid', async () => {
    harness = await bootSectorTestServer(opts(SHOWCASE_HOMESTEAD_OPTS));
    const cr = await harness.connectAs(randomUUID());
    const internals = roomOf(cr.roomId)._internals;
    const structures = [...internals.structureRegistry.all()];
    expect(structures.every((s) => s.owner === SHOWCASE_PILOT_ID && s.isConstructed)).toBe(true);
    expect(structures.some((s) => s.kind === 'miner')).toBe(true);
    internals.pulseStructureGrid();
    for (const s of internals.getStructuresSlice() ?? []) expect(s.powered).toBe(true);
  });
});

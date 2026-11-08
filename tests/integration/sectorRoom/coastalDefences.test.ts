/**
 * Coastal defences (plan coastal-defences) through a real SectorRoom: the
 * showcase gun line — every battery from the quad AA to the 80 cm siege gun,
 * owned by the pilot and powered by Reactors — builds, links, powers up and
 * opens fire, each gun on the target its calibre prefers, and the server
 * sends the turning barrels' angles to the client (the only writer, #12).
 * Boots the EXACT options the showcase registers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { SHOWCASE_COASTAL_OPTS, SHOWCASE_PILOT_ID } from '../../../src/server/rooms/showcaseRooms.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { COASTAL_DEFENCE_KINDS } from '../../../src/shared-types/structureKinds.js';

describe('SectorRoom integration — coastal defences', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('the gun line powers up, every battery opens fire, and its barrels ride the snapshot', { timeout: 90_000 }, async () => {
    harness = await bootSectorTestServer(structuredClone(SHOWCASE_COASTAL_OPTS) as unknown as Record<string, unknown>);
    const cr = await harness.connectActive(SHOWCASE_PILOT_ID === '' ? randomUUID() : randomUUID(), { initialHull: 1_000_000 });
    const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom;
    const internal = room._internals;

    // Every gun is built, linked and powered.
    for (let i = 0; i < 5; i++) internal.pulseStructureGrid();
    internal.rebuildStructuresSlice();
    const rows = internal.getStructuresSlice() ?? [];
    const guns = [...internal.structureRegistry.all()].filter((r) => (COASTAL_DEFENCE_KINDS as readonly string[]).includes(r.kind));
    expect(guns.map((g) => g.kind).sort()).toEqual([...COASTAL_DEFENCE_KINDS].sort());
    const adj = internal.structureRegistry.adjacencyMap();
    for (const g of guns) {
      expect(g.isConstructed, `${g.kind} built`).toBe(true);
      expect((adj.get(g.id) ?? []).length, `${g.kind} linked`).toBeGreaterThan(0);
    }
    expect(rows.filter((r) => (COASTAL_DEFENCE_KINDS as readonly string[]).includes(r.kind as string)).every((r) => r.powered), 'all powered').toBe(true);

    // Watch the snapshots: which shells fly, and the server's mount angles.
    const seen = new Set<string>();
    let maxXl = 0;
    let anglesSeen = 0;
    cr.onMessage('snapshot', (snap: SnapshotMessage) => {
      let xl = 0;
      for (const p of snap.projectiles ?? []) {
        if (p.weaponId) seen.add(p.weaponId);
        if (p.weaponId === 'naval_xl') xl++;
      }
      maxXl = Math.max(maxXl, xl);
      if ((snap.structureMountAngles?.length ?? 0) > 0) anglesSeen++;
    });
    // Every battery fires (server side: the super-guns' shells fly far from
    // the pilot, outside its snapshot interest, so read the guns themselves).
    const deadline = Date.now() + 70_000;
    const allFired = () => guns.every((g) => g.lastTurretFireMs !== undefined);
    while (Date.now() < deadline && !(allFired() && seen.has('naval_xl'))) await new Promise((r) => setTimeout(r, 200));
    for (const g of guns) expect(g.lastTurretFireMs, `${g.kind} fired`).toBeDefined();
    // And the shells the pilot can see are the batteries' own calibres.
    for (const w of ['autocannon', 'naval_s', 'naval_m', 'naval_l', 'naval_xl']) expect(seen.has(w), `a ${w} shell flew (seen: ${[...seen].join(', ')})`).toBe(true);
    expect(maxXl, 'the 16" barbette fires a two-shell salvo').toBeGreaterThanOrEqual(2);
    expect(anglesSeen, 'the turning barrels ride the snapshot').toBeGreaterThan(0);
  });
});

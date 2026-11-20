/**
 * restyle/bay-reach — a ship parked on its own Capital's crane bay is "at"
 * that Capital for module install and repair (`nearStorage`: the deposit
 * circle OR the structure's own crane bay). The bay is the Capital's only
 * drop-off (3f) and lies past the 400 u circle (centre 410 u out, far edge
 * 490), so a pilot who parks at home to unload must be able to repair and
 * install there too. A ship 600 u off the Capital's side (not on the bay)
 * still can't.
 *
 * Capital at (0, 0), rot 0: its bay is `CAPITAL.keepClear`, centre world
 * (0, 410) (`CAPITAL_BAY`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Room } from 'colyseus.js';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { StructureRecord } from '../../../src/server/structures/StructureRegistry.js';
import type { BlueprintResult } from '../../../src/shared-types/blueprints.js';
import { legacyBlueprintItem } from '../../../src/shared-types/items.js';
import { CAPITAL_BAY, DOCK_BAY_INSET } from '../../../src/core/articulation/rigCatalogue.js';

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

/** The bay's far edge (5 u inside the served band): 485 u from the centre. */
const FAR_Y = CAPITAL_BAY.cy + CAPITAL_BAY.padHalfH - DOCK_BAY_INSET - 5;

describe('SectorRoom integration — repair and install from the Capital\'s crane bay', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  async function boot(x: number, y: number): Promise<{ cr: Room<SectorState>; cap: StructureRecord; shipId: string; capEid: number }> {
    const pid = randomUUID();
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
    // Ship first, then the Capital placed around it (a join never spawns
    // within a hull's clearance of a structure; the bay is closer than that).
    const cr = await harness.connectActive(pid, { spawnX: x, spawnY: y, shipKind: 'fighter', initialHull: 50, initialWallet: 1000 });
    let shipId = '';
    expect(await until(() => {
      for (const [, s] of cr.state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;
      return shipId !== '';
    }, 3_000)).toBe(true);
    const room = harness.getServerRoom()!;
    const reg = room._internals.structureRegistry;
    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y: 0 });
    expect(await until(() => [...reg.all()].some((r) => r.owner === pid && r.kind === 'capital'), 5_000)).toBe(true);
    const cap = [...reg.all()].find((r) => r.owner === pid && r.kind === 'capital')!;
    cap.hold = { goods: {}, blueprints: [legacyBlueprintItem('bp-reinforced-hull')] };
    const capEid = room._internals.swarmRegistry.get(cap.id)!.entityId;
    return { cr, cap, shipId, capEid };
  }

  async function install(cr: Room<SectorState>, capEid: number): Promise<BlueprintResult> {
    let res: BlueprintResult | undefined;
    cr.onMessage('blueprint_result', (m: BlueprintResult) => { res = m; });
    cr.send('install_blueprint', { type: 'install_blueprint', networkEntityId: capEid, blueprintId: 'bp-reinforced-hull' });
    expect(await until(() => res !== undefined, 4_000)).toBe(true);
    return res!;
  }

  function healthOf(shipId: string): number {
    return harness!.getServerRoom()!.state.ships.get(shipId)!.health;
  }

  for (const [label, x, y] of [['the bay centre', 0, CAPITAL_BAY.cy], ['the bay\'s far edge', 0, FAR_Y]] as const) {
    it(`a ship parked on ${label} (${Math.round(Math.hypot(x, y))} u out) can repair and install`, { timeout: 40_000 }, async () => {
      expect(Math.hypot(x, y), 'past the 400 u circle').toBeGreaterThan(400);
      const { cr, shipId, capEid } = await boot(x, y);
      cr.send('repair_ship', { type: 'repair_ship' });
      expect(await until(() => healthOf(shipId) > 50, 5_000), 'repair at home').toBe(true);
      const r = await install(cr, capEid);
      expect(r.ok, r.message).toBe(true);
    });
  }

  it('a ship 600 u off the Capital\'s side (not on the bay) can neither repair nor install', { timeout: 40_000 }, async () => {
    const { cr, shipId, capEid } = await boot(600, 0);
    cr.send('repair_ship', { type: 'repair_ship' });
    await new Promise((res) => setTimeout(res, 400));
    expect(healthOf(shipId)).toBe(50);
    const r = await install(cr, capEid);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/to install/);
  });
});

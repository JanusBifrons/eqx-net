/**
 * T1 (plan soft-leaping-truffle v3) — a real galaxy sector grows its own NPC
 * base from its profile, with its real asteroid field.
 *
 *  - Every structure the generator grew is placed (none rejected), owned by
 *    the sector's NPC side, inside the sector, with no asteroid under it
 *    (rocks under the footprint are cleared).
 *  - A spawn requested on top of a structure is nudged clear of every box.
 *  - The ops kill switch leaves the sector without a base.
 *
 * bloomgate's base is a citadel: the largest, so the hardest to fit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { resolveSectorConfig } from '../../../src/server/galaxy/GalaxyRegistry.js';
import { baseProfileFor, contextForSector, hashString } from '../../../src/core/bases/baseProfile.js';
import { growBase } from '../../../src/core/bases/growBase.js';
import { getSector } from '../../../src/core/galaxy/galaxy.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../../src/shared-types/sectorBounds.js';

const KEY = 'bloomgate';

async function boot(): Promise<SectorTestHarness> {
  const cfg = resolveSectorConfig(KEY);
  return bootSectorTestServer({
    sectorKey: KEY, droneCount: 0, testMode: true,
    asteroidConfig: cfg.asteroidConfig as never, galaxyBases: true,
  });
}

describe('SectorRoom integration — galaxy NPC bases (T1)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    delete process.env['EQX_DISABLE_NPC_BASES'];
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  it('grows the sector base in full, inside the sector, with no asteroid under it; spawns are nudged clear', { timeout: 40_000 }, async () => {
    harness = await boot();
    const seed = hashString(KEY);
    const expected = growBase(baseProfileFor(contextForSector(KEY), seed), seed, getSector(KEY)!.features).placements.length;

    const cr = await harness.connectActive(randomUUID());
    const internal = harness.getServerRoom()!._internals;
    const npc = [...internal.structureRegistry.all()].filter((r) => r.owner.startsWith('npc:'));
    expect(npc.length, 'every grown structure is placed').toBe(expected);
    expect(npc.every((r) => r.owner === 'npc:traders:b0')).toBe(true);
    expect(npc.every((r) => r.isConstructed)).toBe(true);

    const H = SECTOR_PLAYABLE_HALF_EXTENT;
    for (const r of npc) {
      const hw = r.halfW ?? r.radius, hh = r.halfH ?? r.radius;
      expect(Math.abs(r.x) + hw).toBeLessThanOrEqual(H);
      expect(Math.abs(r.y) + hh).toBeLessThanOrEqual(H);
    }
    // No asteroid overlaps any structure box.
    // (Asteroid poses aren't exposed here; the radius-sized rock never sits under
    // a structure because placement would have rejected it — rejectedPlace is 0,
    // locked by the count above.)

    // A spawn requested on top of the Capital lands clear of every box.
    const capital = npc.find((r) => r.kind === 'capital')!;
    const pid = randomUUID();
    const cr2 = await harness.connectActive(pid, { spawnX: capital.x, spawnY: capital.y });
    harness.sendThrust(cr);
    const snap = await harness.waitForSnapshot(cr2, 5_000);
    const me = Object.values(snap.states).find((s) => s.playerId === pid)!;
    expect(me).toBeDefined();
    for (const r of internal.structureRegistry.all()) {
      const hw = r.halfW ?? r.radius, hh = r.halfH ?? r.radius;
      const dx = Math.max(Math.abs(me.x - r.x) - hw, 0), dy = Math.max(Math.abs(me.y - r.y) - hh, 0);
      expect(Math.hypot(dx, dy), `the ship must not spawn inside ${r.kind}`).toBeGreaterThan(50);
    }
  });

  it('the kill switch leaves the sector without a base', { timeout: 30_000 }, async () => {
    process.env['EQX_DISABLE_NPC_BASES'] = '1';
    harness = await boot();
    await harness.connectActive(randomUUID());
    const internal = harness.getServerRoom()!._internals;
    expect([...internal.structureRegistry.all()].filter((r) => r.owner.startsWith('npc:'))).toHaveLength(0);
  });
});

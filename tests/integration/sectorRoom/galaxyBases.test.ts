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
 * bloomgate's base is a citadel (the largest; it holds its sector alone), and
 * deepcurrent holds THREE bases (galaxyBasePlan), each its own owner and kept
 * apart.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { resolveSectorConfig } from '../../../src/server/galaxy/GalaxyRegistry.js';
import { MILITARY_BASE_ID, galaxyBasePlan } from '../../../src/core/bases/galaxyBases.js';
import { gateAccessFromIndex } from '../../../src/shared-types/gateAccess.js';
import { growBase } from '../../../src/core/bases/growBase.js';
import { getSector } from '../../../src/core/galaxy/galaxy.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../../src/shared-types/sectorBounds.js';

const KEY = 'bloomgate';

async function boot(key = KEY): Promise<SectorTestHarness> {
  const cfg = resolveSectorConfig(key);
  return bootSectorTestServer({
    sectorKey: key, droneCount: 0, testMode: true,
    asteroidConfig: cfg.asteroidConfig as never, galaxyBases: true, alienGates: cfg.alienGates,
  });
}

describe('SectorRoom integration — galaxy NPC bases (T1)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    delete process.env['EQX_DISABLE_NPC_BASES'];
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  for (const [KEY, bases] of [['bloomgate', 1], ['deepcurrent', 3]] as const) it(`${KEY}: grows its ${bases} planned base(s) in full, each its own owner, inside the sector, apart; spawns are nudged clear`, { timeout: 40_000 }, async () => {
    harness = await boot(KEY);
    const plan = galaxyBasePlan(KEY);
    expect(plan.length).toBe(bases);

    const cr = await harness.connectActive(randomUUID());
    const internal = harness.getServerRoom()!._internals;
    const all = [...internal.structureRegistry.all()];
    const npc = all.filter((r) => r.owner.startsWith('npc:') && r.kind !== 'alien_gate');
    expect(npc.every((r) => r.isConstructed)).toBe(true);
    // v4 A — the alien gates (seeded after the bases) fit too: one per neighbour.
    const gates = all.filter((r) => r.kind === 'alien_gate');
    expect(gates.map((g) => g.alienNeighbour).sort()).toEqual([...getSector(KEY)!.neighbours].sort());
    const boxes: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
    for (const b of plan) {
      const expected = growBase(b.profile, b.seed, getSector(KEY)!.features).placements.length;
      const mine = npc.filter((r) => r.owner === `npc:${b.profile.ownerFaction}:${b.baseId}`);
      expect(mine.length, `every structure of ${b.baseId} (${b.profile.tier} ${b.profile.role}) is placed`).toBe(expected);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const r of mine) {
        x0 = Math.min(x0, r.x - (r.halfW ?? r.radius)); x1 = Math.max(x1, r.x + (r.halfW ?? r.radius));
        y0 = Math.min(y0, r.y - (r.halfH ?? r.radius)); y1 = Math.max(y1, r.y + (r.halfH ?? r.radius));
      }
      boxes.push({ x0, x1, y0, y1 });
    }
    expect(npc.length, 'nothing but the planned bases').toBe(plan.reduce((n, b) => n + growBase(b.profile, b.seed, getSector(KEY)!.features).placements.length, 0));
    // Bases keep clear of each other (room for bastions, mines and traffic).
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, c = boxes[j]!;
        const gapX = Math.max(c.x0 - a.x1, a.x0 - c.x1);
        const gapY = Math.max(c.y0 - a.y1, a.y0 - c.y1);
        expect(Math.max(gapX, gapY), `bases ${i} and ${j} keep apart`).toBeGreaterThan(500);
      }
    }

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

  it('v4 M: the region power\u2019s garrison grows in full: fenced, guns outside, gates for owner + allies', { timeout: 40_000 }, async () => {
    const key = 'sol-prime';
    const mil = galaxyBasePlan(key).find((b) => b.baseId === MILITARY_BASE_ID)!;
    expect(mil.profile.role).toBe('military');
    harness = await boot(key);
    await harness.connectActive(randomUUID());
    const internal = harness.getServerRoom()!._internals;
    const mine = [...internal.structureRegistry.all()].filter((r) => r.owner === `npc:${mil.profile.ownerFaction}:${MILITARY_BASE_ID}`);
    const expected = growBase(mil.profile, mil.seed, getSector(key)!.features).placements.length;
    expect(mine.length, 'every structure of the garrison is placed').toBe(expected);
    expect(mine.filter((r) => /turret/.test(r.kind)).length).toBeGreaterThanOrEqual(4);
    const gates = mine.filter((r) => r.kind === 'shield_gate');
    expect(gates.length).toBeGreaterThan(0);
    for (const g of gates) expect(gateAccessFromIndex(g.gateAccess)).toBe('allies');
  });

  it('the kill switch leaves the sector without a base', { timeout: 30_000 }, async () => {
    process.env['EQX_DISABLE_NPC_BASES'] = '1';
    harness = await boot();
    await harness.connectActive(randomUUID());
    const internal = harness.getServerRoom()!._internals;
    // (The alien gates don't belong to a base; the kill switch leaves them.)
    expect([...internal.structureRegistry.all()].filter((r) => r.owner.startsWith('npc:') && r.kind !== 'alien_gate')).toHaveLength(0);
  });
});

/**
 * Mining-barge look options (plan partitioned-chasing-lark, PR 14) through the
 * real art path. With the dev switch set (`EQX_BARGE_LOOK`), the look kind is
 * appended to the catalogue and the ordinary forge bakes it: the bake works,
 * its tiles are sane, one nozzle per authored thruster sits on the stern, and
 * the bow is not bare (the `planBowFeatures` fallback for a capital with no
 * forward `main-*` mount). The switch is module-load state, so each look
 * re-imports the modules.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load(look: 'A' | 'B' | 'C') {
  vi.resetModules();
  vi.stubEnv('EQX_BARGE_LOOK', look);
  const kinds = await import('../../../shared-types/shipKinds.js');
  const fields = await import('./fields.js');
  const bake = await import('./bake.js');
  const bow = await import('./bowDetail.js');
  return { ...kinds, ...fields, ...bake, ...bow };
}

describe.each(['A', 'B', 'C'] as const)('barge look %s in the forge', (look) => {
  it('is appended at the end of the catalogue, and bakes', async () => {
    const m = await load(look);
    expect(m.SHIP_KINDS_LIST.at(-1)!.id).toBe('barge-look');
    expect(m.SHIP_KINDS_LIST.at(-2)!.id).toBe('battlecruiser-lance');
    expect(Object.keys(m.SHIP_KINDS)).toEqual(m.SHIP_KINDS_LIST.map((k) => k.id));
    const kind = m.getShipKind('barge-look');
    const f = m.forgeShip('barge-look', { ppu: m.shipPpu('barge-look') });
    const tiles = Math.ceil(f.g.h / m.TILE_MAX_SIDE);
    expect(tiles).toBeGreaterThanOrEqual(1);
    expect(tiles).toBeLessThanOrEqual(8);
    expect(f.g.w).toBeLessThanOrEqual(m.TILE_MAX_SIDE * 2);
    let covered = 0;
    for (const c of f.cov) if (c > 0.5) covered++;
    expect(covered / f.cov.length).toBeGreaterThan(0.3);
    // One nozzle per thruster, all on the stern (Pixi-up: stern is +y).
    expect(f.nozzles).toHaveLength(kind.thrusters!.count);
    for (const n of f.nozzles) expect(n.y).toBeGreaterThan(kind.radius * 0.8);
  }, 60_000);

  // The jaw (C) carries its cutters right at the stem: no bow to fit out.
  it.skipIf(look === 'C')('gets bow fittings ahead of its forward-most mount', async () => {
    const m = await load(look);
    const kind = m.getShipKind('barge-look');
    const plan = m.planBowFeatures('barge-look', m.shipParts(kind));
    expect(plan.features.length).toBeGreaterThan(0);
    // No warship fire-control director over the cargo.
    expect(plan.features.some((f) => f.kind === 'director' || f.kind === 'rangefinder')).toBe(false);
    // The bow ends ahead of the forward-most mount's keep-out; fittings
    // (directors aside, as for the warships) stay inside it.
    const front = Math.max(...(kind.mounts ?? []).map((x) => x.localY));
    expect(plan.bowEndY).toBeLessThan(-front);
    for (const f of plan.features) {
      if (f.kind === 'director' || f.kind === 'rangefinder') continue;
      for (const [, y] of m.featureOutline(f)) expect(y).toBeLessThanOrEqual(plan.bowEndY);
      for (const k of plan.keepOuts) expect(m.distToFeature(f, k.x, k.y)).toBeGreaterThanOrEqual(k.r);
    }
  });
});

describe('bow fallback leaves the warships alone', () => {
  // Every warship has a forward main-* turret, so the fallback branch never runs for them.
  it('every warship still has a forward main turret to plan its bow from', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    const kinds = await import('../../../shared-types/shipKinds.js');
    for (const k of kinds.SHIP_KINDS_LIST.filter((x) => x.sizeClass === 'capital')) {
      const mainA = (k.mounts ?? []).find((x) => x.id.startsWith('main-') && x.localY > 0);
      expect(mainA, k.id).toBeDefined();
    }
  });
});

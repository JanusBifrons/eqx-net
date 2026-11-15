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
  const layout = await import('./turretLayout.js');
  const dish = await import('./tractorDish.js');
  return { ...kinds, ...fields, ...bake, ...bow, ...layout, ...dish };
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
    // The authored plume: the full-thrust flame (8.4 nozzle radii × len,
    // engineFx flameShape) is that fraction of the hull length.
    for (const n of f.nozzles) expect(8.4 * n.r * n.len!).toBeCloseTo(kind.thrusters!.plume! * 2 * kind.radius, 3);
    // Bell nozzles: a hot core at each bell's centre, a dark throat around it.
    const at = (x: number, y: number): number => Math.round(y * f.g.ppu + f.g.oy) * f.g.w + Math.round(x * f.g.ppu + f.g.ox);
    for (const n of f.nozzles) {
      const c = at(n.x, n.y - n.r * 0.6), throat = at(n.x + n.r * 0.65, n.y - n.r * 0.6);
      expect(f.emis[c * 3]!).toBeGreaterThan(0.5);
      expect(f.emis[throat * 3]!).toBe(0);
      expect(f.albedo[throat * 3]!).toBeLessThan(f.albedo[c * 3]! + 0.2);
    }
  }, 60_000);

  it('draws mining lasers as lens emitters and tractors as dishes, in 3+ sizes', async () => {
    const m = await load(look);
    const places = m.shipTurrets('barge-look');
    for (const p of places) {
      expect(p.naval).toBeUndefined();
      if (p.mount.id.startsWith('tractor-')) {
        expect(p.family).toBe('tractor');
        expect(p.len).toBe(0);
      } else {
        expect(p.family).toBe('beam');
        expect(p.len).toBeCloseTo(p.muzzle, 6); // the drawn lens tip is the shared muzzle
      }
    }
    expect(new Set(places.map((p) => Math.round(p.cap))).size).toBeGreaterThanOrEqual(3);
    // A dish bake: a glassy emitter at the centre, no barrel ahead of it.
    const dish = m.forgeTractorDish({ family: 'tractor', paint: 0x56606b, len: 0.1, wid: 10, cap: 50, ppu: 2 });
    const mid = Math.round(dish.g.oy) * dish.g.w + Math.round(dish.g.ox);
    expect(dish.mat[mid]).toBe(m.MAT.GLASS);
    expect(dish.g.h / dish.g.ppu).toBeLessThan(110);
  });

  // B (prong-tip lasers) and C (the jaw) carry mounts right at the stem: no bow to fit out.
  it.skipIf(look !== 'A')('gets bow fittings ahead of its forward-most mount', async () => {
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

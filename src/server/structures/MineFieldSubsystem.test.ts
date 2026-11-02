/**
 * Mine Layer (plan soft-leaping-truffle v3) — laying, the munitions magazine,
 * arming, triggering only on hostiles, and mines leaving with their layer.
 */
import { describe, expect, it } from 'vitest';
import { MineFieldSubsystem, type MineFieldDeps, type MineRecord, type MineTarget } from './MineFieldSubsystem.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';
import { MINES_PER_LAYER, MINE_ARM_MS, MINE_LAY_INTERVAL_MS, MINE_TRIGGER_RANGE } from '../../shared-types/mines.js';
import { AMMO_SHOTS_PER_UNIT } from '../../shared-types/ammo.js';

function layerRec(over: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id: 'L', owner: 'alice', kind: 'mine_layer', subtypeIndex: 0, x: 0, y: 0, radius: 156,
    isConstructed: true, constructionProgress: 0, constructionCost: 0,
    isDeconstructing: false, minerals: 0, storedPower: 0, ...over,
  };
}

interface Ship { id: string; x: number; y: number; hostileTo: Set<string> }

function field(opts: { munitions?: number; powered?: boolean; ships?: Ship[]; clear?: (x: number, y: number) => boolean } = {}) {
  const layer = layerRec();
  const byId = new Map([[layer.id, layer]]);
  const registry = { all: () => byId.values(), get: (id: string) => byId.get(id) } as unknown as StructureRegistry;
  let munitions = opts.munitions ?? Infinity;
  const ships = opts.ships ?? [];
  const blasts: Array<{ mine: MineRecord; target: MineTarget }> = [];
  const laid: MineRecord[] = [];
  const removed: MineRecord[] = [];
  const active: boolean[] = [];
  const deps: MineFieldDeps = {
    registry,
    powered: () => opts.powered ?? true,
    takeMunition: () => (munitions > 0 ? (munitions--, true) : false),
    isClear: opts.clear ?? (() => true),
    findHostile: (x, y, range, owner) => {
      for (const s of ships) {
        if (!s.hostileTo.has(owner)) continue;
        if ((s.x - x) ** 2 + (s.y - y) ** 2 <= range * range) return { id: s.id, x: s.x, y: s.y };
      }
      return null;
    },
    detonate: (mine, target) => blasts.push({ mine, target }),
    onLaid: (m) => laid.push(m),
    onRemoved: (m) => removed.push(m),
    setActive: (_r, a) => active.push(a),
  };
  const mf = new MineFieldSubsystem(deps);
  return { mf, layer, byId, blasts, laid, removed, active, ships, munitionsLeft: () => munitions };
}

/** Run the field long enough to lay `n` mines. */
function layUntil(mf: MineFieldSubsystem, n: number, startMs = 0): number {
  let t = startMs;
  for (let i = 0; i < n; i++) {
    mf.tick(t);
    t += MINE_LAY_INTERVAL_MS;
  }
  return t;
}

describe('MineFieldSubsystem', () => {
  it('lays one mine per interval up to the cap, on a ring around the layer', () => {
    const { mf, laid } = field();
    layUntil(mf, MINES_PER_LAYER + 3);
    expect(laid.length).toBe(MINES_PER_LAYER);
    expect(mf.countFor('L')).toBe(MINES_PER_LAYER);
    const angles = new Set(laid.map((m) => Math.round(Math.atan2(m.y, m.x) * 10)));
    expect(angles.size, 'spread round the ring').toBe(MINES_PER_LAYER);
    for (const m of laid) expect(Math.hypot(m.x, m.y)).toBeGreaterThan(300);
  });

  it('pays in munitions: one unit lays several mines; none left ⇒ noAmmo and no mine', () => {
    const per = AMMO_SHOTS_PER_UNIT.mine_layer!;
    const { mf, laid, layer, munitionsLeft } = field({ munitions: 1 });
    layUntil(mf, per + 2);
    expect(laid.length).toBe(per);
    expect(munitionsLeft()).toBe(0);
    expect(layer.noAmmo).toBe(true);
  });

  it('an unpowered or unbuilt layer lays nothing and draws only the idle trickle', () => {
    const { mf, laid, active } = field({ powered: false });
    layUntil(mf, 3);
    expect(laid.length).toBe(0);
    expect(active.every((a) => a === false)).toBe(true);
  });

  it('skips a blocked spot and lays at the next clear one', () => {
    let calls = 0;
    const { mf, laid } = field({ clear: () => ++calls > 2 });
    mf.tick(0);
    expect(laid.length).toBe(1);
  });

  it('an armed mine goes off on a hostile ship in range, never on a friendly one', () => {
    const { mf, laid, blasts, removed, ships } = field();
    mf.tick(0);
    const m = laid[0]!;
    ships.push({ id: 'friend', x: m.x, y: m.y, hostileTo: new Set() });
    // Before arming, even a hostile is safe.
    ships.push({ id: 'raider', x: m.x + MINE_TRIGGER_RANGE * 0.5, y: m.y, hostileTo: new Set(['alice']) });
    mf.tick(MINE_ARM_MS - 1);
    expect(blasts.length).toBe(0);
    mf.tick(MINE_ARM_MS);
    expect(blasts).toEqual([{ mine: m, target: { id: 'raider', x: m.x + MINE_TRIGGER_RANGE * 0.5, y: m.y } }]);
    expect(removed).toContain(m);
    expect(mf.mines.has(m.id)).toBe(false);
  });

  it('a friendly ship parked on a mine never sets it off', () => {
    const { mf, laid, blasts, ships } = field();
    mf.tick(0);
    const m = laid[0]!;
    ships.push({ id: 'friend', x: m.x, y: m.y, hostileTo: new Set() });
    for (let t = MINE_ARM_MS; t < MINE_ARM_MS * 10; t += 100) mf.tick(t);
    expect(blasts.length).toBe(0);
  });

  it('mines leave the world with their layer', () => {
    const { mf, laid, removed, byId } = field();
    layUntil(mf, 3);
    expect(laid.length).toBe(3);
    byId.delete('L');
    mf.tick(100_000);
    expect(removed.length).toBe(3);
    expect(mf.mines.size).toBe(0);
  });
});

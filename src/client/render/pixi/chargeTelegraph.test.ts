/**
 * The one charge telegraph (plan step 6): each charge weapon picks its look.
 * The robot charge laser keeps its ring + aim line; a 'mount-glow' weapon
 * (the coming railgun; here the 5" given a charge for the test) glows on the
 * charging gun only, no aim line, ramping on the game clock from the
 * snapshot's start tick (a late joiner sees the true progress, #16/#20).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChargeTelegraph, chargeGlowLevel, chargeTelegraphStyle, updateChargeTelegraph } from './chargeTelegraph.js';
import { getWeapon, type WeaponDef } from '../../../core/combat/WeaponCatalogue.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';

const TICK_MS = 1000 / 60;
type Mutable = { -readonly [K in keyof WeaponDef]?: WeaponDef[K] };

describe('charge telegraph style', () => {
  it('the robot charge laser keeps the ring + line; a weapon may ask for the mount glow', () => {
    expect(chargeTelegraphStyle(getWeapon('charge-laser'))).toBe('ring-line');
    expect(chargeTelegraphStyle({ ...getWeapon('naval_l'), chargeTelegraph: 'mount-glow' } as WeaponDef)).toBe('mount-glow');
  });

  it('the glow ramps 0 → 1 over the charge and holds at full', () => {
    expect(chargeGlowLevel(0, 1000)).toBe(0);
    expect(chargeGlowLevel(250, 1000)).toBeCloseTo(0.25);
    expect(chargeGlowLevel(1000, 1000)).toBe(1);
    expect(chargeGlowLevel(5000, 1000)).toBe(1);
    expect(chargeGlowLevel(-5, 1000)).toBe(0);
  });

  it('a kind with no charge weapon gets no telegraph', () => {
    expect(buildChargeTelegraph('fighter', 12)).toBeNull();
  });

  it('robot: ring + aim line, shown while its mount charges', () => {
    const t = buildChargeTelegraph('robot-circle', 20)!;
    expect(t).not.toBeNull();
    expect(t.ring).not.toBeNull();
    expect(t.glows.every((g) => g === null)).toBe(true);
    updateChargeTelegraph(t, t.ringMask, 100, 110, 5000, undefined);
    expect(t.root.visible).toBe(true);
    expect(t.ring!.visible).toBe(true);
    updateChargeTelegraph(t, 0, undefined, 120, 5100, undefined);
    expect(t.root.visible).toBe(false);
  });
});

describe('mount-glow telegraph', () => {
  const def = getWeapon('naval_s') as Mutable;
  const saved = { chargeTicks: def.chargeTicks, chargeTelegraph: def.chargeTelegraph };
  beforeEach(() => { def.chargeTicks = 60; def.chargeTelegraph = 'mount-glow'; });
  afterEach(() => { def.chargeTicks = saved.chargeTicks; def.chargeTelegraph = saved.chargeTelegraph; });

  it('glows only the charging gun (no ring, no aim line), ramping from the start tick on the game clock', () => {
    const mounts = getShipKind('battleship').mounts;
    const s = mounts.findIndex((m) => m.weaponId === 'naval_s');
    const other = mounts.findIndex((m, i) => m.weaponId === 'naval_s' && i !== s);
    const t = buildChargeTelegraph('battleship', 200)!;
    expect(t).not.toBeNull();
    expect(t.ring, 'no ring / aim line for a mount-glow weapon').toBeNull();
    expect(t.glows[s]).not.toBeNull();
    expect(t.glows[mounts.findIndex((m) => m.weaponId === 'naval_xl')]).toBeNull();

    // A late joiner: the charge began 30 ticks (half the charge) before now.
    const fx0 = 10_000;
    updateChargeTelegraph(t, 1 << s, 1000, 1030, fx0, undefined);
    const g = t.glows[s]!;
    expect(g.visible).toBe(true);
    expect(t.glows[other]!.visible, 'only the charging gun glows').toBe(false);
    const half = g.alpha;
    expect(half).toBeCloseTo(0.15 + 0.85 * 0.5, 2);
    // Game time moves on 10 ticks: the ramp follows fxNow, not new snapshots.
    updateChargeTelegraph(t, 1 << s, 1000, 1030, fx0 + 10 * TICK_MS, undefined);
    expect(g.alpha).toBeGreaterThan(half);
    // Past the charge it holds at full (with a small flicker).
    updateChargeTelegraph(t, 1 << s, 1000, 1030, fx0 + 120 * TICK_MS, undefined);
    expect(g.alpha).toBeGreaterThan(0.84);
    // The charge ends: hidden.
    updateChargeTelegraph(t, 0, undefined, 1200, fx0 + 200 * TICK_MS, undefined);
    expect(t.root.visible).toBe(false);
  });

  it('the glow turns with its gun', () => {
    const mounts = getShipKind('battleship').mounts;
    const s = mounts.findIndex((m) => m.weaponId === 'naval_s');
    const t = buildChargeTelegraph('battleship', 200)!;
    const angles = new Array<number>(mounts.length).fill(0);
    angles[s] = 0.5;
    updateChargeTelegraph(t, 1 << s, 0, 0, 0, angles);
    expect(t.glows[s]!.rotation).toBeCloseTo(-(mounts[s]!.baseAngle + 0.5));
  });

describe('per-mount charge starts (railgun battleship)', () => {
  it('two railgun turrets that began charging apart glow apart (chargeOffsets)', () => {
    const mounts = getShipKind('battleship').mounts;
    const xl = getWeapon('naval_xl') as Mutable;
    const saved = { chargeTicks: xl.chargeTicks, chargeTelegraph: xl.chargeTelegraph };
    xl.chargeTicks = 360; xl.chargeTelegraph = 'mount-glow';
    try {
      const a = mounts.findIndex((m) => m.weaponId === 'naval_xl');
      const bIdx = mounts.findIndex((m, i) => m.weaponId === 'naval_xl' && i > a);
      expect(bIdx).toBeGreaterThan(a);
      const t = buildChargeTelegraph('battleship', 200)!;
      const mask = (1 << a) | (1 << bIdx);
      // Mount a began at 1000, mount b 180 ticks later; now = 1180.
      updateChargeTelegraph(t, mask, 1000, 1180, 50_000, undefined, [0, 180]);
      const ga = t.glows[a]!;
      const gb = t.glows[bIdx]!;
      expect(ga.alpha).toBeCloseTo(0.15 + 0.85 * 0.5, 2); // half charged
      expect(gb.alpha).toBeCloseTo(0.15, 2); // just started
      // Without offsets both would ramp from the earliest start (in step).
      updateChargeTelegraph(t, mask, 1000, 1180, 50_000, undefined);
      expect(gb.alpha).toBeCloseTo(ga.alpha, 5);
    } finally {
      xl.chargeTicks = saved.chargeTicks; xl.chargeTelegraph = saved.chargeTelegraph;
    }
  });
});
});

describe('rail-slot telegraph (the railgun)', () => {
  it("a 'mount-glow' weapon on a 'rail' gun fills the slot; other guns keep the mount glow", () => {
    expect(chargeTelegraphStyle(getWeapon('railgun'), 'rail')).toBe('rail-slot');
    expect(chargeTelegraphStyle(getWeapon('railgun'))).toBe('mount-glow');
    expect(chargeTelegraphStyle(getWeapon('charge-laser'), 'rail')).toBe('ring-line');
  });

  it('battleship-rail: the slot fill grows from the breech to the muzzle with the charge', () => {
    const mounts = getShipKind('battleship-rail').mounts;
    const i = mounts.findIndex((m) => m.weaponId === 'railgun');
    expect(i).toBeGreaterThanOrEqual(0);
    const t = buildChargeTelegraph('battleship-rail', 200)!;
    expect(t.ring).toBeNull();
    const rail = t.rails[i]!;
    expect(rail, 'a railgun mount gets the slot fill').not.toBeNull();
    const chargeTicks = getWeapon('railgun').chargeTicks!;
    const at = (frac: number): { fill: number; headY: number; alpha: number } => {
      t.startTick = -1;
      updateChargeTelegraph(t, 1 << i, 1000, 1000 + Math.round(chargeTicks * frac), 90_000, undefined);
      return { fill: rail.fill.scale.y, headY: rail.head.y, alpha: t.glows[i]!.alpha };
    };
    const q = at(0.25), h = at(0.5), f = at(1);
    expect(q.fill).toBeCloseTo(0.25, 2);
    expect(h.fill).toBeGreaterThan(q.fill);
    expect(f.fill).toBeCloseTo(1, 5);
    // Pixi-up: the muzzle is at -y, so the head moves to more negative y.
    expect(h.headY).toBeLessThan(q.headY);
    expect(f.headY).toBeCloseTo(rail.y0 - rail.len, 3);
    expect(h.alpha).toBeGreaterThan(q.alpha);
    // The glow stays the gun's own size (no 'mount-glow' scale ramp).
    expect(t.glows[i]!.scale.x).toBe(1);
  });
});

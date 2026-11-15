/**
 * Railgun pass-through (plan beam-slices §7): a shell whose weapon has a
 * channel `killCut` keeps flying, at FULL damage, after a hit that KILLS
 * (`applyDamage` returns true). It stops at the first target that survives a
 * hit, or at the end of its flight; it never hits the same target twice and
 * flies through capital wreck pieces (swarm kind 4). Every other shell ends at
 * its first hit, whatever the hit did.
 */
import { describe, expect, it } from 'vitest';
import { ProjectilePipeline, passesThrough } from './ProjectilePipeline.js';
import { SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';

interface Ent { id: string; slot: number; x: number; y: number; kind?: number; hp: number }

const RAIL = getWeapon('railgun');
if (RAIL.mode !== 'projectile') throw new Error('railgun is a projectile weapon');

function harness(ents: Ent[]) {
  const sab = new Float32Array(8192);
  for (const e of ents) {
    const b = slotBase(e.slot);
    sab[b + SLOT_X_OFF] = e.x;
    sab[b + SLOT_Y_OFF] = e.y;
  }
  const clock = { tick: 1000 };
  const hits: Array<{ target: string; damage: number }> = [];
  const ends: Array<{ id: string; continues: boolean }> = [];
  const expired: string[] = [];
  // A plain registry over the live entities: a kill removes the entity.
  const live = new Set(ents.map((e) => e.id));
  let version = 0;
  const pipe = new ProjectilePipeline({
    sabF32: sab,
    serverTick: () => clock.tick,
    playerToSlot: [],
    getActiveShip: () => undefined,
    shipPoseCache: new Map(),
    playerSweep: () => null,
    swarmRegistry: {
      all: () => ents.filter((e) => live.has(e.id)).map((e) => ({ id: e.id, slot: e.slot, radius: 40, kind: e.kind ?? 1 })),
      get version() { return version; },
    },
    lingeringSlots: new Map(),
    applyDamage: (target, _s, damage) => {
      hits.push({ target, damage });
      const e = ents.find((x) => x.id === target)!;
      if (e.kind === 4) return false; // wreck pieces are immune
      e.hp -= damage;
      if (e.hp > 0) return false;
      live.delete(target);
      version++;
      return true;
    },
    onShellEnd: (id, _t, _x, _y, _r, continues) => { ends.push({ id, continues: continues === true }); },
    onShellExpire: (id) => { expired.push(id); },
  });
  return { pipe, clock, hits, ends, expired };
}

function run(h: ReturnType<typeof harness>, ticks: number): void {
  for (let i = 0; i < ticks && h.pipe.size() > 0; i++) {
    h.pipe.advance();
    h.clock.tick++;
  }
}

/** Fire a railgun slug from x = 0 along +x (its real speed and flight). */
function fireRail(h: ReturnType<typeof harness>, damage = RAIL.damage): void {
  h.pipe.spawn('rail-ship', 0, 0, RAIL.mode === 'projectile' ? RAIL.speed : 0, 0, damage, RAIL.mode === 'projectile' ? RAIL.radius : 0,
    RAIL.mode === 'projectile' ? RAIL.maxTicks : 0, 'railgun');
}

describe('ProjectilePipeline — railgun pass-through', () => {
  it('only a channel killCut weapon passes through', () => {
    expect(passesThrough('railgun')).toBe(true);
    for (const id of ['naval_s', 'naval_xl', 'naval_siege', 'laser', 'autocannon'] as const) expect(passesThrough(id)).toBe(false);
  });

  it('a kill does not stop the slug: it hits the ship behind at FULL damage', () => {
    const h = harness([
      { id: 'a', slot: 1, x: 2000, y: 0, hp: 100 },
      { id: 'b', slot: 2, x: 4000, y: 0, hp: 100 },
      { id: 'c', slot: 3, x: 6000, y: 0, hp: 100 },
    ]);
    fireRail(h);
    run(h, 1000);
    expect(h.hits.map((x) => x.target)).toEqual(['a', 'b', 'c']);
    expect(h.hits.every((x) => x.damage === RAIL.damage)).toBe(true);
    // Every hit reported, each a pass-through; the slug then flies its full
    // flight and ends silently (a miss).
    expect(h.ends).toEqual([
      { id: 'proj-0', continues: true }, { id: 'proj-0', continues: true }, { id: 'proj-0', continues: true },
    ]);
    expect(h.expired).toEqual(['proj-0']);
  });

  it('a hit that does not kill stops the slug (absorbed)', () => {
    const h = harness([
      { id: 'a', slot: 1, x: 2000, y: 0, hp: 100 },
      { id: 'tough', slot: 2, x: 4000, y: 0, hp: 1e9 },
      { id: 'c', slot: 3, x: 6000, y: 0, hp: 100 },
    ]);
    fireRail(h);
    run(h, 1000);
    expect(h.hits.map((x) => x.target)).toEqual(['a', 'tough']);
    expect(h.ends).toEqual([{ id: 'proj-0', continues: true }, { id: 'proj-0', continues: false }]);
    expect(h.pipe.size()).toBe(0);
    expect(h.expired).toEqual([]);
  });

  it('two victims inside ONE step are both hit, in order, in that step', () => {
    // The step is ~107 u; both ships sit inside the slug's first step.
    const h = harness([
      { id: 'far', slot: 2, x: 95, y: 0, hp: 100 },
      { id: 'near', slot: 1, x: 50, y: 0, hp: 100 },
    ]);
    fireRail(h);
    h.pipe.advance();
    expect(h.hits.map((x) => x.target)).toEqual(['near', 'far']);
  });

  it('never hits the same target twice (a victim still in the registry is skipped)', () => {
    // An entity that "dies" but stays registered: the victim record must skip it.
    const h = harness([{ id: 'ghost', slot: 1, x: 2000, y: 0, hp: 100 }]);
    const pipe = h.pipe as unknown as { deps: { swarmRegistry: { all: () => unknown[] } } };
    const sticky = [{ id: 'ghost', slot: 1, radius: 40, kind: 1 }];
    pipe.deps.swarmRegistry.all = () => sticky;
    fireRail(h);
    run(h, 1000);
    expect(h.hits.map((x) => x.target)).toEqual(['ghost']);
  });

  it('flies through capital wreck pieces (kind 4): the slug ignores debris', () => {
    const h = harness([
      { id: 'wreck', slot: 1, x: 2000, y: 0, kind: 4, hp: 1 },
      { id: 'b', slot: 2, x: 4000, y: 0, hp: 100 },
    ]);
    fireRail(h);
    run(h, 1000);
    expect(h.hits.map((x) => x.target)).toEqual(['b']);
  });

  it('an ordinary shell ends at its first hit even when it kills', () => {
    const h = harness([
      { id: 'a', slot: 1, x: 2000, y: 0, hp: 1 },
      { id: 'b', slot: 2, x: 2600, y: 0, hp: 1 },
    ]);
    h.pipe.spawn('gun', 0, 0, 2000, 0, 1400, 6, 200, 'naval_xl');
    run(h, 1000);
    expect(h.hits.map((x) => x.target)).toEqual(['a']);
    expect(h.ends).toEqual([{ id: 'proj-0', continues: false }]);
  });

  it('a wreck piece still blocks an ordinary shell', () => {
    const h = harness([{ id: 'wreck', slot: 1, x: 2000, y: 0, kind: 4, hp: 1 }]);
    h.pipe.spawn('gun', 0, 0, 2000, 0, 1400, 6, 200, 'naval_xl');
    run(h, 1000);
    expect(h.hits.map((x) => x.target)).toEqual(['wreck']);
  });

  it('reuses its victim lists (pooled): a second slug starts with a clean record', () => {
    const ents: Ent[] = [{ id: 'a', slot: 1, x: 2000, y: 0, hp: 100 }];
    const h = harness(ents);
    fireRail(h);
    run(h, 1000);
    // Revive 'a' at the same spot; a fresh slug must hit it again.
    ents[0]!.hp = 100;
    const pipe = h.pipe as unknown as { deps: { swarmRegistry: { all: () => unknown[] } } };
    pipe.deps.swarmRegistry.all = () => [{ id: 'a', slot: 1, radius: 40, kind: 1 }];
    fireRail(h);
    run(h, 1000);
    expect(h.hits.map((x) => x.target)).toEqual(['a', 'a']);
  });
});

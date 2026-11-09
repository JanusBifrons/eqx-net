/**
 * Coastal defences — the 80 cm siege shell bursts where it stops (plan
 * coastal-defences): the ship it strikes takes the full hit, everything else
 * in the blast takes inverse-square splash, and a shell that falls short at
 * the end of its flight still bursts. A plain shell never splashes.
 */
import { describe, expect, it } from 'vitest';
import { ProjectilePipeline } from './ProjectilePipeline.js';
import { SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';
import { shellBlastDamage } from '../../shared-types/shellBlast.js';

interface Ent { id: string; slot: number; x: number; y: number; kind: number }

function makePipeline(ents: Ent[]) {
  const sab = new Float32Array(8192);
  for (const e of ents) {
    const b = slotBase(e.slot);
    sab[b + SLOT_X_OFF] = e.x;
    sab[b + SLOT_Y_OFF] = e.y;
  }
  let tick = 0;
  const hits: Array<{ target: string; damage: number }> = [];
  const blasts: Array<{ x: number; y: number; r: number }> = [];
  const pipe = new ProjectilePipeline({
    sabF32: sab,
    serverTick: () => tick,
    playerToSlot: [],
    getActiveShip: () => undefined,
    shipPoseCache: new Map(),
    playerSweep: () => null,
    swarmRegistry: { all: () => ents.map((e) => ({ id: e.id, slot: e.slot, radius: 12, kind: e.kind, shipKind: 'fighter' })) },
    lingeringSlots: new Map(),
    applyDamage: (target, _s, damage) => { hits.push({ target, damage }); },
    onBlast: (x, y, r) => { blasts.push({ x, y, r }); },
  });
  const fly = (n: number) => { for (let i = 0; i < n; i++) { pipe.advance(); tick++; } };
  return { pipe, hits, blasts, fly };
}

const SIEGE = getWeapon('naval_siege');
const splash = SIEGE.mode === 'projectile' ? SIEGE.splash! : { radius: 0, falloffMin: 0 };

describe('siege shell blast (coastal defences)', () => {
  it('the struck ship takes the full hit; a neighbour inside the blast takes splash; one outside takes none', () => {
    const { pipe, hits, blasts, fly } = makePipeline([
      { id: 'gun', slot: 0, x: 0, y: 0, kind: 2 },
      { id: 'target', slot: 1, x: 300, y: 0, kind: 1 },
      { id: 'near', slot: 2, x: 300, y: 80, kind: 1 },
      { id: 'far', slot: 3, x: 300, y: splash.radius + 200, kind: 1 },
    ]);
    pipe.spawn('gun', 20, 0, 1900, 0, 4200, 12, 160, 'naval_siege');
    fly(20);
    const direct = hits.find((h) => h.target === 'target');
    expect(direct?.damage).toBe(4200);
    const near = hits.find((h) => h.target === 'near');
    expect(near).toBeDefined();
    expect(near!.damage).toBeGreaterThan(0);
    expect(near!.damage).toBeLessThan(4200);
    expect(hits.some((h) => h.target === 'far')).toBe(false);
    expect(hits.some((h) => h.target === 'gun')).toBe(false); // never the firer
    expect(blasts).toHaveLength(1);
  });

  it('a shell that falls short bursts where it lands', () => {
    const { pipe, hits, blasts, fly } = makePipeline([
      { id: 'gun', slot: 0, x: 0, y: 0, kind: 2 },
      // Lands at 1900 × 10 / 60 ≈ 317 u; this ship sits just off the line, 60 u from the fall.
      { id: 'by', slot: 1, x: 337, y: 60, kind: 1 },
    ]);
    pipe.spawn('gun', 20, 0, 1900, 0, 4200, 12, 10, 'naval_siege');
    fly(12);
    expect(blasts).toHaveLength(1);
    expect(hits.find((h) => h.target === 'by')?.damage).toBeGreaterThan(0);
  });

  it('a plain shell neither splashes nor bursts', () => {
    const { pipe, hits, blasts, fly } = makePipeline([
      { id: 'gun', slot: 0, x: 0, y: 0, kind: 2 },
      { id: 'target', slot: 1, x: 300, y: 0, kind: 1 },
      { id: 'near', slot: 2, x: 300, y: 40, kind: 1 },
    ]);
    pipe.spawn('gun', 20, 0, 2300, 0, 1400, 6, 110, 'naval_xl');
    fly(20);
    expect(hits).toEqual([{ target: 'target', damage: 1400 }]);
    expect(blasts).toHaveLength(0);
  });

  it('blast damage is full inside the falloff, inverse-square beyond it, nothing outside', () => {
    expect(shellBlastDamage(1000, 10, 160, 30)).toBe(1000);
    expect(shellBlastDamage(1000, 60, 160, 30)).toBeCloseTo(250);
    expect(shellBlastDamage(1000, 161, 160, 30)).toBe(0);
  });
});

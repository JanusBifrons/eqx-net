/**
 * Structure break-up T6: a structure's wreck pieces act exactly like a
 * ship's (owner): they wear like a ship wreck's (not a rock's) and a
 * worn-out or hauled piece is worth ship-style salvage (`pieceSalvageQtyOf`
 * only special-cases rock), a sensible non-zero amount.
 */
import { describe, expect, it } from 'vitest';
import { structureBreaks, structureWreckSource } from '../../core/destruction/wreckSource.js';
import { wreckSalvageQty, wreckWearFactor } from '../../core/destruction/wreckIntegrity.js';
import { STRUCTURE_KINDS_LIST, type StructureKindId } from '../../shared-types/structureKinds.js';
import { pieceSalvageQtyOf } from './wreckLineage.js';
import type { LiveWreck, PieceKnock } from './capitalWreckTypes.js';
import { structureSpillPoint } from './features/structureSpill.js';
import { LootSubsystem } from '../cargo/LootSubsystem.js';
import { HoldStore } from '../cargo/HoldStore.js';
import type { IPersistenceSink } from '../../core/contracts/IPersistenceSink.js';
import { rebuildWreckPieces } from '../../core/destruction/wreckDescriptorGeometry.js';
import { FRACTURE_ALGO_VERSION } from '../../core/destruction/fractureHull.js';
import { WRECK_STRUCTURE_PARENT_KIND, type WreckDescriptor } from '../../shared-types/messages/wreckDescriptor.js';
import { tuningFor } from '../../shared-types/shipScale/lookup.js';

describe('structure wreck salvage and wear (structure break-up T6)', () => {
  const kinds: StructureKindId[] = ['capital', 'solar', 'connector', 'turret'];

  it.each(kinds)('a %s piece is worth non-zero ship-style salvage', (k) => {
    const src = structureWreckSource({ k });
    expect(src.rock).toBeNull();
    // A whole hull's worth, a quarter piece (turns to salvage), a sliver.
    const whole = wreckSalvageQty(src, src.bodyMass);
    const quarter = wreckSalvageQty(src, src.bodyMass / 4);
    const sliver = wreckSalvageQty(src, src.bodyMass / 1000);
    expect(whole).toBeGreaterThan(1);
    expect(quarter).toBeGreaterThanOrEqual(1);
    expect(quarter).toBeLessThanOrEqual(whole);
    expect(sliver).toBe(1);
    // The room's lookup: not a rock ⇒ the same salvage (never 0).
    const wrecks = new Map([[7, { src } as unknown as LiveWreck]]);
    const knock = new Map([['p', { mass: src.bodyMass / 4 } as PieceKnock]]);
    expect(pieceSalvageQtyOf(wrecks, new Map([['p', 7]]), knock, 'p')).toBe(quarter);
  });

  it('every breaking kind has a positive whole-hull salvage', () => {
    for (const kind of STRUCTURE_KINDS_LIST) {
      if (!structureBreaks(kind.id, true)) continue;
      expect(wreckSalvageQty(structureWreckSource({ k: kind.id }), structureWreckSource({ k: kind.id }).bodyMass), kind.id).toBeGreaterThan(0);
    }
  });

  it('pieces wear like a ship wreck, not a rock', () => {
    // `CapitalWreckSubsystem` passes `src.rock !== null` (false here).
    expect(wreckWearFactor(undefined, structureWreckSource({ k: 'solar' }).rock !== null)).toBe(wreckWearFactor(undefined, false));
    expect(wreckWearFactor(undefined, false)).toBeGreaterThan(0);
  });
});

// Capital death (in-game): its ~4600 minerals looked lost. They spilled as
// one pod at the Capital's centre (`evictSwarmEntity` → `LootSubsystem.drop`),
// exactly where its wreck pieces spawn, so the pod hid under them. A razed
// structure that breaks up spills just outside its wreck, sized from the
// kind's own outline and the pod's own hit radius (#18).
describe('a razed structure\'s spill pod lands clear of its wreck', () => {
  function lootSetup() {
    const sink: IPersistenceSink = {
      enqueueCritical: () => {}, enqueueVolatile: () => {},
      enqueueCriticalAwaitable: () => Promise.resolve({}), shutdown: () => Promise.resolve({ drained: 0 }),
    };
    const poses = new Map<string, { x: number; y: number }>();
    const store = new HoldStore({ persistence: () => sink, now: () => 1000 });
    const loot = new LootSubsystem({
      holdStore: store, sectorKey: () => 'sol-prime', now: () => 1000, deathSalt: 0,
      spawnPodEntity: (id, x, y) => { poses.set(id, { x, y }); return true; },
      despawnPodEntity: (id) => { poses.delete(id); }, setPodTier: () => {},
      podPose: (id) => poses.get(id) ?? null, forEachCollector: () => {}, onCollected: () => {},
      chunkOre: () => ({}),
    });
    return { loot, store, poses };
  }

  for (const rot of [0, 90, 180, 270]) {
    it(`Capital (rot ${rot}): the pod exists, holds the minerals, and lies outside every wreck piece`, () => {
      const cap = { kind: 'capital' as const, x: 1200, y: -800, rot };
      const t = lootSetup();
      const at = structureSpillPoint(cap, true, { x: 0, y: 0 });
      const id = t.loot.drop({ goods: { minerals: 4600 }, blueprints: [] }, at.x, at.y, 0, 0, { cause: 'razed' })!;
      expect(id).toBeTruthy();
      expect(t.store.get(id)!.hold.goods.minerals).toBe(4600);
      const pod = t.poses.get(id)!;
      // The pieces as they spawn: the structure's fracture, posed at the structure.
      const src = structureWreckSource({ k: 'capital' });
      const d: WreckDescriptor = {
        wreckId: 1, parentKind: WRECK_STRUCTURE_PARENT_KIND, structure: { k: 'capital' }, seed: 5,
        killX: 0, killY: 0, killBlowDamage: 0.5, recentDamageRate: 0.2, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION,
      };
      const pieces = rebuildWreckPieces(d)!;
      expect(pieces.length).toBeGreaterThan(1);
      const c = Math.cos((rot * Math.PI) / 180), s = Math.sin((rot * Math.PI) / 180);
      // World → the structure's local game frame (the pieces' rings, math-up).
      const lx = (pod.x - cap.x) * c + (pod.y - cap.y) * s, ly = -(pod.x - cap.x) * s + (pod.y - cap.y) * c;
      const fx = lx, fy = ly; // piece rings are math-up (game y-up), as the structure frame
      for (const p of pieces) {
        const ring = p.outline.map((v) => ({ x: v.x + p.cx, y: v.y + p.cy }));
        expect(inRing(ring, fx, fy), `pod under piece ${p.index}`).toBe(false);
      }
      // Clear of the whole hull by at least the pod's own size.
      expect(Math.hypot(pod.x - cap.x, pod.y - cap.y)).toBeGreaterThanOrEqual(src.radius + tuningFor('cargo-pod').hitRadius);
    });
  }

  it('a structure that leaves no wreck (deconstructed, or no break-up) spills where it stood', () => {
    expect(structureSpillPoint({ kind: 'capital', x: 10, y: 20, rot: 0 }, false, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
  });
});

function inRing(ring: ReadonlyArray<{ x: number; y: number }>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

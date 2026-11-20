/**
 * T2 / T4b / 3h — this room's NPC bases (and players' Freight Docks with
 * standing orders) as the convoy director plans with them (moved out of
 * SectorRoom.ts; `SectorRoom.npcBaseTrade` delegates here).
 */
import { TARGET_MINUTES as CONVOY_TARGET_MINUTES } from '../../core/economy/convoys.js';
import { FREIGHT_DOCK_BAY, craneBayWorldCentre } from '../../core/articulation/rigCatalogue.js';
import { isShieldEmitterKind } from '../../core/structures/gateGeometry.js';
import { usesAmmo } from '../../shared-types/ammo.js';
import type { GoodId } from '../../shared-types/goods.js';
import { defaultRecipeFor, isProcessorKind } from '../../shared-types/production.js';
import { RECIPES } from '../../shared-types/recipes.js';
import { isNpcOwner } from '../../shared-types/relations.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import type { StorageService } from '../cargo/StorageService.js';
import { isOperationalStorage } from '../cargo/storageHolds.js';
import type { StructureRecord, StructureRegistry } from '../structures/StructureRegistry.js';
import { bayBehindFence } from './convoyDocking.js';
import type { NpcBaseTrade } from './convoyRoom.js';

/** T2 — an NPC ammo turret's assumed munitions use (it fires only when attacked). */
const NPC_TURRET_MUNITIONS_PER_MIN = 0.2;

/** T4b — the level of `good`'s order on a dock (0 when none). */
function o_level(r: { freightOrders?: Array<{ good: GoodId; level: number }> }, good: GoodId): number {
  return r.freightOrders?.find((o) => o.good === good)?.level ?? 0;
}

/**
 * T2 — this room's NPC bases for convoy planning (ConvoyDirector, every
 * ~15 s; off-tick, so building arrays here is fine). Per base: its storage
 * stock, free space, footprint box, and per-minute use/make rates read from
 * its own structures (processor recipes, Reactor fuel, ammo turrets, drills,
 * gas collectors).
 */
export function npcBaseTrade(structures: Pick<StructureRegistry, 'all'>, storage: Pick<StorageService, 'tradeSnapshot'>): NpcBaseTrade[] {
  const byOwner = new Map<string, StructureRecord[]>();
  for (const r of structures.all()) {
    if (!r.isConstructed || !isNpcOwner(r.owner)) continue;
    const list = byOwner.get(r.owner);
    if (list) list.push(r); else byOwner.set(r.owner, [r]);
  }
  const out: NpcBaseTrade[] = [];
  for (const [owner, recs] of byOwner) {
    const anchor = recs.find((r) => r.kind === 'capital' && r.uid !== undefined)
      ?? recs.find((r) => r.uid !== undefined && (getStructureKind(r.kind).holdCapacity ?? 0) > 0);
    if (!anchor?.uid) continue;
    const snap = storage.tradeSnapshot(owner, anchor.uid);
    if (snap === null) continue;
    const uses: Partial<Record<GoodId, number>> = {};
    const makes: Partial<Record<GoodId, number>> = {};
    const add = (m: Partial<Record<GoodId, number>>, g: GoodId, n: number): void => { m[g] = (m[g] ?? 0) + n; };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const r of recs) {
      const hw = r.halfW ?? r.radius, hh = r.halfH ?? r.radius;
      x0 = Math.min(x0, r.x - hw); x1 = Math.max(x1, r.x + hw);
      y0 = Math.min(y0, r.y - hh); y1 = Math.max(y1, r.y + hh);
      const k = getStructureKind(r.kind);
      if (isProcessorKind(r.kind)) {
        const def = RECIPES[r.recipe ?? defaultRecipeFor(r.kind)];
        const perMin = 60 / Math.max(1, def.cyclePulses);
        for (const [g, n] of Object.entries(def.inputs)) add(uses, g as GoodId, (n ?? 0) * perMin);
        for (const o of def.outputs) if ('good' in o) add(makes, o.good, o.n * perMin);
      }
      if (k.fuelEveryPulses) add(uses, 'fuel', 60 / k.fuelEveryPulses);
      if (usesAmmo(r.kind)) add(uses, 'munitions', NPC_TURRET_MUNITIONS_PER_MIN);
      if (k.miningRate) add(makes, 'minerals', k.miningRate * 60);
      if (k.gasRate) add(makes, 'gas', k.gasRate * 60);
    }
    const bay = convoyBayOf(recs);
    out.push({ owner, networkUid: anchor.uid, view: { stock: snap.goods, freeCapacity: snap.freeCapacity, uses, makes }, box: { x0, x1, y0, y1 }, ...(bay ? { bay } : {}) });
  }
  // T4b — a player's Freight Dock with standing orders trades too, but only
  // in the goods it has orders for: "use" is shaped so an import keeps the
  // network up to its level and an export offers anything above it.
  for (const r of structures.all()) {
    if (r.kind !== 'freight_dock' || !r.isConstructed || !r.freightOrders?.length || isNpcOwner(r.owner) || r.uid === undefined) continue;
    const snap = storage.tradeSnapshot(r.owner, r.uid);
    if (snap === null) continue;
    const stock: Partial<Record<GoodId, number>> = {};
    const uses: Partial<Record<GoodId, number>> = {};
    const imports: GoodId[] = [];
    const exports: GoodId[] = [];
    for (const o of r.freightOrders) {
      stock[o.good] = snap.goods[o.good] ?? 0;
      uses[o.good] = o.level / CONVOY_TARGET_MINUTES;
      (o.mode === 'import' ? imports : exports).push(o.good);
    }
    // Import goods are never offered (only exports are spare); export goods
    // are never asked for.
    for (const g of imports) if ((stock[g] ?? 0) > o_level(r, g)) stock[g] = o_level(r, g);
    const hw = r.halfW ?? r.radius, hh = r.halfH ?? r.radius;
    const bay = convoyBayOf([...structures.all()].filter((o) => o.owner === r.owner), r);
    out.push({
      ...(bay ? { bay } : {}),
      owner: r.owner, networkUid: r.uid, player: { imports, exports },
      view: { stock, freeCapacity: snap.freeCapacity, uses, makes: {} },
      box: { x0: r.x - hw, x1: r.x + hw, y0: r.y - hh, y1: r.y + hh },
    });
  }
  return out;
}

/**
 * structure-restyle 3h — the Freight Dock bay a convoy hauler parks on at
 * this owner's base (`recs`: its structures; `only`: that dock), or null:
 * no operational dock, or every dock's bay is behind the owner's fence
 * (`bayBehindFence`: gates open only for pilots). Off-tick (planning).
 */
function convoyBayOf(recs: readonly StructureRecord[], only?: StructureRecord): NpcBaseTrade['bay'] | null {
  const fence: Array<{ x: number; y: number }> = [];
  for (const r of recs) if (r.isConstructed && isShieldEmitterKind(r.kind)) fence.push({ x: r.x, y: r.y });
  for (const r of only ? [only] : recs) {
    if (r.kind !== FREIGHT_DOCK_BAY.kindId || !isOperationalStorage(r)) continue;
    const at = craneBayWorldCentre(FREIGHT_DOCK_BAY, r.x, r.y, r.rot ?? 0);
    if (!bayBehindFence(at.x, at.y, fence)) return { dockId: r.id, x: at.x, y: at.y };
  }
  return null;
}

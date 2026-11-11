/**
 * Structure turret gather under real naval ranges (docs/architecture/
 * real-scale-ranges.md "Structure turret gather"). A citadel grown by the
 * production-chain generator (`growBase`, the `npc-base-citadel` seed), every
 * defence structure run by the real `StructureMountTicker`, fed by a sink that
 * mirrors `SectorRoom.collectTurretTargets`: the same `NearestPointGrid`
 * (512 u cells over the sector extent, rebuilt once per turret tick) and its
 * `within` query, written into pooled views. N hostile ships sit in a 40 km
 * disc round the base. Reach is each gun's `navalGunEngageReach` in the
 * chosen mode, so legacy and real run in one process.
 *
 * Shared by `turret-gather.bench.ts` (timing, print-only) and
 * `turretGather.count.test.ts` (candidate counts, the gate).
 */
import { growBase } from '../src/core/bases/growBase.js';
import { TIER_LEVEL_CAP, TIER_WEALTH } from '../src/core/bases/baseProfile.js';
import { NearestPointGrid } from '../src/core/spatial/NearestPointGrid.js';
import { targetClass } from '../src/core/combat/mountTargeting.js';
import { isWeaponId } from '../src/core/combat/WeaponCatalogue.js';
import { getStructureKind, STRUCTURE_KINDS_LIST, type StructureKind } from '../src/shared-types/structureKinds.js';
import { getShipKind } from '../src/shared-types/shipKinds.js';
import { navalGunBallisticsFor, navalGunEngageReach, type NavalGunId } from '../src/shared-types/combat/navalGuns.js';
import type { NavalRangeMode } from '../src/shared-types/combat/navalRange.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../src/shared-types/sectorBounds.js';
import { StructureMountTicker, type TurretTargetView } from '../src/server/structures/StructureMountTicker.js';
import type { StructureRecord } from '../src/server/structures/StructureRegistry.js';
import type { WeaponMount } from '../src/shared-types/shipKinds.js';

const NPC_OWNER = 'npc:traders:citadel';
/** Hostile mix: mostly small craft, some gunships and capitals. */
const HOSTILE_KINDS = ['fighter', 'fighter', 'interceptor', 'gunship', 'destroyer', 'battleship'] as const;

interface DefenceStructure {
  rec: StructureRecord;
  kind: StructureKind;
  mounts: ReadonlyArray<WeaponMount>;
}

export interface TurretGatherRig {
  /** Defence structures in the citadel. */
  readonly defences: number;
  /** Their mounts, summed. */
  readonly mounts: number;
  /** `kind@reach` per defence structure. */
  readonly layout: string;
  /** One turret tick (grid rebuild + every defence structure's ticker). */
  tick(): void;
  /** Counters since the last `resetCounts`. */
  readonly counts: { ticks: number; gathers: number; candidates: number; maxPerGather: number };
  resetCounts(): void;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isNavalGun(id: string, mode: NavalRangeMode): id is NavalGunId {
  return id in navalGunBallisticsFor(mode);
}

/** A defence kind with its reach in `mode` (coastal guns follow the switch). */
function kindIn(mode: NavalRangeMode, k: StructureKind): StructureKind {
  const w = k.mounts?.[0]?.weaponId;
  if (w === undefined || !isNavalGun(w, mode)) return k;
  return { ...k, weaponRange: navalGunEngageReach(w, mode) };
}

export function citadelTurretRig(mode: NavalRangeMode, hostiles: number, radius = 40_000, seed = 1): TurretGatherRig {
  const grown = growBase({
    tier: 'citadel', role: 'assembly', ownerFaction: 'traders',
    wealth: Math.round((TIER_WEALTH.citadel[0] + TIER_WEALTH.citadel[1]) / 2),
    levelCap: TIER_LEVEL_CAP.citadel[1], fenced: true,
  }, 15, []);
  const defences: DefenceStructure[] = [];
  grown.placements.forEach((p, i) => {
    const base = getStructureKind(p.kind);
    const m = base.mounts;
    if (base.weaponRange == null || m === undefined || m.length === 0 || !isWeaponId(m[0]!.weaponId)) return;
    const rec = {
      id: `s${i}`, owner: NPC_OWNER, kind: p.kind, subtypeIndex: STRUCTURE_KINDS_LIST.findIndex((k) => k.id === p.kind),
      x: p.x, y: p.y, radius: base.radius, rot: p.rot ?? 0, isConstructed: true,
      constructionProgress: 0, constructionCost: 0, isDeconstructing: false,
    } as unknown as StructureRecord;
    defences.push({ rec, kind: kindIn(mode, base), mounts: m });
  });

  // Hostile ships in a disc round the base, moving.
  const r = rng(seed);
  const xs = new Float64Array(hostiles), ys = new Float64Array(hostiles);
  const vxs = new Float64Array(hostiles), vys = new Float64Array(hostiles);
  const kinds = new Array<string>(hostiles);
  for (let i = 0; i < hostiles; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * radius;
    xs[i] = Math.cos(a) * d; ys[i] = Math.sin(a) * d;
    vxs[i] = (r() - 0.5) * 120; vys[i] = (r() - 0.5) * 120;
    kinds[i] = HOSTILE_KINDS[i % HOSTILE_KINDS.length]!;
  }

  // Mirror of SectorRoom's target grid + pooled views (collectTurretTargets).
  const grid = new NearestPointGrid(512, SECTOR_PLAYABLE_HALF_EXTENT * 2, 512);
  const idx: number[] = [];
  const pool: TurretTargetView[] = [];
  const counts = { ticks: 0, gathers: 0, candidates: 0, maxPerGather: 0 };
  const ticker = new StructureMountTicker({
    targets: (x, y, range, _owner, out) => {
      const k = grid.within(x, y, range, idx);
      for (let j = 0; j < k; j++) {
        const i = idx[j]!;
        let v = pool[j];
        if (!v) { v = { id: '', entityId: -1, x: 0, y: 0, vx: 0, vy: 0, cls: 'small', signature: 1 }; pool[j] = v; }
        const sk = getShipKind(kinds[i]);
        v.id = `h${i}`; v.entityId = i; v.x = xs[i]!; v.y = ys[i]!; v.vx = vxs[i]!; v.vy = vys[i]!;
        v.cls = targetClass(sk); v.signature = sk.radius;
        out[j] = v;
      }
      counts.gathers++;
      counts.candidates += k;
      if (k > counts.maxPerGather) counts.maxPerGather = k;
      return k;
    },
    fire: () => true,
  });
  ticker.setInstantLocks(true);

  let now = 0;
  return {
    defences: defences.length,
    mounts: defences.reduce((s, d) => s + d.mounts.length, 0),
    layout: defences.map((d) => `${d.rec.kind}@${d.kind.weaponRange}`).join(' '),
    counts,
    resetCounts() { counts.ticks = 0; counts.gathers = 0; counts.candidates = 0; counts.maxPerGather = 0; },
    tick() {
      // The room rebuilds the grid once per turret tick (lazily, first query).
      grid.reset();
      for (let i = 0; i < hostiles; i++) {
        xs[i] = xs[i]! + vxs[i]! * 0.1; ys[i] = ys[i]! + vys[i]! * 0.1;
        grid.add(xs[i]!, ys[i]!);
      }
      grid.build();
      now += 100;
      const dt = ticker.beginTick(now, 0.1);
      for (const d of defences) ticker.tick(d.rec, d.kind, d.mounts, now, dt);
      counts.ticks++;
    },
  };
}

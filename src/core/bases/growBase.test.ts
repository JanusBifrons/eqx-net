/**
 * D1 (plan soft-leaping-truffle v3) — every generated base is buildable under
 * the REAL rules (placementRejection + canConnect, the server's own), fully
 * connected, powered, inside its tier's budget, and runs only part of the
 * production chain (no base runs all four stages).
 */
import { describe, expect, it } from 'vitest';
import { getStructureKind, structureHalfExtents } from '../../shared-types/structureKinds.js';
import { canConnect, type GridNode } from '../structures/Grid.js';
import { Connection } from '../structures/Connection.js';
import { placementRejection } from '../structures/placementRules.js';
import { isShieldEmitterKind } from '../structures/gateGeometry.js';
import { GALAXY_SECTORS } from '../galaxy/galaxy.js';
import { BASE_ROLES, baseProfileFor, contextForSector, type BaseProfile, type BaseRole, type BaseTier } from './baseProfile.js';
import { TIER_MAX_STRUCTURES, growBase, type GrownBase } from './growBase.js';

function node(id: string, kind: string, x: number, y: number, rot = 0): GridNode {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, rot);
  return {
    id, x, y, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: kind === 'capital', isConnector: kind === 'connector', isShieldPylon: isShieldEmitterKind(kind),
    maxConnections: k.maxConnections, connectionRange: k.connectionRange,
    powerOutput: k.powerOutput, powerConsumption: k.powerConsumption, isConstructed: true,
  };
}

/** Re-check a generated base against the real rules, independently. */
function verify(b: GrownBase): { reached: number } {
  const nodes = new Map<string, GridNode>();
  const placed: Array<{ x: number; y: number; radius: number; halfW: number; halfH: number }> = [];
  b.placements.forEach((p, i) => {
    expect(placementRejection(p.kind, p.x, p.y, placed, null, p.rot ?? 0), `placement ${i} ${p.kind}`).toBeNull();
    const nd = node('s' + i, p.kind, p.x, p.y, p.rot ?? 0);
    placed.push({ x: p.x, y: p.y, radius: nd.radius, halfW: nd.halfW!, halfH: nd.halfH! });
    nodes.set(nd.id, nd);
  });
  const adj = new Map<string, Connection[]>();
  let cid = 0;
  for (const [a, c] of b.edges) {
    const na = nodes.get('s' + a)!, nc = nodes.get('s' + c)!;
    expect(canConnect(na, nc, adj, nodes), `edge ${a}-${c}`).toEqual({ ok: true });
    const con = new Connection(cid++, na.id, nc.id, 1);
    (adj.get(na.id) ?? adj.set(na.id, []).get(na.id)!).push(con);
    (adj.get(nc.id) ?? adj.set(nc.id, []).get(nc.id)!).push(con);
  }
  const seen = new Set(['s0']);
  const q = ['s0'];
  while (q.length) {
    const id = q.pop()!;
    for (const c of adj.get(id) ?? []) {
      const o = c.getOtherNode(id)!;
      if (!seen.has(o)) { seen.add(o); q.push(o); }
    }
  }
  return { reached: seen.size };
}

function profile(tier: BaseTier, role: BaseRole, fenced = true): BaseProfile {
  const wealth = { outpost: 5_000, settlement: 16_000, stronghold: 50_000, citadel: 120_000 }[tier];
  return { tier, role, ownerSide: 'traders', wealth, levelCap: tier === 'citadel' ? 5 : 2, fenced };
}

describe('growBase — valid under the real building rules', () => {
  for (const tier of ['outpost', 'settlement', 'stronghold', 'citadel'] as const) {
    for (const role of BASE_ROLES) {
      if (role === 'assembly' && (tier === 'outpost' || tier === 'settlement')) continue;
      it(`${tier} ${role}: legal, connected, powered, within budget, part of the chain`, () => {
        const b = growBase(profile(tier, role), 1234, ['asteroid', 'nebula', 'minerals']);
        const { reached } = verify(b);
        expect(reached, 'every structure reachable from the Capital').toBe(b.placements.length);
        expect(b.netPower).toBeGreaterThanOrEqual(0);
        expect(b.placements.length).toBeLessThanOrEqual(TIER_MAX_STRUCTURES[tier]);
        expect(b.stages.length).toBeLessThan(4);
        if (tier === 'outpost') expect(b.stages.length).toBeLessThanOrEqual(2);
        expect(b.placements.filter((p) => ['deep_core_rig', 'ore_processing_complex', 'assembly_plant'].includes(p.kind)).length).toBeLessThanOrEqual(1);
        if (role !== 'trade') expect(b.placements.some((p) => p.kind === 'freight_dock'), 'a dock').toBe(true);
      });
    }
  }

  it('fenced bases get a closed ring with a gate on each side', () => {
    const b = growBase(profile('settlement', 'refinery'), 7, ['minerals']);
    expect(b.fenceGates).toBe(4);
    expect(b.fencePylons).toBeGreaterThan(8);
    expect(verify(b).reached).toBe(b.placements.length);
  });

  it('is deterministic per seed, and different seeds differ', () => {
    const p = profile('settlement', 'workshop');
    expect(growBase(p, 5)).toEqual(growBase(p, 5));
    const kinds = (s: number) => growBase(p, s).placements.map((x) => x.kind).join();
    const distinct = new Set([1, 2, 3, 4, 5, 6].map(kinds));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('more wealth never builds a smaller base', () => {
    const lo = growBase({ ...profile('settlement', 'refinery'), wealth: 8_000 }, 3, ['minerals']);
    const hi = growBase({ ...profile('settlement', 'refinery'), wealth: 20_000 }, 3, ['minerals']);
    expect(hi.placements.length).toBeGreaterThanOrEqual(lo.placements.length);
  });

  it('role character: mining bases are mostly extractors, trade hubs mostly storage', () => {
    const mine = growBase(profile('settlement', 'mining'), 9, ['asteroid']);
    const trade = growBase(profile('settlement', 'trade'), 9, ['station']);
    const count = (b: GrownBase, kinds: string[]) => b.placements.filter((p) => kinds.includes(p.kind)).length;
    expect(count(mine, ['miner', 'gas_collector'])).toBeGreaterThan(count(mine, ['smelter', 'fabricator', 'cargo_bay']));
    expect(count(trade, ['cargo_bay', 'freight_dock'])).toBeGreaterThan(5);
  });

  it('every galaxy sector grows a valid base (sweep)', () => {
    for (const s of GALAXY_SECTORS) {
      const ctx = contextForSector(s.key);
      for (let seed = 1; seed <= 3; seed++) {
        const p = baseProfileFor(ctx, seed * 31 + 7);
        const b = growBase(p, seed, s.features);
        expect(verify(b).reached, `${s.key} seed ${seed}`).toBe(b.placements.length);
        expect(b.netPower, `${s.key} seed ${seed} power`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

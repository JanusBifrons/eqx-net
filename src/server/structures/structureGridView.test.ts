/**
 * WS-5 (R2.17) multi-connect lock — a freshly-placed structure auto-connects to
 * ALL in-range, legal hubs (not just the nearest), bounded by its own
 * `maxConnections` AND the global `PLACEMENT_MAX_CONNECTIONS = 6` cap, in a
 * deterministic (distance, id) order.
 *
 * Failing-first vehicle (RED on PR-1's nearest-only `autoConnectStructure`):
 * place a Connector (cap 6) among 6 in-range Connectors and assert it links to
 * all 6 — pre-PR-2 only the single nearest connects (`connectionCount === 1`).
 *
 * Backward-compat lock: a leaf (Solar, cap 1) placed among 3 hubs still links to
 * exactly ONE (the nearest) — multi-connect must not change leaf behaviour.
 */
import { describe, it, expect } from 'vitest';
import { StructureRegistry, type StructureRecord } from './StructureRegistry.js';
import { autoConnectStructure, structureToGridNode } from './structureGridView.js';
import { getStructureKind, type StructureKindId } from '../../shared-types/structureKinds.js';

const OWNER = 'owner-1';

function record(id: string, kind: StructureKindId, x: number, y: number, built = true): StructureRecord {
  const k = getStructureKind(kind);
  return {
    id,
    owner: OWNER,
    kind,
    subtypeIndex: 0,
    x,
    y,
    radius: k.radius,
    isConstructed: built,
    constructionProgress: built ? k.constructionCost : 0,
    constructionCost: k.constructionCost,
    isDeconstructing: false,
    minerals: 0,
    storedPower: 0,
  };
}

/** Seed `count` built connectors around the origin on distinct angles (radial
 *  spokes never cross another hub) at STRICTLY INCREASING radii (`baseDist +
 *  i*40`) so `hub-0` is unambiguously the nearest by edge-distance — the AABB
 *  `edgeDistance` makes equal-radius diagonal hubs closer than axis-aligned ones,
 *  so a symmetric ring has no well-defined "nearest". Then drop the placed
 *  connector at the origin. */
function seedConnectorsAround(
  count: number,
  baseDist: number,
): { registry: StructureRegistry; placedId: string; hubIds: string[] } {
  const registry = new StructureRegistry();
  const hubIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const r = baseDist + i * 40;
    const id = `hub-${i}`;
    registry.add(record(id, 'connector', Math.cos(angle) * r, Math.sin(angle) * r));
    hubIds.push(id);
  }
  const placedId = 'placed';
  registry.add(record(placedId, 'connector', 0, 0));
  return { registry, placedId, hubIds };
}

describe('autoConnectStructure — WS-5 (R2.17) multi-connect', () => {
  it('connects a placed Connector to ALL 6 in-range Connector hubs', () => {
    // 6 connectors on distinct 60° angles, radii 200..400 (all edge-distances
    // well within the global 600 u). hub-0 is nearest (smallest radius + axis-
    // aligned).
    const { registry, placedId, hubIds } = seedConnectorsAround(6, 200);

    const nearest = autoConnectStructure(registry, placedId);

    expect(registry.connectionCount(placedId)).toBe(6);
    for (const hubId of hubIds) {
      expect(registry.hasConnection(placedId, hubId)).toBe(true);
    }
    // Returns the NEAREST connected id (backward-compat with the old single
    // return) — hub-0 by edge-distance.
    expect(nearest).toBe('hub-0');
  });

  it('caps the auto-connect fan-out at PLACEMENT_MAX_CONNECTIONS (6) even with 7 hubs in range', () => {
    // 7 in-range connectors; the placed connector links to at most 6 (its own cap
    // AND the global cap coincide at 6 — no kind exceeds 6 today, so this locks
    // the ≤ 6 ceiling both enforce).
    const { registry, placedId } = seedConnectorsAround(7, 200);

    autoConnectStructure(registry, placedId);

    expect(registry.connectionCount(placedId)).toBe(6);
  });

  it('a leaf (Solar, cap 1) still connects to exactly the NEAREST hub (no multi-connect)', () => {
    const registry = new StructureRegistry();
    // 3 connectors at distinct angles + distances from the origin (all in range,
    // no mutual LOS blocking). The solar (cap 1) must pick ONLY the nearest.
    registry.add(record('hub-near', 'connector', 150, 0)); // edge dist 86
    registry.add(record('hub-c', 'connector', -180, 0)); // edge dist 116
    registry.add(record('hub-b', 'connector', 0, 200)); // edge dist 136
    const placedId = 'solar';
    registry.add(record(placedId, 'solar', 0, 0));

    const nearest = autoConnectStructure(registry, placedId);

    expect(registry.connectionCount(placedId)).toBe(1);
    expect(registry.hasConnection(placedId, 'hub-near')).toBe(true);
    expect(nearest).toBe('hub-near');
  });
});

describe('structureToGridNode — mid-upgrade Capital stays operational (must-fix #2)', () => {
  it('projects a MID-UPGRADE Capital as built (traversable source + power-generating)', () => {
    // Review must-fix #2: an Upgrade flips the Capital's `isConstructed` false to
    // run a visible re-build, but in the GRID VIEW it must stay BUILT so it
    // remains the routable funder (else the whole grid bricks). Fail-first: on
    // the pre-fix projection a mid-upgrade capital projects isConstructed=false /
    // 0 power, so Grid.route can't use it as a source.
    const cap = record('cap', 'capital', 0, 0, /* built */ false);
    cap.upgradeTargetLevel = 2; // mid-upgrade

    const node = structureToGridNode(cap);

    expect(node.isConstructed).toBe(true);
    expect(node.powerOutput).toBe(getStructureKind('capital').powerOutput);
  });

  it('still projects a fresh (not-yet-built) Capital blueprint as inert', () => {
    // A capital that is genuinely a fresh blueprint (no upgradeTargetLevel) stays
    // a dead-end blueprint — the mid-upgrade carve-out must not leak to it.
    const cap = record('cap', 'capital', 0, 0, /* built */ false);

    const node = structureToGridNode(cap);

    expect(node.isConstructed).toBe(false);
    expect(node.powerOutput).toBe(0);
  });

  it('does NOT extend the carve-out to a mid-upgrade LEAF (turret stays a dead-end blueprint)', () => {
    // The carve-out is Capital-only — a mid-upgrade leaf (turret) re-builds as a
    // normal dead-end blueprint (it is not a funder / relay).
    const turret = record('t', 'turret', 0, 0, /* built */ false);
    turret.upgradeTargetLevel = 2;

    const node = structureToGridNode(turret);

    expect(node.isConstructed).toBe(false);
  });
});

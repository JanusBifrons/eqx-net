/**
 * Connectors return to IDLE after repair + per-edge flow MATERIAL tagging
 * (Phase 3 WS-D / PR2 / #12; Invariant #13 — failing test FIRST).
 *
 * Root cause: `processRepair` called `flashRoute()` every pulse even when the
 * repair was stalled / zero-progress, so the edge never dropped to idle until the
 * structure respawned. Fixes:
 *   1. flash a repair route ONLY when `hpGain > 0`;
 *   2. at full HP the next pulse omits the edge entirely (it drops to idle);
 *   3. each flashed edge is TAGGED with its flow material
 *      ('repair' | 'minerals' | 'construction' | 'power') so the client tints it
 *      (green = repair/healing, orange = minerals, cyan = construction).
 *
 * `pulse()` now returns `flashed: Array<[aId, bId, FlowMaterial]>` (per-edge
 * material). Before the fix the entry is a 2-tuple with a single per-pulse
 * material, so the per-edge material assertions read `undefined`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { StructureRegistry } from './StructureRegistry.js';
import { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from './StructureGridSubsystem.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';

const OWNER = 'player-1';

function makeHarness() {
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  let counter = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { health.delete(id); },
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${counter++}`,
    registry,
  });
  const grid = new StructureGridSubsystem({
    registry,
    getHealth: (id) => health.get(id) ?? 0,
    setHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { health.delete(id); },
    findNearestAsteroid: () => null,
  });
  let now = 0;
  const pulse = () => { now += 1000; return grid.pulse(now); };
  return { registry, health, placement, grid, pulse };
}

/** Build + power a capital→connector web, returning the connector id. */
function builtConnector(h: ReturnType<typeof makeHarness>): { cap: string; con: string } {
  const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
  const con = h.placement.place(OWNER, 'connector', 200, 0)!;
  const pulses = Math.ceil(getStructureKind('connector').constructionCost / 5) + 5;
  for (let i = 0; i < pulses; i++) h.pulse();
  return { cap, con };
}

/** Find the flashed entry for the (a,b) edge in either direction; null if absent. */
function edgeIn(
  flashed: ReadonlyArray<readonly [string, string, ...unknown[]]>,
  a: string,
  b: string,
): readonly [string, string, ...unknown[]] | null {
  for (const e of flashed) {
    if ((e[0] === a && e[1] === b) || (e[0] === b && e[1] === a)) return e;
  }
  return null;
}

describe('StructureGridSubsystem — repair returns to idle + material tagging (WS-D #12)', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it('a damaged structure flashes its repair route TAGGED "repair" while hpGain > 0', () => {
    const { cap, con } = builtConnector(h);
    expect(h.registry.get(con)!.isConstructed).toBe(true);
    h.health.set(con, 50); // damage it well below max

    const result = h.pulse();
    const edge = edgeIn(result.flashed, cap, con);
    expect(edge, 'repair route flashed').not.toBeNull();
    expect(edge![2]).toBe('repair'); // per-edge material = repair (green/healing)
    // …and it actually healed.
    expect(h.health.get(con)!).toBeGreaterThan(50);
  });

  it('at FULL HP the next pulse OMITS the edge — it drops to idle (no perpetual flash)', () => {
    const { cap, con } = builtConnector(h);
    // Heal to full so repair makes zero progress.
    h.health.set(con, getStructureKind('connector').maxHealth);
    const result = h.pulse();
    // The repair step makes no hpGain → the edge must NOT be in the repair flashes.
    // (Other flows could still flash it, but with nothing to transfer/build, the
    // only candidate flash here was repair — so it's omitted entirely → idle.)
    expect(edgeIn(result.flashed, cap, con)).toBeNull();
  });

  it('a STALLED repair (no minerals to spend) does NOT flash — edge goes idle', () => {
    const { cap, con } = builtConnector(h);
    h.health.set(con, 50); // damaged
    h.registry.get(cap)!.minerals = 0; // bank dry → repair can spend nothing → hpGain 0
    const result = h.pulse();
    expect(edgeIn(result.flashed, cap, con)).toBeNull();
    expect(h.health.get(con)).toBe(50); // unchanged — no repair happened
  });

  it('a construction route is TAGGED "construction", a transfer route "minerals"', () => {
    // Construction: a fresh blueprint reachable from the capital flashes
    // 'construction' while building.
    const cap = h.placement.place(OWNER, 'capital', 0, 0)!;
    const con = h.placement.place(OWNER, 'connector', 200, 0)!; // blueprint
    const buildPulse = h.pulse();
    const buildEdge = edgeIn(buildPulse.flashed, cap, con);
    expect(buildEdge, 'construction route flashed').not.toBeNull();
    expect(buildEdge![2]).toBe('construction');
  });
});

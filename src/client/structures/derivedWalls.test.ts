/**
 * Phase V gates — the client derives every shield wall from the mirror with the
 * same rules as the server's ShieldWallManager (#15): fence walls between any
 * two connected built emitters (anchored on the nearest gate post), blocking
 * per the walls-up flag. Gates / airlocks have no span across their gap: their
 * doors are solid rig leaves (docs/plans/door-power.md, slice 11).
 */
import { describe, expect, it } from 'vitest';
import { visitDerivedWalls, type DerivedWallVisitor } from './derivedWalls.js';
import type { StructureRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { GATE_POSTS } from '../../shared-types/structureKinds/gatePosts.js';
import { TP_PHASE, padIrisSpanCount } from '../../shared-types/teleport.js';

function st(connTo: number[], extra: Partial<StructureRenderState> = {}): StructureRenderState {
  return {
    powered: true, netPower: 0, connTo, built: true, buildPct: 1, deconstructPct: 0, wallActive: true, ...extra,
  } as StructureRenderState;
}
function sw(x: number, y: number, shipKind: string, angle = 0): SwarmRenderState {
  return { x, y, vx: 0, vy: 0, angle, kind: 2, radius: 50, shipKind } as unknown as SwarmRenderState;
}

function collect(structures: Map<number, StructureRenderState>, swarm: Map<number, SwarmRenderState>) {
  const out: Array<{ key: number; ax: number; ay: number; bx: number; by: number; blocking: boolean; open: boolean }> = [];
  const v: DerivedWallVisitor = { wall: (key, ax, ay, bx, by, blocking, _t, open) => out.push({ key, ax, ay, bx, by, blocking, open }) };
  visitDerivedWalls(structures, swarm, v);
  return out;
}

describe('visitDerivedWalls', () => {
  const swarm = new Map<number, SwarmRenderState>([
    [1, sw(0, 0, 'shield_gate')],
    [2, sw(500, 0, 'shield_pylon')],
    [3, sw(0, 400, 'connector')],
  ]);

  it('a gate yields only a fence wall to the pylon, anchored on the nearest post (no gate span)', () => {
    const structures = new Map([[1, st([2, 3])], [2, st([1])], [3, st([1])]]);
    const walls = collect(structures, swarm);
    expect(walls.filter((w) => w.key < 0)).toHaveLength(0);
    const fence = walls.find((w) => w.key === 1 * 65536 + 2)!;
    expect(fence).toMatchObject({ ax: GATE_POSTS[1]![0], ay: 0, bx: 500, by: 0, blocking: true });
    expect(walls).toHaveLength(1); // no wall to the connector
  });

  it('an open door adds no wall; an airlock has no end spans; the fence still blocks', () => {
    const door = { p0: 2700, t0: 0, dir: 1 as const, level: 15 };
    const structures = new Map([[1, st([2], { doorA: door })], [2, st([1])], [4, st([], { doorA: door, doorB: door })]]);
    const walls = collect(structures, new Map([...swarm, [4, sw(-900, 0, 'shield_airlock')]]));
    expect(walls).toHaveLength(1);
    expect(walls[0]).toMatchObject({ key: 1 * 65536 + 2, blocking: true, open: false });
  });

  it('walls go down when either end reports its walls down; blueprints have none', () => {
    const down = collect(new Map([[1, st([2])], [2, st([1], { wallActive: false })]]), swarm);
    expect(down.find((w) => w.key > 0)!.blocking).toBe(false);
    const blueprint = collect(new Map([[1, st([2])], [2, st([1], { built: false })]]), swarm);
    expect(blueprint.filter((w) => w.key > 0)).toHaveLength(0);
  });

  it('redesign T3: a chamber pad has no iris spans, sealed or not; the Ancients gate keeps its own', () => {
    for (const kind of ['teleporter', 'teleporter_large', 'pocket_pad']) {
      for (const phase of [TP_PHASE.IDLE, TP_PHASE.SEALED]) {
        const tp = st([], { teleport: { phase } as StructureRenderState['teleport'] });
        expect(collect(new Map([[7, tp]]), new Map([[7, sw(0, 0, kind)]]))).toHaveLength(0);
      }
    }
    const sealed = st([], { teleport: { phase: TP_PHASE.SEALED } as StructureRenderState['teleport'] });
    const gate = collect(new Map([[7, sealed]]), new Map([[7, sw(0, 0, 'alien_gate')]]));
    expect(gate).toHaveLength(padIrisSpanCount('alien_gate'));
    expect(gate.every((w) => w.key < 0 && w.blocking && !w.open)).toBe(true);
    const idle = st([], { teleport: { phase: TP_PHASE.IDLE } as StructureRenderState['teleport'] });
    expect(collect(new Map([[7, idle]]), new Map([[7, sw(0, 0, 'alien_gate')]])).every((w) => !w.blocking && w.open)).toBe(true);
  });
});

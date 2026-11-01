/**
 * Phase V gates — the client derives every shield wall from the mirror with the
 * same rules as the server's ShieldWallManager (#15): fence walls between any
 * two connected built emitters (anchored on the nearest gate post), plus each
 * gate's own spans, blocking per the walls-up flag and the open bits.
 */
import { describe, expect, it } from 'vitest';
import { visitDerivedWalls, type DerivedWallVisitor } from './derivedWalls.js';
import type { StructureRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { GATE_OPEN_A } from '../../core/structures/gateLogic.js';

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

  it('a gate yields its span plus a fence wall to the pylon, anchored on the nearest post', () => {
    const structures = new Map([[1, st([2, 3])], [2, st([1])], [3, st([1])]]);
    const walls = collect(structures, swarm);
    const span = walls.find((w) => w.key < 0)!;
    expect(span).toMatchObject({ ax: -88, ay: 0, bx: 88, by: 0, blocking: true, open: false });
    const fence = walls.find((w) => w.key === 1 * 65536 + 2)!;
    expect(fence).toMatchObject({ ax: 124, ay: 0, bx: 500, by: 0, blocking: true });
    expect(walls).toHaveLength(2); // no wall to the connector
  });

  it('an open gate span is open, not blocking; the fence still blocks', () => {
    const structures = new Map([[1, st([2], { gateOpen: GATE_OPEN_A })], [2, st([1])]]);
    const walls = collect(structures, swarm);
    expect(walls.find((w) => w.key < 0)).toMatchObject({ blocking: false, open: true });
    expect(walls.find((w) => w.key > 0)).toMatchObject({ blocking: true });
  });

  it('walls go down when either end reports its walls down; blueprints have none', () => {
    const down = collect(new Map([[1, st([2])], [2, st([1], { wallActive: false })]]), swarm);
    expect(down.find((w) => w.key > 0)!.blocking).toBe(false);
    const blueprint = collect(new Map([[1, st([2])], [2, st([1], { built: false })]]), swarm);
    expect(blueprint.filter((w) => w.key > 0)).toHaveLength(0);
  });
});

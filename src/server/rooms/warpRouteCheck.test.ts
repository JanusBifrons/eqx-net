/**
 * Warp route check (warp S2, server): a requested warp point is accepted only
 * when it is a drop point with a clear line, or the near side of the first
 * obstacle on the line to one; an accepted spool keeps its point even when a
 * structure is placed on the line mid-spool.
 */
import { describe, it, expect, vi } from 'vitest';
import { WarpRouteCheck, type WarpRouteHooks } from './warpRouteCheck.js';
import { WarpTravelTracker } from './warpTravel.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';
import { sectorSites, warpDropPoint } from '../../core/galaxy/sectorSites.js';
import { GALAXY_SECTORS } from '../../core/galaxy/galaxy.js';
import { newWarpTarget, warpStopMargin, warpTargetFor, WARP_MIN_DISTANCE } from '../../core/galaxy/warpTarget.js';
import { CoarseFieldMap } from '../../core/nav/coarseField.js';
import { cutFieldOpts } from '../../core/terrain/chunkStreamer.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { STRUCTURE_KINDS_LIST, structureHalfExtents } from '../../shared-types/structureKinds.js';

const KEY = GALAXY_SECTORS[0]!.key;
const home = sectorSites(KEY).find((s) => s.kind === 'home')!;
// The ship 40 km east of the home pocket's rim; the rim point faces it.
const P = { x: home.x + home.r + 40_000, y: home.y };
const R = warpDropPoint(home, P.x, P.y);
const KIND = STRUCTURE_KINDS_LIST[0]!.id;

function structureAt(id: string, x: number, y: number): StructureRecord {
  return { id, owner: 'p', kind: KIND, subtypeIndex: 0, x, y, radius: 100, isConstructed: true } as StructureRecord;
}

function setup() {
  const structures = new Map<string, StructureRecord>();
  let phase: 0 | 1 | 2 = 0;
  const tracker = new WarpTravelTracker({
    phaseOf: () => phase, clearPointNear: (_p, x, y) => ({ x, y }),
    retarget: () => {}, setTravelling: () => {}, bumpPoseEpoch: () => {},
  });
  const hooks: WarpRouteHooks = {
    sectorKey: () => KEY,
    solar: () => true,
    fieldOpts: () => null,
    structures: { all: () => structures.values() },
    gateBoxes: () => undefined,
    pose: (pid) => (pid === 'p' ? P : undefined),
    kindOf: () => 'fighter',
    accepted: (pid, x, y) => tracker.accepted(pid, x, y),
  };
  const check = new WarpRouteCheck(hooks);
  return { check, structures, tracker, hooks, setPhase: (p: 0 | 1 | 2) => { phase = p; } };
}

/** The near-side point the client would offer (the same shared rule). */
function nearSide(check: WarpRouteCheck): { x: number; y: number } {
  const margin = warpStopMargin(getShipKind('fighter'));
  const t = warpTargetFor(R.x, R.y, P.x, P.y, null, check, margin, newWarpTarget());
  return { x: t.x, y: t.y };
}

describe('WarpRouteCheck.valid', () => {
  it('accepts a drop point with a clear line', () => {
    const { check } = setup();
    expect(check.valid('p', R.x, R.y)).toBe(true);
  });

  it('rejects the drop point when a structure is on the line, accepts the near side', () => {
    const { check, structures } = setup();
    structures.set('s1', structureAt('s1', (P.x + R.x) / 2, P.y));
    expect(check.valid('p', R.x, R.y)).toBe(false);
    const n = nearSide(check);
    expect(Math.hypot(n.x - R.x, n.y - R.y)).toBeGreaterThan(5_000);
    expect(check.valid('p', Math.round(n.x), Math.round(n.y))).toBe(true);
  });

  it('rejects a random point, an unknown pilot and a non-solar room', () => {
    const { check, hooks } = setup();
    expect(check.valid('p', P.x - 10_000, P.y + 7_000)).toBe(false);
    expect(check.valid('ghost', R.x, R.y)).toBe(false);
    const flat = new WarpRouteCheck({ ...hooks, solar: () => false });
    expect(flat.valid('p', R.x, R.y)).toBe(false);
  });

  it('a structure placed mid-spool does not cancel the accepted warp', () => {
    const { check, structures, tracker, setPhase } = setup();
    expect(check.valid('p', R.x, R.y)).toBe(true);
    tracker.noteRequest('p', R.x, R.y);
    setPhase(1); tracker.tick(1);
    structures.set('s1', structureAt('s1', (P.x + R.x) / 2, P.y));
    // The resent point is the accepted one: still accepted.
    expect(check.valid('p', R.x, R.y)).toBe(true);
    // A different point is checked afresh (the line is blocked now).
    expect(check.valid('p', R.x, R.y + 1)).toBe(false);
  });

  it('builds the field map once and reuses it', () => {
    const { hooks } = setup();
    const opts = cutFieldOpts('warp-s2-test');
    const build = vi.spyOn(CoarseFieldMap.prototype, 'build');
    const check = new WarpRouteCheck({ ...hooks, fieldOpts: () => opts });
    check.valid('p', R.x, R.y);
    check.valid('p', R.x, R.y + 1);
    check.targetFor('fighter', P.x, P.y, R.x, R.y, newWarpTarget());
    expect(build).toHaveBeenCalledTimes(1);
    build.mockRestore();
  });
});

describe('WarpRouteCheck.targetFor', () => {
  it('stops short of a structure, and is unreachable right in front of one', () => {
    const { check, structures } = setup();
    expect(check.targetFor('fighter', P.x, P.y, R.x, R.y, newWarpTarget())).toMatchObject({ x: R.x, y: R.y, blocked: false, reachable: true });
    structures.set('s1', structureAt('s1', (P.x + R.x) / 2, P.y));
    const t = check.targetFor('fighter', P.x, P.y, R.x, R.y, newWarpTarget());
    expect(t.blocked).toBe(true);
    expect(t.reachable).toBe(true);
    expect(t.x).toBeGreaterThan((P.x + R.x) / 2);
    const { hw } = structureHalfExtents(KIND, 0);
    const close = check.targetFor('fighter', (P.x + R.x) / 2 + hw + WARP_MIN_DISTANCE / 2, P.y, R.x, R.y, newWarpTarget());
    expect(close.reachable).toBe(false);
  });
});

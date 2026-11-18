/**
 * A lock ends with its lineage, not its piece (lockSplit.ts `lineageRekey`).
 * Seen on film (2026-11-16): a barge locked a rock with its mining lasers and
 * its tractors; the rock was cut, the locks followed the pieces, but at
 * ~150 s every lock was gone with a cut piece of the rock still drifting, and
 * the hold stalled. A laser lock on a piece that wore out into a pod ended
 * (the lasers leave pods) and a tractor lock on a pod taken in ended, though
 * the group never held the piece's live siblings (its lock capacity). While
 * any piece of the locked rock is alive, each group stays locked on it. A
 * pod is never a member (cargo pods, owner 2026-11-17: no weapon works a pod).
 */
import { describe, it, expect } from 'vitest';
import { LockSubsystem, type LockSubsystemDeps, type LockTargetView } from './LockSubsystem.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const ROOT = 7;

/** One pilot 'p1' in a barge (or `kindId`) at the origin, MAN groups. `targets`: live keys;
 *  `root`: each live member's lineage root; `pods`: which are pods (never members);
 *  `masses`: rock pieces with a mass (a free hold; others are field-rock sized). */
function harness(kindId = 'barge') {
  const targets = new Map<string, LockTargetView>();
  const root = new Map<string, number>();
  const pods = new Set<string>();
  const masses = new Map<string, number>();
  /** Keys a tractor dish of the ship has no clear line to (`tractorLineClear`). */
  const blocked = new Set<string>();
  const deps: LockSubsystemDeps = {
    resolveTarget: (_p, key, out) => {
      const t = targets.get(key);
      if (!t) return false;
      Object.assign(out, t);
      return true;
    },
    shooterPose: (_p, out) => { out.x = 0; out.y = 0; out.vx = 0; out.vy = 0; out.angle = 0; return true; },
    shipOf: () => ({ kind: getShipKind(kindId), activated: [] }),
    salvageOf: (_p, key, out) => {
      if (!targets.has(key)) return false;
      out.pod = pods.has(key);
      const m = masses.get(key);
      if (m === undefined) { out.mass = Infinity; out.holdWeight = Infinity; out.freeHold = 0; out.ore = undefined; return true; }
      out.mass = m; out.holdWeight = 500; out.freeHold = 1e9; out.qty = 1;
      out.ore = { rockId: 'r', resource: 'minerals' } as unknown as typeof out.ore;
      return true;
    },
    lineage: {
      rootOf: (key) => (targets.has(key) ? root.get(key) ?? -1 : -1),
      keysOf: (r, out) => {
        for (const k of targets.keys()) if (root.get(k) === r && !pods.has(k)) out.push(k);
      },
    },
    tractorLineClear: (_p, key) => !blocked.has(key),
    autoPick: () => null,
    commitHostileAct: () => {},
    refreshHostility: () => {},
  };
  const locks = new LockSubsystem(deps);
  locks.enable('p1', true, 'manual');
  const add = (key: string, pod = false, view: LockTargetView = rock()): void => {
    targets.set(key, view); root.set(key, ROOT);
    if (pod) pods.add(key);
  };
  const keys = (gid: string): string[] => locks.wireFor('p1')!.find((g) => g.id === gid)!.l.map((l) => l.t);
  return { locks, targets, add, keys, masses, blocked };
}

const rock = (): LockTargetView => ({ x: 600, y: 0, vx: 0, vy: 0, angle: 0, ship: false, kindId: null, shieldUp: false, radius: 60, hostile: false, terrain: true });

describe('a salvage lock ends with its lineage, not its piece', () => {
  /** Lock the rock 's:1' with both groups and cut it into 8 pieces (more than either group holds). */
  const cut = () => {
    const h = harness();
    h.targets.set('s:1', rock());
    for (const g of ['laser', 'tractor']) expect(h.locks.forceLock('p1', 's:1', g), g).toBeGreaterThan(0);
    h.locks.step();
    const pieces = ['s:11', 's:12', 's:13', 's:14', 's:15', 's:16', 's:17', 's:18'];
    for (const k of pieces) h.add(k);
    h.locks.targetSplit('s:1', pieces);
    h.targets.delete('s:1');
    h.locks.step();
    return { h, pieces };
  };

  it('pieces wearing out into pods one by one: both groups move on to the pieces they never held, never to a pod; both end only when the last piece is gone', () => {
    const { h, pieces } = cut();
    const laserCap = h.keys('laser').length;
    expect(laserCap, 'the lasers hold fewer than the pieces (so siblings go unheld)').toBeLessThan(pieces.length);
    const live = new Set(pieces);
    let n = 0;
    // Wear out whichever piece the lasers hold first, into a pod, until no piece is left.
    while (live.size > 0) {
      const k = h.keys('laser')[0]!;
      expect(live.has(k), `the lasers hold a live piece (${k})`).toBe(true);
      const pod = `s:${100 + n++}`;
      h.add(pod, true);
      h.targets.delete(k); live.delete(k);
      h.locks.step();
      if (live.size > 0) {
        expect(h.keys('laser').length, `lasers still locked with ${live.size} pieces left`).toBe(Math.min(laserCap, live.size));
        for (const l of h.locks.wireFor('p1')!.find((g) => g.id === 'laser')!.l) expect(l.s, `${l.t} stays LOCKED`).toBe(2);
      }
      for (const t of h.keys('tractor')) expect(live.has(t), `the tractors never lock a pod (${t})`).toBe(true);
      if (live.size > 0) expect(h.keys('tractor').length, 'the tractors stay locked').toBeGreaterThan(0);
    }
    expect(h.targets.size, 'the pods are still there').toBe(pieces.length);
    expect(h.keys('laser'), 'no piece left: the lasers end').toEqual([]);
    expect(h.keys('tractor'), 'no piece left: the tractors end (pods are not the lineage)').toEqual([]);
  });

  it('a held piece leaving with no split (taken in, or gone): the group moves on to a sibling it did not hold', () => {
    const { h } = cut();
    const before = h.keys('laser');
    const gone = before[0]!;
    h.targets.delete(gone);
    h.locks.step();
    const after = h.keys('laser');
    expect(after.length).toBe(before.length);
    expect(after).not.toContain(gone);
    expect(after.filter((k) => !before.includes(k)).length, 'one sibling it never held').toBe(1);
  });

  it('a cut that hands a group pieces it can not work: its locks move to free pieces it can (the tractors never idle on pieces too heavy to pull)', () => {
    // Seen in the barge-mining take (2026-11-17): the locks followed the biggest
    // pieces, so the tractor group held the uncut tier-none pieces and only one
    // haulable piece while five others sat unheld: one beam, the rest asleep.
    const h = harness();
    h.targets.set('s:1', rock());
    for (const g of ['laser', 'tractor']) expect(h.locks.forceLock('p1', 's:1', g), g).toBeGreaterThan(0);
    h.locks.step();
    const big = ['s:11', 's:12'];
    const haul = ['s:13', 's:14', 's:15', 's:16', 's:17', 's:18'];
    for (const k of big) { h.add(k); h.masses.set(k, 20_000); }
    for (const k of haul) { h.add(k); h.masses.set(k, 1_500); }
    h.locks.targetSplit('s:1', [...big, ...haul]); // biggest first
    h.targets.delete('s:1');
    h.locks.step();
    const held = h.keys('tractor');
    expect(held.length, 'the tractors hold fewer than the haulable pieces').toBeLessThan(haul.length);
    expect(held.filter((k) => big.includes(k)), 'no tractor lock on a piece too heavy to pull').toEqual([]);
  });

  it('a tractor lock whose line is blocked by another piece moves to a free piece it has a clear line to; the lasers stay (owner 2026-11-18: fixing the line is the pilot\'s job)', () => {
    // Seen in the barge-mining take (2026-11-18): with line of sight, a tractor
    // lock on a piece behind a big one pulled the big one, which never comes in.
    const h = harness();
    h.targets.set('s:1', rock());
    for (const g of ['laser', 'tractor']) expect(h.locks.forceLock('p1', 's:1', g), g).toBeGreaterThan(0);
    h.locks.step();
    const haul = ['s:13', 's:14', 's:15', 's:16', 's:17', 's:18', 's:19', 's:20'];
    for (const k of haul) { h.add(k); h.masses.set(k, 1_500); }
    h.locks.targetSplit('s:1', haul);
    h.targets.delete('s:1');
    h.locks.step();
    const tractors0 = h.keys('tractor');
    const lasers0 = h.keys('laser');
    expect(tractors0.length, 'the tractors hold fewer than the pieces').toBeLessThan(haul.length);
    const behind = tractors0[0]!;
    h.blocked.add(behind); // another piece drifts between the dish and it
    h.locks.step();
    const tractors1 = h.keys('tractor');
    expect(tractors1, 'the blocked lock moved on').not.toContain(behind);
    expect(tractors1.filter((k) => h.blocked.has(k)), 'no tractor lock on a blocked line').toEqual([]);
    expect(tractors1.length, 'same lock count').toBe(tractors0.length);
    expect(h.keys('laser'), 'a laser group never minds the tractor line').toEqual(lasers0);
    // Every free piece blocked too: the lock stays where it is.
    for (const k of haul) h.blocked.add(k);
    h.locks.step();
    expect(h.keys('tractor'), 'nothing clear to move to: it stays').toEqual(tractors1);
  });

  it('a lineage piece it can not track (crossing too fast): the lock idles on the lineage instead of dropping', () => {
    const h = harness('fighter');
    const crossing: LockTargetView = { ...rock(), x: 200, vy: 5000 };
    h.add('s:11', false, crossing);
    expect(h.locks.forceLock('p1', 's:11', 'primary')).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) h.locks.step(); // 4 s > the 1.5 s grace
    expect(h.keys('primary'), 'the lineage lock stays (an ordinary one drops: LockSubsystem.test.ts)').toEqual(['s:11']);
  });
});

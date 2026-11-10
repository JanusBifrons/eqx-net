import { describe, it, expect } from 'vitest';
import { LockSubsystem, type LockSubsystemDeps, type LockTargetView } from './LockSubsystem.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

/**
 * exp/fire-control P2 — the server lock rules, hand-rolled mocks (no server).
 * One player 'p1' in a fighter at the origin; targets are a map of key → view.
 */
function harness(kindId = 'fighter'): {
  locks: LockSubsystem;
  targets: Map<string, LockTargetView>;
  commits: string[];
  /** Every `refreshHostility` key, in order. */
  refreshes: string[];
  setAuto: (key: string | null) => void;
  /** The `anyTarget` flag of every `autoPick` call, in order. */
  anyTargetArgs: boolean[];
} {
  const targets = new Map<string, LockTargetView>();
  const commits: string[] = [];
  const refreshes: string[] = [];
  let auto: string | null = null;
  const anyTargetArgs: boolean[] = [];
  const deps: LockSubsystemDeps = {
    resolveTarget: (_p, key, out) => {
      const t = targets.get(key);
      if (!t) return false;
      Object.assign(out, t);
      return true;
    },
    shooterPose: (_p, out) => {
      out.x = 0; out.y = 0; out.vx = 0; out.vy = 0; out.angle = 0;
      return true;
    },
    shipOf: () => ({ kind: getShipKind(kindId), activated: [] }),
    autoPick: (_p, _r, _x, _y, bears, anyTarget) => {
      anyTargetArgs.push(anyTarget);
      if (auto === null) return null;
      const t = targets.get(auto);
      return t && bears(t.x, t.y) ? auto : null;
    },
    commitHostileAct: (_p, key) => commits.push(key),
    refreshHostility: (_p, key) => refreshes.push(key),
  };
  const locks = new LockSubsystem(deps);
  locks.enable('p1');
  return { locks, targets, commits, refreshes, setAuto: (k) => { auto = k; }, anyTargetArgs };
}

const still = (x: number, hostile: boolean): LockTargetView => ({ x, y: 0, vx: 0, vy: 0, signature: 30, hostile });
/** Lock-line bearing straight ahead (+y; ship-angle convention: forward = (-sin b, cos b)). */
const AHEAD = 0;
const steps = (l: LockSubsystem, n: number): void => { for (let i = 0; i < n; i++) l.step(); };

describe('LockSubsystem', () => {
  it('an untracked player has no locks, so it may not fire (lock-to-fire is universal)', () => {
    const h = harness();
    expect(h.locks.hasLocked('someone-else', 'primary')).toBe(false);
  });

  it('a hostile target locks after its lock time, then the group may fire', () => {
    const h = harness();
    h.targets.set('s:1', still(200, true));
    expect(h.locks.requestLock('p1', 'primary', 's:1')).toBe(true);
    expect(h.locks.hasLocked('p1', 'primary')).toBe(false);
    steps(h.locks, 40); // 4 s
    expect(h.locks.hasLocked('p1', 'primary')).toBe(true);
    expect(h.commits).toEqual([]);
  });

  it('a neutral target runs the failsafe; finishing it commits a hostile act once', () => {
    const h = harness();
    h.targets.set('s:2', still(200, false));
    h.locks.requestLock('p1', 'primary', 's:2');
    steps(h.locks, 80);
    expect(h.commits).toEqual(['s:2']);
    expect(h.locks.hasLocked('p1', 'primary')).toBe(true);
  });

  it('locks keep it hostile: a live lock on a hostile target refreshes hostility every step; a failsafe or a cancelled lock does not', () => {
    const h = harness();
    h.targets.set('s:9', still(200, true));
    h.targets.set('s:8', still(200, false));
    h.locks.requestLock('p1', 'primary', 's:9');
    steps(h.locks, 5); // acquiring counts
    expect(h.refreshes.length).toBe(5);
    steps(h.locks, 40); // locked counts
    expect(h.locks.hasLocked('p1', 'primary')).toBe(true);
    expect(h.refreshes.length).toBe(45);
    expect(new Set(h.refreshes)).toEqual(new Set(['s:9']));
    h.locks.cancelLock('p1', 'primary');
    h.locks.requestLock('p1', 'primary', 's:8'); // neutral: failsafe, no refresh
    h.refreshes.length = 0;
    steps(h.locks, 3);
    expect(h.refreshes).toEqual([]);
  });

  it('cancelling during the failsafe is harmless', () => {
    const h = harness();
    h.targets.set('s:3', still(200, false));
    h.locks.requestLock('p1', 'primary', 's:3');
    steps(h.locks, 3);
    h.locks.cancelLock('p1', 'primary', 's:3');
    steps(h.locks, 80);
    expect(h.commits).toEqual([]);
    expect(h.locks.hasLocked('p1', 'primary')).toBe(false);
  });

  it('auto groups acquire their own hostile target; manual groups do not', () => {
    const h = harness();
    h.targets.set('s:4', { x: 0, y: 200, vx: 0, vy: 0, signature: 30, hostile: true } /* ahead: inside the fixed guns' window */);
    h.setAuto('s:4');
    steps(h.locks, 40);
    expect(h.locks.hasLocked('p1', 'primary')).toBe(true);

    const m = harness();
    m.targets.set('s:4', { x: 0, y: 200, vx: 0, vy: 0, signature: 30, hostile: true } /* ahead: inside the fixed guns' window */);
    m.setAuto('s:4');
    m.locks.setMode('p1', 'primary', 'manual');
    steps(m.locks, 40);
    expect(m.locks.hasLocked('p1', 'primary')).toBe(false);
  });

  it('switching to MAN cancels the lock AUTO was still building, keeps a manual one', () => {
    // User report (1v3 clip, 2026-11-08): both groups ended up on the same
    // fighter because their AUTO locks were already building when the pilot
    // flipped them to MAN.
    const h = harness();
    h.targets.set('s:4', { x: 0, y: 200, vx: 0, vy: 0, signature: 30, hostile: true });
    h.setAuto('s:4');
    steps(h.locks, 1); // AUTO picks s:4 and starts acquiring
    expect(h.locks.wireFor('p1')?.find((g) => g.id === 'primary')?.l.length).toBe(1);
    h.setAuto(null);
    h.locks.setMode('p1', 'primary', 'manual');
    expect(h.locks.wireFor('p1')?.find((g) => g.id === 'primary')?.l.length ?? 0).toBe(0);
    steps(h.locks, 40);
    expect(h.locks.hasLocked('p1', 'primary')).toBe(false);

    // A lock the pilot asked for themselves survives the switch.
    const m = harness();
    m.targets.set('s:5', still(200, true));
    m.locks.requestLock('p1', 'primary', 's:5');
    steps(m.locks, 1);
    m.locks.setMode('p1', 'primary', 'manual');
    steps(m.locks, 40);
    expect(m.locks.hasLocked('p1', 'primary')).toBe(true);
  });

  it('a target that disappears is dropped; out of reach drops after grace', () => {
    const h = harness();
    h.targets.set('s:5', still(200, true));
    h.locks.requestLock('p1', 'primary', 's:5');
    steps(h.locks, 40);
    h.targets.delete('s:5');
    h.locks.step();
    expect(h.locks.wireFor('p1')![0]!.l).toHaveLength(0);

    h.targets.set('s:6', still(200, true));
    h.locks.requestLock('p1', 'primary', 's:6');
    steps(h.locks, 40);
    h.targets.set('s:6', still(50_000, true)); // far out of reach
    steps(h.locks, 20); // 2 s > 1.5 s grace
    expect(h.locks.hasLocked('p1', 'primary')).toBe(false);
  });

  it('an out-of-reach lock is marked blocked on the wire (c=1) until it is in reach again', () => {
    // User report (1v3 clip, 2026-11-08): LOCK in the info box "did nothing".
    // The target was out of reach: the lock sat at 0 % and dropped after the
    // grace with no feedback. The wire must say "can't lock" so the HUD can.
    const h = harness();
    h.targets.set('s:9', still(50_000, true));
    h.locks.requestLock('p1', 'primary', 's:9');
    steps(h.locks, 1);
    const wire = () => h.locks.wireFor('p1')?.find((g) => g.id === 'primary')?.l[0];
    expect(wire()?.c).toBe(1);
    h.targets.set('s:9', still(200, true)); // back in reach
    steps(h.locks, 1);
    expect(wire()?.c).toBeUndefined();
  });

  it('a full queue drops the oldest lock (fighter capacity 1)', () => {
    const h = harness();
    h.targets.set('s:7', still(200, true));
    h.targets.set('s:8', still(220, true));
    h.locks.requestLock('p1', 'primary', 's:7');
    h.locks.requestLock('p1', 'primary', 's:8');
    const wire = h.locks.wireFor('p1')!;
    expect(wire[0]!.l.map((l) => l.t)).toEqual(['s:8']);
  });

  it('aims each mount at its group target and writes the wire in place', () => {
    const h = harness();
    h.targets.set('s:9', still(200, true));
    h.locks.requestLock('p1', 'primary', 's:9');
    const mountId = getShipKind('fighter').mounts![0]!.id;
    expect(h.locks.aimKeyFor('p1', mountId)).toBe('s:9');
    const wire = h.locks.wireFor('p1')!;
    const ref = wire[0]!.l[0]!;
    steps(h.locks, 5);
    expect(h.locks.wireFor('p1')![0]!.l[0]).toBe(ref); // same object, progress updated
    expect(ref.p).toBeGreaterThan(0);
  });

  it('testMode instantLock: a lock completes on the next step (a failsafe still commits)', () => {
    const h = harness();
    h.locks.enable('p1', true);
    h.targets.set('s:1', still(200, false));
    h.locks.requestLock('p1', 'primary', 's:1');
    steps(h.locks, 1);
    expect(h.locks.hasLocked('p1', 'primary')).toBe(true);
    expect(h.commits).toEqual(['s:1']);
  });

  it('testMode instantLock alone does NOT widen AUTO targeting; anyTarget does', () => {
    const instantOnly = harness();
    instantOnly.locks.enable('p1', true);
    steps(instantOnly.locks, 3);
    expect(instantOnly.anyTargetArgs.length).toBeGreaterThan(0);
    expect(instantOnly.anyTargetArgs.every((a) => a === false)).toBe(true);

    const wide = harness();
    wide.locks.enable('p1', false, null, true);
    steps(wide.locks, 3);
    expect(wide.anyTargetArgs.length).toBeGreaterThan(0);
    expect(wide.anyTargetArgs.every((a) => a === true)).toBe(true);

    // Both together: AUTO wide AND the picked (neutral) target locks at once.
    const both = harness();
    both.locks.enable('p1', true, null, true);
    both.targets.set('s:1', { x: 0, y: 200, vx: 0, vy: 0, signature: 30, hostile: false });
    both.setAuto('s:1');
    steps(both.locks, 2);
    expect(both.anyTargetArgs.every((a) => a === true)).toBe(true);
    expect(both.locks.hasLocked('p1', 'primary')).toBe(true);
  });

  it('testMode groupMode=manual: every group starts in MAN and AUTO never self-picks', () => {
    const h = harness('missile-frigate');
    h.locks.enable('p1', true, 'manual');
    h.targets.set('s:1', { x: 0, y: 200, vx: 0, vy: 0, signature: 30, hostile: true }); // dead ahead
    h.setAuto('s:1');
    steps(h.locks, 5);
    const wire = h.locks.wireFor('p1')!;
    expect(wire.map((g) => g.id)).toEqual(['missiles', 'pd']);
    for (const g of wire) {
      expect(g.m).toBe(1);
      expect(g.l).toEqual([]);
      expect(h.locks.hasLocked('p1', g.id)).toBe(false);
    }
    // A group switched to AUTO afterwards picks + locks as usual.
    h.locks.setMode('p1', 'missiles', 'auto');
    steps(h.locks, 2);
    expect(h.locks.hasLocked('p1', 'missiles')).toBe(true);
    expect(h.locks.hasLocked('p1', 'pd')).toBe(false);
  });

  it('forceLock (integration test hook) locks every group at once, or one group', () => {
    const h = harness();
    h.targets.set('s:1', still(200, true));
    expect(h.locks.forceLock('p1', 's:1', 'nope')).toBe(0);
    expect(h.locks.forceLock('p1', 's:9')).toBe(0);
    expect(h.locks.forceLock('p1', 's:1')).toBeGreaterThan(0);
    expect(h.locks.hasLocked('p1', 'primary')).toBe(true);
    expect(h.locks.forceLock('nobody', 's:1')).toBe(0);
  });

  describe('held locks (the lock line)', () => {
    const pct = (h: ReturnType<typeof harness>): number => h.locks.wireFor('p1')![0]!.l[0]?.p ?? -1;
    const ahead = (y: number): LockTargetView => ({ x: 0, y, vx: 0, vy: 0, signature: 30, hostile: true });

    it('builds only while held: let go part-way and it drains back to 0, then drops', () => {
      const h = harness();
      h.targets.set('s:1', ahead(200));
      h.locks.trackLock('p1', 'primary', 's:1', AHEAD);
      steps(h.locks, 6);
      const built = pct(h);
      expect(built).toBeGreaterThan(10);
      expect(h.locks.hasLocked('p1', 'primary')).toBe(false);
      h.locks.trackLock('p1', 'primary', null); // let go
      steps(h.locks, 1);
      expect(pct(h)).toBeLessThan(built);
      expect(h.locks.wireFor('p1')![0]!.l[0]!.r).toBe(1);
      steps(h.locks, 40);
      expect(h.locks.wireFor('p1')![0]!.l.length).toBe(0);
    });

    it('the line coming back onto a draining target resumes it; held to the end it locks', () => {
      const h = harness();
      h.targets.set('s:1', ahead(200));
      h.locks.trackLock('p1', 'primary', 's:1', AHEAD);
      steps(h.locks, 5);
      h.locks.trackLock('p1', 'primary', null);
      steps(h.locks, 2);
      const low = pct(h);
      h.locks.trackLock('p1', 'primary', 's:1', AHEAD); // back on it
      steps(h.locks, 2);
      expect(pct(h)).toBeGreaterThan(low);
      expect(h.locks.wireFor('p1')![0]!.l[0]!.r).toBeUndefined();
      steps(h.locks, 40);
      expect(h.locks.hasLocked('p1', 'primary')).toBe(true);
      // Once locked, letting go keeps the lock.
      h.locks.trackLock('p1', 'primary', null);
      steps(h.locks, 30);
      expect(h.locks.hasLocked('p1', 'primary')).toBe(true);
    });

    it('lock_track is verified: a target off the claimed line (or with no bearing) is not held', () => {
      const h = harness();
      h.targets.set('s:1', ahead(200));
      h.locks.trackLock('p1', 'primary', 's:1', Math.PI / 2); // line points the other way
      steps(h.locks, 6);
      expect(h.locks.wireFor('p1')![0]!.l.length).toBe(0);
      h.locks.trackLock('p1', 'primary', 's:1'); // no bearing
      steps(h.locks, 6);
      expect(h.locks.wireFor('p1')![0]!.l.length).toBe(0);
      h.targets.set('s:2', ahead(5000)); // on the line but far past reach
      h.locks.trackLock('p1', 'primary', 's:2', AHEAD);
      steps(h.locks, 1);
      expect(h.locks.wireFor('p1')![0]!.l.length).toBe(0);
      h.locks.trackLock('p1', 'primary', 's:1', AHEAD); // on the line: held
      steps(h.locks, 1);
      expect(h.locks.wireFor('p1')![0]!.l[0]!.t).toBe('s:1');
    });

    it('a claim that leaves the line releases the held lock', () => {
      const h = harness();
      h.targets.set('s:1', ahead(200));
      h.locks.trackLock('p1', 'primary', 's:1', AHEAD);
      steps(h.locks, 4);
      h.locks.trackLock('p1', 'primary', 's:1', Math.PI); // same key, line now behind
      steps(h.locks, 1);
      expect(h.locks.wireFor('p1')![0]!.l[0]!.r).toBe(1);
    });

    it('a draining held lock pressed with Lock (requestLock) now runs to completion', () => {
      const h = harness();
      h.targets.set('s:1', ahead(200));
      h.locks.trackLock('p1', 'primary', 's:1', AHEAD);
      steps(h.locks, 4);
      h.locks.trackLock('p1', 'primary', null);
      h.locks.requestLock('p1', 'primary', 's:1');
      steps(h.locks, 40);
      expect(h.locks.hasLocked('p1', 'primary')).toBe(true);
    });
  });

  it('AUTO only picks a target inside the group arc (gunship Aft ignores a ship dead ahead)', () => {
    const h = harness('gunship');
    h.targets.set('s:9', { x: 0, y: 300, vx: 0, vy: 0, signature: 30, hostile: true });
    h.setAuto('s:9');
    steps(h.locks, 3);
    const wire = h.locks.wireFor('p1')!;
    expect(wire.find((g) => g.id === 'fore')!.l.length).toBe(1);
    expect(wire.find((g) => g.id === 'aft')!.l.length).toBe(0);
    // Behind the ship: Aft takes it, Fore doesn't.
    h.targets.set('s:9', { x: 0, y: -300, vx: 0, vy: 0, signature: 30, hostile: true });
    h.locks.cancelLock('p1', 'fore');
    steps(h.locks, 3);
    const w2 = h.locks.wireFor('p1')!;
    expect(w2.find((g) => g.id === 'aft')!.l.length).toBe(1);
  });
});

describe('LockSubsystem capital turret split (PR 1d slice 4)', () => {
  it('a 3-lock capital group spreads its turrets across the locked targets', () => {
    const h = harness('destroyer');
    // Three hostiles on the starboard beam, where every main turret bears.
    h.targets.set('s:1', { ...still(1500, true), y: 0 });
    h.targets.set('s:2', { ...still(1500, true), y: 400 });
    h.targets.set('s:3', { ...still(1500, true), y: -400 });
    for (const k of ['s:1', 's:2', 's:3']) expect(h.locks.forceLock('p1', k, 'main')).toBe(1);
    const aims = ['main-1', 'main-2', 'main-3'].map((m) => h.locks.aimKeyFor('p1', m));
    // Same rule as the client (shared pickTurretLock): turret i takes lock i % n.
    expect(aims).toEqual(['s:1', 's:2', 's:3']);
    expect(h.locks.aimKeyFor('p1', 'main-4')).toBe('s:1');
    expect(h.locks.aimKeyFor('p1', 'main-5')).toBe('s:2');
  });

  it('a one-lock group aims every turret at it (unchanged)', () => {
    const h = harness('destroyer');
    h.targets.set('s:1', { ...still(1500, true), y: 0 });
    h.locks.forceLock('p1', 's:1', 'main');
    for (const m of ['main-1', 'main-2', 'main-3', 'main-4', 'main-5']) expect(h.locks.aimKeyFor('p1', m)).toBe('s:1');
  });
});

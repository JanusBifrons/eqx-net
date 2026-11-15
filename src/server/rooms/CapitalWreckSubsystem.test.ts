/**
 * Capital destruction S2a: the hit tracker + death → wreck spawn decisions,
 * driven with plain mocks (no room, no worker).
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { WEAPONS, type WeaponId, type WeaponKillCut } from '../../core/combat/WeaponCatalogue.js';
import { shipShapeScale } from '../../core/geometry/shipHullOutline.js';
import { buildWreckPieces, hullLocalCutAngle, WRECK_ANGULAR_DAMPING, WRECK_LINEAR_DAMPING, WRECK_RECENT_DAMAGE_TICKS } from '../../core/destruction/wreckPieces.js';
import { SUBCAP_WRECK_COLLISION_GROUPS, WRECK_COLLISION_GROUPS } from '../../core/physics/collisionGroups.js';
import { DESTRUCTION_PROFILES } from '../../shared-types/shipScale/destruction.js';
import { wreckCrackTicks } from '../../shared-types/wreckTiming.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';

function make(kinds: Record<string, string> = { cap: 'battleship' }, withRigid = false, owners: Record<string, string> = {}) {
  const rigid: Array<{ ids: readonly string[]; jx: number; jy: number; px: number; py: number }> = [];
  let tick = 1000;
  const spawned: WreckPieceSpawn[] = [];
  const live = new Set<string>();
  const removed: string[] = [];
  const angles = new Map<string, number>();
  const kicks: Array<{ id: string; dvx: number; dvy: number; dw: number; tick: number }> = [];
  const impulses: Array<{ id: string; jx: number; jy: number; px: number; py: number }> = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => tick,
    wreckKindOf: (id) => (kinds[id] as 'battleship' | undefined) ?? null,
    ownerOf: (id) => owners[id],
    positionOf: (id) => (id === 'attacker' ? { x: 5000, y: 0 } : null),
    spawnPiece: (s) => { spawned.push(s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); removed.push(id); },
    isLive: (id) => live.has(id),
    pieceAngle: (id) => (live.has(id) ? angles.get(id) ?? 0 : null),
    kickPiece: (id, dvx, dvy, dw) => { kicks.push({ id, dvx, dvy, dw, tick }); },
    impulsePiece: (id, jx, jy, px, py) => { impulses.push({ id, jx, jy, px, py }); },
    pieceCentreInto: (id, out) => {
      const s = spawned.find((p) => p.id === id);
      if (s === undefined || !live.has(id)) return false;
      out.x = s.x; out.y = s.y;
      return true;
    },
    ...(withRigid ? { impulseWreck: (ids: readonly string[], jx: number, jy: number, px: number, py: number) => { rigid.push({ ids, jx, jy, px, py }); } } : {}),
  });
  return { sys, spawned, removed, kicks, impulses, rigid, angles, live, setTick: (t: number) => { tick = t; } };
}

const pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

/** Give a catalogue weapon a kill cut for `fn` (no weapon has one yet), then
 *  restore the record. */
function withKillCut(id: WeaponId, cut: WeaponKillCut, fn: () => void): void {
  const def = WEAPONS.get(id)!;
  const had = 'killCut' in def;
  const prev = def.killCut;
  def.killCut = cut;
  try { fn(); } finally {
    if (had) def.killCut = prev; else delete def.killCut;
  }
}

describe('CapitalWreckSubsystem', () => {
  it('feeds the last hit point, the final blow and the recent damage into the fracture', () => {
    const { sys, spawned, setTick } = make();
    sys.forcedSeed = 9;
    setTick(100);
    sys.noteHit('cap', 'attacker', 500, 10, 20); // long ago: outside the window
    setTick(100 + WRECK_RECENT_DAMAGE_TICKS * 3);
    sys.noteHit('cap', 'attacker', 1000, 300, -200);
    sys.noteHit('cap', 'attacker', 2000, 120, 40);
    const n = sys.onDeath('cap', 'battleship', pose, 10_000).pieces;
    const want = buildWreckPieces({
      kindId: 'battleship', pose, killWorld: { x: 120, y: 40 }, attackerWorld: { x: 5000, y: 0 },
      seed: 9, killBlowDamage: 0.2, recentDamageRate: 0.3,
    }).pieces;
    expect(n).toBe(want.length);
    expect(spawned.map((s) => [s.x, s.y, s.vx, s.vy])).toEqual(want.map((p) => [p.x, p.y, p.vx, p.vy]));
  });

  it('keeps the last hit\'s direction and weapon, reusing the pooled entry', () => {
    const { sys } = make();
    expect(sys.lastHit('cap')).toBeNull();
    sys.noteHit('cap', 'attacker', 100, 10, 20, 0.6, -0.8, 'naval_l');
    const first = sys.lastHit('cap')!;
    expect(first).toMatchObject({ hasPoint: true, x: 10, y: 20, hasDir: true, dirX: 0.6, dirY: -0.8, weaponId: 'naval_l', shooterId: 'attacker' });
    // A later hit with no direction or weapon (a ram, a mine) overwrites both.
    sys.noteHit('cap', 'rammer', 50, undefined, undefined);
    const second = sys.lastHit('cap')!;
    expect(second).toBe(first); // same pooled object: no allocation per hit
    expect(second).toMatchObject({ hasPoint: false, hasDir: false, dirX: 0, dirY: 0, weaponId: null, shooterId: 'rammer' });
    // A zero direction is no direction.
    sys.noteHit('cap', 'attacker', 50, 1, 1, 0, 0, 'laser');
    expect(sys.lastHit('cap')).toMatchObject({ hasDir: false, weaponId: 'laser' });
    // Non-capitals are not tracked.
    sys.noteHit('fighter', 'attacker', 50, 0, 0, 1, 0, 'laser');
    expect(sys.lastHit('fighter')).toBeNull();
  });

  it('a kill by a killCut weapon puts the cut (hull-frame angle, 1× width) in the fracture and the descriptor', () => {
    const turned = { ...pose, angle: 0.7 };
    const dir = { x: 0.6, y: -0.8 };
    const ang = hullLocalCutAngle(turned, dir);
    for (const cut of [{ kind: 'slice' } as const, { kind: 'channel', width: 120 } as const]) {
      withKillCut('laser', cut, () => {
        const { sys, spawned } = make();
        sys.forcedSeed = 9;
        sys.noteHit('cap', 'attacker', 2000, 120, 40, dir.x, dir.y, 'laser');
        expect(sys.onDeath('cap', 'battleship', turned, 10_000).pieces).toBeGreaterThan(0);
        const cutW = cut.kind === 'channel' ? cut.width / shipShapeScale(getShipKind('battleship')) : undefined;
        const d = sys.descriptors()[0]!;
        expect(d.cutKind).toBe(cut.kind);
        expect(d.cutAng).toBe(ang);
        expect(d.cutW).toBe(cutW);
        if (cutW === undefined) expect('cutW' in d).toBe(false);
        // The spawned pieces are the cut fracture's.
        const want = buildWreckPieces({
          kindId: 'battleship', pose: turned, killWorld: { x: 120, y: 40 }, attackerWorld: { x: 5000, y: 0 },
          seed: 9, killBlowDamage: 0.2, recentDamageRate: 0.2, cutKind: cut.kind, cutAng: ang, cutW,
        }).pieces;
        expect(spawned.map((s) => [s.x, s.y])).toEqual(want.map((p) => [p.x, p.y]));
      });
    }
  });

  // Filmed 2026-11-15: a pilot's capital broke into flat grey pieces under
  // the default livery; the client had no owner for the wreck, so it asked
  // for a new (neutral) bake instead of the one the live hull wore.
  it("the descriptor names the hull's owner (the livery its pieces wear); none when unknown", () => {
    const { sys } = make({ cap: 'battleship', npc: 'battleship' }, false, { cap: 'player-7' });
    sys.onDeath('cap', 'battleship', pose, 10_000);
    sys.onDeath('npc', 'battleship', { ...pose, x: 90_000 }, 10_000);
    const [a, b] = sys.descriptors();
    expect(a!.owner).toBe('player-7');
    expect('owner' in b!).toBe(false);
  });

  it('without a killCut weapon (or with no shot direction) the descriptor carries no cut', () => {
    const run = (dirX: number | undefined, weapon: 'laser' | undefined) => {
      const { sys } = make();
      sys.forcedSeed = 9;
      sys.noteHit('cap', 'attacker', 2000, 120, 40, dirX, dirX === undefined ? undefined : 0, weapon);
      sys.onDeath('cap', 'battleship', pose, 10_000);
      return sys.descriptors()[0]!;
    };
    const plain = run(1, 'laser');
    for (const k of ['cutKind', 'cutAng', 'cutW']) expect(k in plain).toBe(false);
    withKillCut('laser', { kind: 'slice' }, () => {
      // No direction (splash) or no weapon (ram): the normal break-up.
      expect(run(undefined, 'laser')).toEqual(plain);
      expect(run(1, undefined)).toEqual(plain);
      expect(run(1, 'laser').cutKind).toBe('slice');
    });
  });

  it('a cut kill splits at once: no crack hold, the kick is in the spawn motion, no rigid hold', () => {
    for (const cut of [{ kind: 'slice' } as const, { kind: 'channel', width: 120 } as const]) {
      withKillCut('laser', cut, () => {
        const { sys, spawned, kicks, rigid, impulses } = make({ cap: 'battleship' }, true);
        sys.forcedSeed = 9;
        sys.noteHit('cap', 'attacker', 2000, 120, 40, 1, 0, 'laser');
        const n = sys.onDeath('cap', 'battleship', pose, 10_000).pieces;
        const cutW = cut.kind === 'channel' ? cut.width / shipShapeScale(getShipKind('battleship')) : undefined;
        const want = buildWreckPieces({
          kindId: 'battleship', pose, killWorld: { x: 120, y: 40 }, attackerWorld: { x: 5000, y: 0 },
          seed: 9, killBlowDamage: 0.2, recentDamageRate: 0.2, cutKind: cut.kind, cutAng: hullLocalCutAngle(pose, { x: 1, y: 0 }), cutW,
        }).pieces;
        expect(n).toBe(want.length);
        expect(sys.pendingKicks()).toBe(0);
        for (let i = 0; i < n; i++) {
          expect(spawned[i]!.vx).toBeCloseTo(want[i]!.vx + want[i]!.kickVx, 9);
          expect(spawned[i]!.vy).toBeCloseTo(want[i]!.vy + want[i]!.kickVy, 9);
          expect(spawned[i]!.angvel).toBeCloseTo(want[i]!.angvel + want[i]!.kickAngvel, 9);
        }
        sys.tick();
        expect(kicks).toHaveLength(0);
        // A hit right after the kill shoves the piece hit, never the whole wreck.
        expect(sys.onWreckHit(spawned[0]!.id, 0, 0, 1, 0, 500)).toBe(true);
        expect(rigid).toHaveLength(0);
        expect(impulses).toHaveLength(1);
      });
    }
  });

  it('ignores hits on non-capitals and breaks a hull once per death tick', () => {
    const { sys, spawned } = make();
    sys.noteHit('fighter', 'attacker', 50, 0, 0);
    expect(sys.onDeath('cap', 'battleship', pose, 10_000).pieces).toBeGreaterThan(0);
    const first = spawned.length;
    expect(sys.onDeath('cap', 'battleship', pose, 10_000)).toEqual({ pieces: 0, vaporised: false });
    expect(spawned.length).toBe(first);
  });

  it('with no hit point the kill point is the hull edge nearest the attacker', () => {
    const { sys, spawned } = make();
    sys.forcedSeed = 3;
    sys.noteHit('cap', 'attacker', 100_000, undefined, undefined);
    sys.onDeath('cap', 'battleship', pose, 10_000);
    const want = buildWreckPieces({
      kindId: 'battleship', pose, killWorld: { x: 5000, y: 0 }, attackerWorld: null,
      seed: 3, killBlowDamage: 10, recentDamageRate: 10,
    }).pieces;
    expect(spawned.length).toBe(want.length);
  });

  it('holds the pieces together for the crack delay (game ticks), then kicks each once, turned with the hull', () => {
    const { sys, spawned, kicks, angles, live, setTick } = make();
    sys.forcedSeed = 9;
    setTick(2000);
    sys.noteHit('cap', 'attacker', 2000, 120, 40);
    const deathPose = { ...pose, angle: 0.3 };
    const n = sys.onDeath('cap', 'battleship', deathPose, 10_000).pieces;
    const want = buildWreckPieces({
      kindId: 'battleship', pose: deathPose, killWorld: { x: 120, y: 40 }, attackerWorld: { x: 5000, y: 0 },
      seed: 9, killBlowDamage: 0.2, recentDamageRate: 0.2,
    }).pieces;
    expect(n).toBe(want.length);
    // Spawned with the dead hull's rigid motion (at rest here): no kick yet.
    for (const s of spawned) expect([s.vx, s.vy, s.angvel]).toEqual([0, 0, 0]);
    setTick(2000 + wreckCrackTicks() - 1);
    sys.tick();
    expect(kicks).toHaveLength(0);
    // One piece is gone before the split; another has turned 0.5 rad.
    live.delete(spawned[0]!.id);
    angles.set(spawned[1]!.id, 0.3 + 0.5);
    setTick(2000 + wreckCrackTicks());
    sys.tick();
    expect(kicks).toHaveLength(n - 1);
    expect(sys.pendingKicks()).toBe(0);
    const k1 = kicks.find((k) => k.id === spawned[1]!.id)!;
    const p1 = want[1]!;
    expect(k1.dvx).toBeCloseTo(p1.kickVx * Math.cos(0.5) - p1.kickVy * Math.sin(0.5), 9);
    expect(k1.dvy).toBeCloseTo(p1.kickVx * Math.sin(0.5) + p1.kickVy * Math.cos(0.5), 9);
    expect(k1.dw).toBe(p1.kickAngvel);
    sys.tick();
    expect(kicks).toHaveLength(n - 1); // once only
  });

  it('an overkill hit on a piece posts an impulse along the shot at the hit point, capped at wreckKnockMax', () => {
    const { sys, spawned: pieces, impulses } = make();
    sys.forcedSeed = 9;
    const maxHull = 10_000;
    sys.onDeath('cap', 'battleship', pose, maxHull);
    const hullMass = pieces.reduce((s, p) => s + p.mass, 0);
    const t = shipTuning(getShipKind('battleship'));
    const big = pieces.reduce((a, b) => (b.mass > a.mass ? b : a));
    const small = pieces.reduce((a, b) => (b.mass < a.mass ? b : a));

    // A 16" shell on the biggest piece: J = damage × hull mass × knock ÷ max hull, along the shot.
    expect(sys.onWreckHit(big.id, 10, 20, 3, 4, 1400)).toBe(true);
    const j = 1400 * hullMass * t.wreckKnockSpeed / maxHull;
    expect(impulses[0]!.id).toBe(big.id);
    expect(impulses[0]!.jx).toBeCloseTo(j * 0.6, 6);
    expect(impulses[0]!.jy).toBeCloseTo(j * 0.8, 6);
    expect([impulses[0]!.px, impulses[0]!.py]).toEqual([10, 20]);
    expect(j / big.mass).toBeLessThan(t.wreckKnockMax);

    // A huge blow on the smallest piece is capped: its speed change is wreckKnockMax.
    expect(sys.onWreckHit(small.id, 0, 0, 1, 0, 1e7)).toBe(true);
    expect(impulses[1]!.jx / small.mass).toBeCloseTo(t.wreckKnockMax, 6);

    // Not a piece, no damage, no direction, or gone: nothing.
    expect(sys.onWreckHit('cap', 0, 0, 1, 0, 1400)).toBe(false);
    expect(sys.onWreckHit(big.id, 0, 0, 1, 0, 0)).toBe(false);
    expect(sys.onWreckHit(big.id, 0, 0, 0, 0, 1400)).toBe(false);
    sys.pieceGone(big.id);
    expect(sys.onWreckHit(big.id, 0, 0, 1, 0, 1400)).toBe(false);
    expect(impulses).toHaveLength(2);
  });

  it('during the crack hold a hit shoves the WHOLE wreck as one body; after it, only the piece hit', () => {
    const { sys, spawned: pieces, impulses, rigid, setTick } = make({ cap: 'battleship' }, true);
    sys.forcedSeed = 9;
    const maxHull = 10_000;
    setTick(5000);
    sys.onDeath('cap', 'battleship', pose, maxHull);
    const hullMass = pieces.reduce((s, p) => s + p.mass, 0);
    const t = shipTuning(getShipKind('battleship'));
    const small = pieces.reduce((a, b) => (b.mass < a.mass ? b : a));
    const j = 1400 * hullMass * t.wreckKnockSpeed / maxHull;

    // Inside the hold: every piece of the wreck, the same impulse, nothing single.
    setTick(5000 + wreckCrackTicks() - 1);
    expect(sys.onWreckHit(small.id, 10, 20, 3, 4, 1400)).toBe(true);
    expect(impulses).toHaveLength(0);
    expect(rigid).toHaveLength(1);
    expect([...rigid[0]!.ids].sort()).toEqual(pieces.map((p) => p.id).sort());
    expect(rigid[0]!.jx).toBeCloseTo(j * 0.6, 6);
    expect(rigid[0]!.jy).toBeCloseTo(j * 0.8, 6);
    expect([rigid[0]!.px, rigid[0]!.py]).toEqual([10, 20]);
    // The cap is on the whole wreck's speed change.
    expect(sys.onWreckHit(small.id, 0, 0, 1, 0, 1e9)).toBe(true);
    expect(rigid[1]!.jx / hullMass).toBeCloseTo(t.wreckKnockMax, 6);

    // From the split on: the piece alone (#542).
    setTick(5000 + wreckCrackTicks());
    expect(sys.onWreckHit(small.id, 0, 0, 1, 0, 1400)).toBe(true);
    expect(rigid).toHaveLength(2);
    expect(impulses).toHaveLength(1);
    expect(impulses[0]!.id).toBe(small.id);
  });

  it('a hit on a sub-cap piece turns it by the profile spinScale of the lever arm; a capital piece by all of it', () => {
    // Owner on the v5 film (2026-11-13): "they spin too much when destroyed".
    // The rest of a salvo lands on the fresh pieces, and an off-centre shove
    // at full lever arm set a fighter's half spinning at ~100 °/s a hit.
    const { sys, spawned, impulses } = make({ f: 'fighter', cap: 'battleship' });
    sys.forcedSeed = 3;
    sys.onDeath('f', 'fighter', pose, 300);
    const piece = spawned[0]!;
    expect(sys.onWreckHit(piece.id, piece.x + 10, piece.y - 4, 0, 1, 50)).toBe(true);
    const s = DESTRUCTION_PROFILES.subcap.spinScale;
    expect(s).toBeLessThan(1);
    expect(impulses[0]!.px).toBeCloseTo(piece.x + 10 * s, 9);
    expect(impulses[0]!.py).toBeCloseTo(piece.y - 4 * s, 9);

    const before = spawned.length;
    sys.onDeath('cap', 'battleship', pose, 10_000);
    const cp = spawned[before]!;
    sys.onWreckHit(cp.id, cp.x + 10, cp.y - 4, 0, 1, 50);
    // Capital: in its crack hold with no rigid hook, the piece takes it at the hit point.
    expect([impulses[1]!.px, impulses[1]!.py]).toEqual([cp.x + 10, cp.y - 4]);
  });
});

describe('CapitalWreckSubsystem — sub-capital profile (sub-cap break-up slice 2)', () => {
  it('a sub-capital parts at once: the kick is in the spawn motion, no pending kick, no rigid hold', () => {
    const { sys, spawned, kicks, rigid, impulses } = make({ f: 'fighter' }, true);
    sys.forcedSeed = 11;
    const at = { x: 100, y: -50, vx: 30, vy: -10, angle: 0.4, angvel: 0.5 };
    const n = sys.onDeath('f', 'fighter', at, 1000).pieces;
    const want = buildWreckPieces({ kindId: 'fighter', pose: at, killWorld: null, attackerWorld: null, seed: 11, killBlowDamage: 0, recentDamageRate: 0 }).pieces;
    expect(n).toBe(want.length);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(3);
    expect(sys.pendingKicks()).toBe(0);
    for (let i = 0; i < n; i++) {
      expect(spawned[i]!.vx).toBeCloseTo(want[i]!.vx + want[i]!.kickVx, 9);
      expect(spawned[i]!.vy).toBeCloseTo(want[i]!.vy + want[i]!.kickVy, 9);
      expect(spawned[i]!.angvel).toBeCloseTo(want[i]!.angvel + want[i]!.kickAngvel, 9);
      // The profile's body: damped ×10, pieces ignore each other.
      expect(spawned[i]!.collisionGroups).toBe(SUBCAP_WRECK_COLLISION_GROUPS);
      expect(spawned[i]!.linearDamping).toBeCloseTo(WRECK_LINEAR_DAMPING * DESTRUCTION_PROFILES.subcap.dampingScale, 12);
    }
    sys.tick();
    expect(kicks).toHaveLength(0);
    // A hit right after the kill shoves the single piece (overkill knock-back),
    // never the whole wreck: there is no hold.
    expect(sys.onWreckHit(spawned[0]!.id, 0, 0, 1, 0, 500)).toBe(true);
    expect(rigid).toHaveLength(0);
    expect(impulses).toHaveLength(1);
  });

  it('a capital keeps its hold, collides and is damped as before', () => {
    const { sys, spawned } = make();
    sys.onDeath('cap', 'battleship', pose, 10_000);
    expect(sys.pendingKicks()).toBe(spawned.length);
    for (const s of spawned) {
      expect(s.collisionGroups).toBe(WRECK_COLLISION_GROUPS);
      expect(s.linearDamping).toBe(WRECK_LINEAR_DAMPING);
      expect(s.angularDamping).toBe(WRECK_ANGULAR_DAMPING);
    }
  });

  it('the sub-cap FIFO evicts its own oldest pieces and never a capital piece', () => {
    const kinds: Record<string, string> = { cap: 'battleship' };
    for (let i = 0; i < 6; i++) kinds[`f${i}`] = 'fighter';
    const { sys, spawned, removed, setTick } = make(kinds);
    sys.subcapCapOverride = 5;
    sys.onDeath('cap', 'battleship', pose, 10_000);
    const capital = spawned.map((s) => s.id);
    const perDeath: string[][] = [];
    for (let i = 0; i < 6; i++) {
      setTick(2000 + i);
      const before = spawned.length;
      sys.onDeath(`f${i}`, 'fighter', { ...pose, x: i * 500 }, 1000);
      perDeath.push(spawned.slice(before).map((s) => s.id));
    }
    expect(sys.liveSubcapCount()).toBe(5);
    expect(sys.liveCount()).toBe(capital.length + 5);
    for (const id of capital) expect(removed).not.toContain(id);
    // Oldest first: the evicted ids are a prefix of the sub-cap spawn order.
    const order = perDeath.flat();
    expect(removed).toEqual(order.slice(0, removed.length));
    expect(removed.length).toBe(order.length - 5);
  });
});

describe('CapitalWreckSubsystem: a cut kill that burns every piece away (fracture v11)', () => {
  it('a heavy-beam kill on a fighter is vaporised: no piece, no descriptor, the dying body still despawned', () => {
    const { sys, spawned } = make({ f: 'fighter' });
    let despawns = 0;
    sys.noteHit('f', 'attacker', 500, 10, 0, -1, 0, 'heavy_beam');
    expect(sys.onDeath('f', 'fighter', pose, 300, () => { despawns++; })).toEqual({ pieces: 0, vaporised: true });
    expect(spawned).toHaveLength(0);
    expect(sys.descriptors()).toHaveLength(0);
    expect(despawns).toBe(1);
  });

  it('a heavy-beam kill on a heavy cruiser leaves its hulks; an un-cut death with no pieces is never vaporised', () => {
    const { sys, spawned } = make({ c: 'heavy-cruiser' });
    sys.noteHit('c', 'attacker', 5000, 300, 0, -1, 0, 'heavy_beam');
    const out = sys.onDeath('c', 'heavy-cruiser', pose, 20_000);
    expect(out.vaporised).toBe(false);
    expect(out.pieces).toBeGreaterThanOrEqual(2);
    expect(spawned.length).toBe(out.pieces);
  });
});

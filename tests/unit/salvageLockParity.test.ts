/**
 * Mining lasers on salvage locks, server vs client (#15): the server's
 * `LockSubsystem.aimKeyFor` (lock entries' salvage bits from its
 * `salvageOf` dep) and the client's `FcMountPicker` (the same bits read off
 * the own-ship wire lock `f`) must pick the same aim key per mount, and
 * both must give NO aim when every lock is a piece a tractor of the
 * laser's own size can take (the size ladder: lasers leave those to the
 * tractors, a separate group), and a tractor none for a piece too big for
 * its size. Fails when either side drops the bits or keeps the one-lock
 * shortcut for a salvage lock.
 */
import { describe, it, expect } from 'vitest';
import { LockSubsystem, type LockTargetView } from '../../src/server/rooms/LockSubsystem';
import type { LockSalvageView } from '../../src/server/rooms/lockSalvage';
import { FcMountPicker, fcNeedsPick, type FcMountDef, type FcWireLock } from '../../src/client/net/fcMountPick';
import { getShipKind, type ShipKind, type WeaponMount } from '../../src/shared-types/shipKinds';
import { mountWeaponReach } from '../../src/core/combat/mountReach';
import { fillRangeShape } from '../../src/core/combat/fireControlBearing';
import { LOCK_CONSUMABLE, LOCK_SALVAGE, lockTierBits } from '../../src/core/combat/turretLockPick';

/** A destroyer refitted as a salvager: `main` = 5 S mining lasers, `aa` = 4 AA tractors. */
function salvager(): ShipKind {
  const base = getShipKind('destroyer');
  const mounts: WeaponMount[] = (base.mounts ?? []).map((m) => ({ ...m, weaponId: m.id.startsWith('main') ? 'mining_laser' : 'tractor' }));
  return { ...base, mounts };
}

const piece = (x: number, y: number, radius: number): LockTargetView => ({
  x, y, vx: 0, vy: 0, angle: 0, ship: false, kindId: null, shieldUp: false, radius, hostile: false, terrain: true,
});

/** `ship`: a ship lock (not salvage); `hidden`: outside the client's mirror (AOI).
 *  Tiers by mass: ≤ 60 AA (the AA tractors take it, the S lasers leave it),
 *  ≤ 150 S, ≤ 375 M (the S lasers cut it, the AA tractors can't pull it). */
const AA_TIER = LOCK_SALVAGE | lockTierBits(1);
const M_TIER = LOCK_SALVAGE | lockTierBits(3);
/** An AA-tier piece is consumable (hold size) unless its `holdWeight` exceeds the free hold (`rig`'s `free`, 100). */
type Entry = { t: LockTargetView; mass: number; holdWeight: number; ship?: true; hidden?: true };

function rig(pieces: Record<string, Entry>, free = { v: 100 }) {
  const kind = salvager();
  const locks = new LockSubsystem({
    resolveTarget: (_p, key, out) => { const e = pieces[key]; if (!e) return false; Object.assign(out, e.t); return true; },
    shooterPose: (_p, out) => { out.x = 0; out.y = 0; out.vx = 0; out.vy = 0; out.angle = 0; return true; },
    shipOf: () => ({ kind, activated: [] }),
    autoPick: () => null,
    commitHostileAct: () => {},
    refreshHostility: () => {},
    salvageOf: (_p, key, out: LockSalvageView) => {
      const e = pieces[key];
      if (!e || e.ship) return false;
      out.mass = e.mass; out.radius = e.t.radius; out.holdWeight = e.holdWeight; out.freeHold = free.v;
      return true;
    },
  });
  locks.enable('p1', false, 'manual');
  const client = new FcMountPicker(
    (key, out) => { const e = pieces[key]; if (!e || e.hidden) return false; Object.assign(out, e.t); return true; },
    (key, out) => { const t = pieces[key]!.t; fillRangeShape(out, 0, false, null, false, t.radius); },
  );
  const defs = new Map<string, { def: FcMountDef; group: string }>();
  for (const slot of kind.slots ?? []) {
    const group = slot.mountIds.map((id) => kind.mounts!.find((m) => m.id === id)!);
    group.forEach((m, ordinal) => defs.set(m.id, { group: slot.id, def: { mount: m, ordinal, reach: mountWeaponReach(m), group } }));
  }
  /** [server, client] aim key of every mount of `groupId`. */
  const aims = (groupId: string): Array<[string | null, string | null]> => {
    const wire = locks.wireFor('p1')!.find((g) => g.id === groupId)!.l as FcWireLock[];
    const out: Array<[string | null, string | null]> = [];
    for (const [id, { def, group }] of defs) {
      if (group !== groupId) continue;
      const first = wire.find((l) => l.s === 2)?.t ?? null;
      const c = fcNeedsPick(wire) ? client.pick(wire, def, 0, 0, 0, first) : first;
      out.push([locks.aimKeyFor('p1', id), c]);
    }
    return out;
  };
  return { locks, aims };
}

describe('salvage lock pick: server LockSubsystem ⇔ client FcMountPicker', () => {
  it('lasers spread over the cuttable pieces and skip the AA-tier one, the same on both sides', () => {
    const { locks, aims } = rig({
      's:1': { t: piece(1500, 0, 120), mass: 1e9, holdWeight: 500 }, // too heavy for any tractor
      's:2': { t: piece(1500, 400, 40), mass: 1, holdWeight: 500 }, // AA tier, too heavy for the free hold (not consumable)
      's:3': { t: piece(1500, -400, 60), mass: 1e9, holdWeight: 5 },
    });
    for (const k of ['s:1', 's:2', 's:3']) expect(locks.forceLock('p1', k, 'main')).toBe(1);
    const wire = locks.wireFor('p1')!.find((g) => g.id === 'main')!.l;
    expect(wire.map((l) => l.f)).toEqual([LOCK_SALVAGE, AA_TIER, LOCK_SALVAGE]);
    const a = aims('main');
    for (const [s, c] of a) expect(c).toBe(s);
    // S lasers prefer small pieces: they share out from the small end.
    expect(a.map(([s]) => s)).toEqual(['s:3', 's:1', 's:3', 's:1', 's:3']);
  });

  it('every lock AA tier: no S laser aims (so none fires), on both sides; the AA tractors still aim', () => {
    const { locks, aims } = rig({
      's:1': { t: piece(1500, 0, 50), mass: 1, holdWeight: 500 },
      's:2': { t: piece(1500, 300, 30), mass: 1, holdWeight: 500 },
    });
    for (const k of ['s:1', 's:2']) locks.forceLock('p1', k, 'main');
    locks.forceLock('p1', 's:1', 'aa');
    for (const [s, c] of aims('main')) { expect(s).toBeNull(); expect(c).toBeNull(); }
    for (const [s, c] of aims('aa')) { expect(s).toBe('s:1'); expect(c).toBe('s:1'); }
  });

  it('ONE AA-tier lock: no one-lock shortcut on either side (no aim)', () => {
    const { locks, aims } = rig({ 's:7': { t: piece(1500, 0, 50), mass: 1, holdWeight: 500 } });
    locks.forceLock('p1', 's:7', 'main');
    for (const [s, c] of aims('main')) { expect(s).toBeNull(); expect(c).toBeNull(); }
  });

  it('an M-tier piece: the S lasers cut it and the AA tractors leave it, on both sides', () => {
    const { locks, aims } = rig({ 's:7': { t: piece(1500, 0, 50), mass: 300, holdWeight: 50 } });
    locks.forceLock('p1', 's:7', 'main');
    locks.forceLock('p1', 's:7', 'aa');
    expect(locks.wireFor('p1')!.find((g) => g.id === 'main')!.l[0]!.f).toBe(M_TIER);
    for (const [s, c] of aims('main')) { expect(s).toBe('s:7'); expect(c).toBe('s:7'); }
    for (const [s, c] of aims('aa')) { expect(s).toBeNull(); expect(c).toBeNull(); }
  });

  it('a ship lock outside the client mirror beside an AA-tier piece: both sides aim at the ship', () => {
    // Server: one AA-tier piece + a combat lock, so the ordinary pick takes the ship.
    // The client sees only the piece; counting salvage locks by mirror presence it
    // would think "every lock a piece left to the tractors" and give the lasers no aim.
    const { locks, aims } = rig({
      's:2': { t: piece(1500, 0, 40), mass: 1, holdWeight: 500 },
      'p:far': { t: { ...piece(90000, 0, 0), ship: true, hostile: true, terrain: false }, mass: 0, holdWeight: 0, ship: true, hidden: true },
    });
    for (const k of ['s:2', 'p:far']) expect(locks.forceLock('p1', k, 'main')).toBe(1);
    for (const [s, c] of aims('main')) { expect(s).toBe('p:far'); expect(c).toBe(s); }
  });

  it('a consumable piece: no laser and no tractor aims at it, on both sides; a fuller hold hands it back', () => {
    // Hold size is the AA tier on every ship: this AA-tier piece fits the free hold.
    const free = { v: 100 };
    const { locks, aims } = rig({ 's:4': { t: piece(1500, 0, 20), mass: 1, holdWeight: 5 } }, free);
    locks.forceLock('p1', 's:4', 'main');
    locks.forceLock('p1', 's:4', 'aa');
    expect(locks.wireFor('p1')!.find((g) => g.id === 'aa')!.l[0]!.f).toBe(AA_TIER | LOCK_CONSUMABLE);
    for (const g of ['main', 'aa']) for (const [s, c] of aims(g)) { expect(s).toBeNull(); expect(c).toBeNull(); }
    free.v = 2; // no room to take it in: not consumable, so the AA tractors pull it (its tier is AA)
    locks.step();
    expect(locks.wireFor('p1')!.find((g) => g.id === 'aa')!.l[0]!.f).toBe(AA_TIER);
    for (const [s, c] of aims('aa')) { expect(s).toBe('s:4'); expect(c).toBe('s:4'); }
  });

  it('a cuttable piece outside the client mirror: same aim on both sides', () => {
    const { locks, aims } = rig({
      's:1': { t: piece(1500, 0, 120), mass: 1e9, holdWeight: 500 },
      's:9': { t: piece(90000, 0, 900), mass: 1e9, holdWeight: 500, hidden: true },
    });
    for (const k of ['s:9', 's:1']) expect(locks.forceLock('p1', k, 'main')).toBe(1);
    for (const [s, c] of aims('main')) { expect(s).toBe('s:1'); expect(c).toBe(s); }
  });
});

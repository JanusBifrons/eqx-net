/**
 * Wreck fields slice 3a (plan review 3 "Origin-aware FIFO host";
 * capital-destruction.md "Origins and live caps"): a lineage's origin picks
 * its FIFO list. Battle eviction counts battle pieces only, a field piece is
 * never evicted, a field lineage's re-split children land in the field list
 * under the field cap, and `sleeping` reaches every piece spawn.
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckOrigin, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { buildWreckPieces } from '../../core/destruction/wreckPieces.js';
import { WEAPONS } from '../../core/combat/WeaponCatalogue.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import { FIELD_LIVE_CAP, FIELD_RING_WORST_PIECES, FIELD_CAP_SHIPS } from './wreckFifos.js';

function make() {
  let tick = 1000;
  const spawned = new Map<string, WreckPieceSpawn>();
  const live = new Set<string>();
  const removed: string[] = [];
  const drops: number[] = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => tick,
    wreckKindOf: () => 'fighter',
    positionOf: () => null,
    spawnPiece: (s) => { spawned.set(s.id, s); live.add(s.id); return true; },
    removePiece: (id) => { live.delete(id); removed.push(id); sys.pieceGone(id); },
    isLive: (id) => live.has(id),
    pieceAngle: (id) => (live.has(id) ? spawned.get(id)!.angle : null),
    kickPiece: () => {},
    impulsePiece: () => {},
    piecePose: (id) => {
      const s = spawned.get(id);
      return s !== undefined && live.has(id) ? { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel } : null;
    },
    dropSalvage: (qty) => { drops.push(qty); return `pod-${drops.length}`; },
  });
  sys.forcedSeed = 11;
  let n = 0;
  /** One hull of `kind` laid down through THE spawn path with `origin`. */
  const lay = (kind: ShipKindId, origin: WreckOrigin, sleeping = false): string[] => {
    const before = new Set(spawned.keys());
    const pose = { x: 5000 * n++, y: 0, vx: 0, vy: 0, angle: 0.3, angvel: 0 };
    const { pieces, fracture } = buildWreckPieces({
      kindId: kind, pose, killWorld: null, attackerWorld: null, seed: 7 + n, killBlowDamage: 0.5, recentDamageRate: 0.5,
    });
    sys.spawnWreck(kind, `h${n}`, pieces, fracture, 1000, pose.angle, { held: false, origin, ...(sleeping ? { sleeping } : {}) });
    return [...spawned.keys()].filter((k) => !before.has(k));
  };
  return { sys, spawned, live, removed, drops, lay, past: () => { tick += 10_000; } };
}

/** Wear piece `id` out with a factor-1 weapon (the mining-laser stand-in). */
function wearOut(sys: CapitalWreckSubsystem, s: WreckPieceSpawn): void {
  const def = WEAPONS.get('laser')!;
  def.targetFactor = { wreck: 1 };
  try { sys.onWreckHit(s.id, s.x - 1, s.y, 1, 0, sys.pieceIntegrity(s.id)! + 1, 'laser'); } finally { delete def.targetFactor; }
}

describe('wreck origins (wreck fields 3a)', () => {
  it('the field cap is the measured ring worst times the ships allowed, plus one ring', () => {
    expect(FIELD_LIVE_CAP).toBe(FIELD_RING_WORST_PIECES * (FIELD_CAP_SHIPS + 1));
    expect(FIELD_LIVE_CAP).toBe(952);
  });

  it('a battle never evicts a field piece, and field pieces never take a battle slot', () => {
    const a = make();
    const field = a.lay('fighter', 'field');
    expect(field.length).toBeGreaterThan(0);
    expect(a.sys.liveFieldCount()).toBe(field.length);
    expect(a.sys.liveBattleCount()).toBe(0);
    // A battle FIFO of 3 sub-cap pieces: the field's pieces don't count.
    a.sys.subcapCapOverride = 3;
    for (let i = 0; i < 4; i++) a.lay('fighter', 'battle');
    expect(a.sys.liveSubcapCount()).toBe(3);
    expect(a.sys.liveBattleCount()).toBe(3);
    for (const id of field) { expect(a.removed).not.toContain(id); expect(a.live.has(id)).toBe(true); }
    expect(a.sys.liveFieldCount()).toBe(field.length);
    // liveCount still counts every origin (heldPieces.any, wreckCounts, sceneWork).
    expect(a.sys.liveCount()).toBe(field.length + 3);
    // Even a field cap far below the field's size evicts nothing.
    a.sys.fieldCapOverride = 0;
    a.lay('fighter', 'battle');
    for (const id of field) expect(a.live.has(id)).toBe(true);
  });

  it("a field piece's re-split children land in the field list (they take the root's origin)", () => {
    const a = make();
    const field = a.lay('battleship', 'field');
    a.past();
    const big = field.reduce((x, y) => (a.spawned.get(y)!.mass > a.spawned.get(x)!.mass ? y : x));
    const fieldBefore = a.sys.liveFieldCount();
    wearOut(a.sys, a.spawned.get(big)!);
    expect(a.live.has(big)).toBe(false);
    const kids = [...a.live].filter((id) => !field.includes(id));
    expect(kids.length, 'it split, not podded').toBeGreaterThanOrEqual(2);
    expect(a.sys.liveFieldCount()).toBe(fieldBefore - 1 + kids.length);
    expect(a.sys.liveBattleCount()).toBe(0);
  });

  it('a field re-split is gated by fieldLive - 1 + maxPieces <= FIELD_LIVE_CAP (else salvage), never by the battle count', () => {
    const a = make();
    const field = a.lay('battleship', 'field');
    a.past();
    // A full battle FIFO does not stop a field split.
    a.sys.subcapCapOverride = 0;
    const big = field.reduce((x, y) => (a.spawned.get(y)!.mass > a.spawned.get(x)!.mass ? y : x));
    a.sys.fieldCapOverride = a.sys.liveFieldCount(); // no room for a child fracture
    wearOut(a.sys, a.spawned.get(big)!);
    expect(a.live.has(big)).toBe(false);
    expect(a.drops.length, 'turned to salvage at the field cap').toBe(1);
    expect(a.sys.liveFieldCount()).toBe(field.length - 1);
  });

  it('a field piece that leaves by another path leaves the field list (no stale id)', () => {
    const a = make();
    const field = a.lay('fighter', 'field');
    a.live.delete(field[0]!);
    a.sys.pieceGone(field[0]!);
    expect(a.sys.liveFieldCount()).toBe(field.length - 1);
  });

  it('`sleeping` reaches every piece spawn; default spawns stay awake', () => {
    const a = make();
    const asleep = a.lay('destroyer', 'field', true);
    const awake = a.lay('destroyer', 'battle');
    for (const id of asleep) expect(a.spawned.get(id)!.sleeping).toBe(true);
    for (const id of awake) expect(a.spawned.get(id)!.sleeping).toBeUndefined();
  });
});

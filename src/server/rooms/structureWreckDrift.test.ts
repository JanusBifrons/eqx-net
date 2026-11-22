/**
 * Structure break-up: a destroyed structure's pieces part and drift like a
 * ship wreck's (owner on the in-game stills: the pieces stopped dead ~1 s
 * after the death; "pieces act EXACTLY like ship wrecks"). Driven through
 * THE death path (`CapitalWreckSubsystem.onDeath`) with plain mocks: the
 * spawn velocities a structure's pieces get, against a sub-capital ship's of
 * similar size (robot-nexus, the biggest sub-cap: radius 110, ~30,600 u²),
 * in radii of the whole thing (the parting rules are per radius).
 */
import { describe, expect, it } from 'vitest';
import { CapitalWreckSubsystem, type WreckPieceSpawn } from './CapitalWreckSubsystem.js';
import { asWreckSource, structureBreaks, structureWreckSource, type WreckSource } from '../../core/destruction/wreckSource.js';
import { STRUCTURE_KINDS_LIST } from '../../shared-types/structureKinds.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';

function deathOf(source: ShipKindId | WreckSource): { spawned: WreckPieceSpawn[]; radius: number } {
  const spawned: WreckPieceSpawn[] = [];
  const sys = new CapitalWreckSubsystem({
    serverTick: () => 1000,
    wreckKindOf: () => source,
    positionOf: () => null,
    spawnPiece: (s) => { spawned.push(s); return true; },
    removePiece: () => {},
    isLive: () => true,
    pieceAngle: () => 0,
    kickPiece: () => {},
    impulsePiece: () => {},
    pieceCentreInto: () => false,
  });
  const src = asWreckSource(source);
  // The same killing blow, by share of the hull, at the same relative point.
  sys.noteHit('t', 'attacker', 0.2 * src.maxHull, 0.4 * src.radius, 0.1 * src.radius, -1, 0);
  sys.onDeath('t', source, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }, src.maxHull);
  return { spawned, radius: src.radius };
}

/** Each piece's spawn speed in radii of the whole thing per second. */
function speeds(d: { spawned: WreckPieceSpawn[]; radius: number }): number[] {
  return d.spawned.map((p) => Math.hypot(p.vx, p.vy) / d.radius).sort((a, b) => a - b);
}

/** How long (s) a piece coasts before it drops under its settle speed and
 *  sleeps (exponential damping; collisions aside). */
function coastSeconds(d: { spawned: WreckPieceSpawn[] }): number[] {
  return d.spawned.map((p) => {
    const v = Math.hypot(p.vx, p.vy);
    const settle = p.settleSpeed ?? 0;
    return settle > 0 && v > settle ? Math.log(v / settle) / p.linearDamping : 0;
  }).sort((a, b) => a - b);
}

const median = (xs: number[]): number => xs[Math.floor(xs.length / 2)]!;

describe('structure wreck pieces part like a ship wreck', () => {
  const ship = deathOf('robot-nexus');
  const shipMedian = median(speeds(ship));
  const shipCoast = median(coastSeconds(ship));

  it('the reference ship wreck parts (sanity)', () => {
    expect(ship.spawned.length).toBeGreaterThanOrEqual(2);
    expect(shipMedian).toBeGreaterThan(1);
    expect(shipCoast).toBeGreaterThan(3);
  });

  for (const kind of STRUCTURE_KINDS_LIST) {
    if (!structureBreaks(kind.id, true)) continue;
    it(`${kind.id}: pieces part as fast (per radius) and coast as long as a ship's`, () => {
      const d = deathOf(structureWreckSource({ k: kind.id }));
      expect(d.spawned.length).toBeGreaterThanOrEqual(2);
      const s = speeds(d);
      // Every piece moves off, and the wreck parts like the ship's (per radius).
      expect(s[0]!).toBeGreaterThan(0.25 * shipMedian);
      expect(median(s)).toBeGreaterThan(0.5 * shipMedian);
      expect(median(s)).toBeLessThan(2 * shipMedian);
      // ...and drifts for seconds, not ~1 s.
      const coast = median(coastSeconds(d));
      expect(coast).toBeGreaterThan(0.75 * shipCoast);
      expect(coast).toBeLessThan(1.5 * shipCoast);
    });
  }
});

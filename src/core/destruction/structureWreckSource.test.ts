/**
 * Structure break-up T2: a structure's wreck source (`structureWreckSource`)
 * and the `structure` destruction profile. Every kind but the gates breaks
 * through the one ship/rock fracture path (`buildWreckPieces`).
 */
import { describe, expect, it } from 'vitest';
import { buildWreckPieces, wreckPieceGeometry } from './wreckPieces.js';
import { shipWreckSource, structureBreaks, structureWreckSource, STRUCTURE_WRECK_DENSITY } from './wreckSource.js';
import { isGateKind } from '../structures/gateGeometry.js';
import { polygonArea } from '../swarm/asteroidShape.js';
import { DESTRUCTION_PROFILES, fractureCapFor, NO_WRECK_STRUCTURE_KINDS } from '../../shared-types/shipScale/destruction.js';
import {
  getStructureKind, SOCKET_OUTLINE_STYLE, STRUCTURE_KINDS_LIST, structureHalfExtents, structureOutline, type StructureKindId,
} from '../../shared-types/structureKinds.js';

const BREAKING = STRUCTURE_KINDS_LIST.filter((k) => !isGateKind(k.id));
const STILL = { vx: 0, vy: 0, angvel: 0 };

describe('structureWreckSource: the numbers', () => {
  it('a connector: its socket outline, Y flipped, scale 1, catalogue hull', () => {
    const s = structureWreckSource({ k: 'connector' });
    const verts = structureOutline('connector', SOCKET_OUTLINE_STYLE);
    expect(s.structure).toEqual({ k: 'connector' });
    expect(s.ship).toBeNull();
    expect(s.rock).toBeNull();
    expect(s.scale).toBe(1);
    expect(s.outline).toEqual(verts.map((v) => [v.x, -v.y]));
    expect(s.area).toBeCloseTo(polygonArea(verts), 6);
    // The connector is a hex inside its 64 × 64 box.
    expect(s.area).toBeGreaterThan(0.6 * 64 * 64);
    expect(s.area).toBeLessThan(64 * 64);
    expect(s.bodyMass).toBeCloseTo(s.area * STRUCTURE_WRECK_DENSITY, 6);
    expect(s.maxHull).toBe(getStructureKind('connector').maxHealth);
    expect(s.radius).toBeLessThanOrEqual(Math.hypot(32, 32));
    expect(s.profile).toBe(DESTRUCTION_PROFILES.structure);
    expect(fractureCapFor(s.profile.fracture!, s.area)).toBe(2);
  });

  it('the base Capital: 6 pieces, its own catalogue hull', () => {
    const s = structureWreckSource({ k: 'capital' });
    expect(s.maxHull).toBe(getStructureKind('capital').maxHealth);
    expect(s.area).toBeGreaterThan(0.9 * 560 * 560);
    expect(s.area).toBeLessThan(560 * 560);
    expect(fractureCapFor(s.profile.fracture!, s.area)).toBe(6);
  });

  it('is memoised per kind', () => {
    expect(structureWreckSource({ k: 'turret' })).toBe(structureWreckSource({ k: 'turret' }));
  });

  it('the outline lies inside the footprint box it collides with (pieces land where it stood)', () => {
    for (const k of BREAKING) {
      const { hw, hh } = structureHalfExtents(k.id, 0);
      for (const [x, y] of structureWreckSource({ k: k.id }).outline) {
        expect(Math.abs(x)).toBeLessThanOrEqual(hw + 1e-9);
        expect(Math.abs(y)).toBeLessThanOrEqual(hh + 1e-9);
      }
    }
  });

  it('the structure profile: static (knock 0), pieces collide', () => {
    const p = DESTRUCTION_PROFILES.structure;
    expect(p.knockScale).toBe(0);
    expect(p.knockMaxScale).toBe(0);
    expect(p.piecesCollide).toBe(true);
  });
});

describe('structureBreaks', () => {
  it('every built kind but the gates; never an unbuilt one', () => {
    for (const k of STRUCTURE_KINDS_LIST) {
      expect(structureBreaks(k.id, true)).toBe(!isGateKind(k.id));
      expect(structureBreaks(k.id, false)).toBe(false);
    }
    expect(structureBreaks('no-such-structure', true)).toBe(false);
  });

  it('the no-wreck structure list is exactly the gate kinds', () => {
    const gates = STRUCTURE_KINDS_LIST.filter((k) => isGateKind(k.id)).map((k) => k.id).sort();
    expect([...NO_WRECK_STRUCTURE_KINDS].sort()).toEqual(gates);
  });
});

describe('every breaking structure kind fractures through buildWreckPieces', () => {
  const rows: string[] = [];
  for (const kind of BREAKING) {
    it(kind.id, () => {
      const src = structureWreckSource({ k: kind.id as StructureKindId });
      const cap = fractureCapFor(src.profile.fracture!, src.area);
      let lo = Infinity;
      let hi = 0;
      for (const seed of [1, 7, 77, 4242, 9001, 31337]) {
        const pose = { x: 300, y: -120, angle: Math.PI / 2, ...STILL };
        const b = buildWreckPieces({
          kindId: src, pose, killWorld: { x: 300 + src.radius * 2, y: -100 }, attackerWorld: null,
          seed, killBlowDamage: 0.5, recentDamageRate: 0.3,
        });
        expect(b.fracture.structure).toEqual({ k: kind.id });
        expect(b.fracture.kindId).toBeUndefined();
        expect(b.fracture.rock).toBeUndefined();
        expect(b.pieces.length).toBeGreaterThanOrEqual(1);
        expect(b.pieces.length).toBeLessThanOrEqual(cap);
        let area = 0;
        for (const p of b.pieces) {
          area += p.area;
          // Static: no knock-on velocity from the dead body.
          expect(p.vx).toBe(0);
          expect(p.vy).toBe(0);
        }
        expect(area / src.area).toBeCloseTo(1, 3);
        // The rebuild from the inputs alone (the descriptor path) agrees.
        expect(wreckPieceGeometry(b.fracture).map((g) => g.area)).toEqual(b.pieces.map((p) => p.area));
        lo = Math.min(lo, b.pieces.length);
        hi = Math.max(hi, b.pieces.length);
      }
      rows.push(`${kind.id}: cap ${cap}, pieces ${lo}-${hi}`);
    });
  }
  it('prints the piece counts', () => {
    console.log(rows.join('\n'));
  });
});

describe('ship sources are untouched', () => {
  it('a ship source has no structure', () => {
    expect(shipWreckSource('battleship').structure).toBeNull();
  });
});

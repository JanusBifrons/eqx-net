/**
 * Fracture v13 burned gap (owner 2026-11-16: a heavy beam kill "burns a
 * perfect hole like a lightsaber directly through ... so it should shine out
 * the other side"; the gap is the beam's width plus a tiny buffer). The wide
 * slice's strip runs down the beam's own axis, `BEAM_CUT_BUFFER` wider than
 * the beam, and the halves drift apart off it (`cutPartSpeed`), never
 * together. capital-destruction.md "Burned gap".
 */
import { describe, expect, it } from 'vitest';
import { buildWreckPieces, hullLocalCutAngle, wreckBreakKicks, wreckPieceGeometry, type WreckBuildInput } from './wreckPieces.js';
import { beamHalfWidth } from '../combat/Weapons.js';
import { getWeapon } from '../combat/WeaponCatalogue.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { shipShapeScale } from '../geometry/shipHullOutline.js';
import { cutDirFromAngle } from './fractureHull.js';
import { BEAM_CUT_BUFFER, DESTRUCTION_PROFILES, killCutStripWidth } from '../../shared-types/shipScale/destruction.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';

const BEAM = getWeapon('heavy_beam');
const HW = beamHalfWidth(BEAM);
const pose = { x: 5000, y: -3000, vx: 0, vy: 0, angle: 0.7, angvel: 0 };

/** A heavy-beam kill along world direction `ang`, its axis `off` to one side
 *  of the hull's centre; the kill point is on the axis where the beam meets
 *  the hull's bounding circle (the axis point, as the server sends it). */
function beamKill(kindId: ShipKindId, ang: number, off: number, seed: number): { input: WreckBuildInput; p: { x: number; y: number }; d: { x: number; y: number } } {
  const kind = getShipKind(kindId);
  const d = { x: Math.cos(ang), y: Math.sin(ang) };
  const along = -Math.sqrt(Math.max(0, kind.radius * kind.radius - off * off));
  const p = { x: pose.x + d.x * along - d.y * off, y: pose.y + d.y * along + d.x * off };
  const cut = BEAM.killCut!;
  return {
    p, d,
    input: {
      kindId, pose, killWorld: p, attackerWorld: null, seed, killBlowDamage: 1, recentDamageRate: 1,
      cutKind: cut.kind, cutAng: hullLocalCutAngle(pose, d), cutW: killCutStripWidth(cut) / shipShapeScale(kind),
    },
  };
}

describe('fracture v13: a heavy-beam kill burns a gap the beam shines through', () => {
  it('the strip is the beam plus BEAM_CUT_BUFFER', () => {
    expect(BEAM.killCut).toEqual({ kind: 'slice', width: 2 * HW });
    expect(killCutStripWidth(BEAM.killCut!)).toBe(2 * HW + BEAM_CUT_BUFFER);
  });

  for (const kindId of ['battleship', 'heavy-cruiser'] as const) {
    it(`${kindId}: no piece lies within the beam's half-width + buffer of its axis`, () => {
      const r = getShipKind(kindId).radius;
      let cut = 0;
      for (let seed = 0; seed < 12; seed++) {
        const ang = seed * 0.83;
        const off = ((seed % 5) - 2) * 0.2 * r;
        const { input, p, d } = beamKill(kindId, ang, off, seed * 7919 + 3);
        const { pieces } = buildWreckPieces(input);
        if (pieces.length === 0) continue; // vaporised: nothing in the way either
        cut++;
        for (const pc of pieces) {
          const c = Math.cos(pc.angle);
          const s = Math.sin(pc.angle);
          let side = 0;
          for (const part of pc.parts) {
            for (const v of part) {
              const wx = pc.x + v.x * c - v.y * s;
              const wy = pc.y + v.x * s + v.y * c;
              const dist = (wx - p.x) * -d.y + (wy - p.y) * d.x;
              expect(Math.abs(dist), `${kindId} seed ${seed}: a vertex inside the burned gap`).toBeGreaterThanOrEqual(HW + BEAM_CUT_BUFFER / 2 - 0.5);
              const sd = Math.sign(dist);
              if (side === 0) side = sd;
              expect(sd, `${kindId} seed ${seed}: a piece straddles the gap`).toBe(side);
            }
          }
        }
      }
      expect(cut).toBeGreaterThan(6);
    });
  }

  for (const kindId of ['battleship', 'heavy-cruiser'] as const) {
    it(`${kindId}: the banks drift apart off the burn line at cutPartSpeed or more, spin included`, () => {
      const kind = getShipKind(kindId);
      const s = shipShapeScale(kind);
      const speed = DESTRUCTION_PROFILES[shipTuning(kind).destruction].cutPartSpeed;
      expect(speed).toBeGreaterThan(0);
      let checked = 0;
      for (let seed = 0; seed < 8; seed++) {
        const { input } = beamKill(kindId, 0.4 + seed * 0.9, ((seed % 3) - 1) * 0.2 * kind.radius, seed * 31 + 5);
        const { fracture } = buildWreckPieces(input);
        const geom = wreckPieceGeometry(fracture);
        if (geom.length < 2) continue;
        checked++;
        const px = fracture.killX * s;
        const py = -fracture.killY * s;
        const gap = (fracture.cutW ?? 0) * s;
        const d = cutDirFromAngle(fracture.cutAng!);
        const nx = d.y; // the line's normal, scaled math-up
        const ny = d.x;
        const k = wreckBreakKicks(kindId, geom, px, py, 1, seed, gap, { px, py, ang: fracture.cutAng! });
        const sides = new Set<number>();
        for (let i = 0; i < geom.length; i++) {
          const g = geom[i]!;
          const side = (g.cx - px) * nx + (g.cy - py) * ny >= 0 ? 1 : -1;
          sides.add(side);
          for (const v of g.outline) {
            const dist = (g.cx + v.x - px) * nx + (g.cy + v.y - py) * ny;
            if (Math.abs(dist) > gap) continue; // not a bank of the gap
            expect(dist * side, `${kindId} seed ${seed} piece ${i}: a bank point across the line`).toBeGreaterThan(0);
            const away = ((k.kvx[i]! - k.kw[i]! * v.y) * nx + (k.kvy[i]! + k.kw[i]! * v.x) * ny) * side;
            expect(away, `${kindId} seed ${seed} piece ${i}: a bank point moving into the gap`).toBeGreaterThanOrEqual(speed - 1e-9);
          }
        }
        expect(sides.size, `${kindId} seed ${seed}: pieces on both sides`).toBe(2);
      }
      expect(checked).toBeGreaterThan(4);
    });
  }
});

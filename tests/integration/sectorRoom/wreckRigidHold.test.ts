/**
 * A shell landing on a wreck during its crack hold shoves the WHOLE wreck
 * (owner review of a filmed battleship salvo, 2026-11-13).
 *
 * A salvo's shells land over ~0.5 s. The first one breaks the hull; the next
 * ones arrive during the `WRECK_CRACK_MS` hold, while the pieces still move
 * as one. Each used to shove only the piece it hit (the overkill knock-back),
 * so one chunk slid and turned out of line while the rest held: the hull bent
 * like a banana before it broke apart. The hull must read as one cracked body
 * until the split.
 *
 * Repro: a real 16" shell kills a heavy cruiser (capital wrecks on). Right
 * after the break, a second real 16" shell hits the wreck aft of its middle,
 * from the side. Until the hold ends:
 *  - every pair of pieces keeps its relative pose (relative position in one
 *    piece's frame within 1 u, relative angle within 0.1°);
 *  - the wreck as a whole (its mass-weighted velocity) moves along the shot.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { getShipKind, type ShipKindId } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';
import { fracturePlan, FRACTURE_MAX_PIECES } from '../../../src/core/destruction/fractureHull.js';
import { shipHullOutline } from '../../../src/core/geometry/shipHullOutline.js';
import { wreckPieceGeometry } from '../../../src/core/destruction/wreckPieces.js';
import { WRECK_CRACK_MS } from '../../../src/shared-types/wreckTiming.js';

const WRECK_KIND = 4;
const KIND = 'heavy-cruiser';
const SHELL_DAMAGE = 1400; // naval_xl (16")
const SHELL_SPEED = 3000;
const STEP_MS = 50;

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

describe('SectorRoom integration: a hit during the crack hold moves the wreck as one body', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a second salvo shell landing before the split keeps every piece in its pose and shoves the whole hull', async () => {
    const kind = getShipKind(KIND);
    let seed = 1;
    while (fracturePlan({ hull: shipHullOutline(kind), seed, killPoint: { x: -220, y: -200 }, maxPieces: FRACTURE_MAX_PIECES, killBlowDamage: 1.2, recentDamageRate: 1.2 }).snap) seed++;

    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      capitalWrecks: true, pilotCapitals: true,
    });
    const victim = randomUUID();
    await harness.connectActive(victim, { shipKind: KIND, spawnX: 8000, spawnY: 0, initialHull: 1, initialShield: 0 });
    const internal = (harness.getServerRoom() as unknown as SectorRoom)._internals;
    internal.setWreckSeed(seed);
    await harness.advance(150);
    const pose = internal.playerPose(victim)!;
    const c = Math.cos(pose.angle), s = Math.sin(pose.angle);

    // The killing shell (as wreckOverkillKnockback does).
    internal.spawnTestProjectile('bb-shooter', pose.x + kind.radius * 0.6 * c, pose.y + kind.radius * 0.6 * s, -c * SHELL_SPEED, -s * SHELL_SPEED, 'naval_xl', SHELL_DAMAGE);
    for (let i = 0; i < 80 && internal.wreckDescriptors().length === 0; i++) await harness.advance(STEP_MS / 2);
    const d = internal.wreckDescriptors()[0];
    expect(d, 'the shell killed the cruiser and it broke up').toBeDefined();
    // The hull broke within the last 25 ms.
    let sinceDeath = STEP_MS / 2;

    const geom = wreckPieceGeometry({
      kindId: d!.parentKind as ShipKindId, seed: d!.seed, killX: d!.killX, killY: d!.killY,
      killBlowDamage: d!.killBlowDamage, recentDamageRate: d!.recentDamageRate, snapChance: d!.snapChance,
    });
    const ids = [...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).map((r) => r.id);
    // Fracture v7 breaks a hull into 3–7 chunky pieces.
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const massOf = (id: string): number => geom.find((g) => g.index === Number(id.slice(id.lastIndexOf('-') + 1)))!.mass;

    // The second shell: from the side of the wreck at an end piece (far from
    // the middle, so it also turns the hull), its first hit a wreck piece.
    let cmx = 0, cmy = 0, mTot = 0;
    for (const id of ids) {
      const st = internal.wreckState(id)!;
      cmx += st.x * massOf(id); cmy += st.y * massOf(id); mTot += massOf(id);
    }
    cmx /= mTot; cmy /= mTot;
    const byReach = [...ids].sort((a, b) => {
      const sa = internal.wreckState(a)!, sb = internal.wreckState(b)!;
      return Math.hypot(sb.x - cmx, sb.y - cmy) - Math.hypot(sa.x - cmx, sa.y - cmy);
    });
    let shot: { sx: number; sy: number; dx: number; dy: number; dist: number; id: string } | null = null;
    for (const aim of byReach) {
      const st = internal.wreckState(aim)!;
      const ox = st.x - cmx, oy = st.y - cmy;
      const ol = Math.hypot(ox, oy) || 1;
      for (const side of [1, -1]) {
        // Across the line from the middle to this piece, from just outside
        // the wreck (so the shell lands early in the hold).
        const dx = (oy / ol) * side, dy = (-ox / ol) * side;
        let sx = st.x - dx * kind.radius, sy = st.y - dy * kind.radius;
        const h0 = internal.rayHit(sx, sy, dx, dy, kind.radius * 1.5, 'bb-shooter');
        if (h0 === null || !ids.includes(h0.id)) continue;
        const back = Math.max(0, h0.dist - 300);
        sx += dx * back; sy += dy * back;
        const h = internal.rayHit(sx, sy, dx, dy, kind.radius * 1.5, 'bb-shooter');
        if (h !== null && h.dist > 20 && ids.includes(h.id)) { shot = { sx, sy, dx, dy, dist: h.dist, id: h.id }; break; }
      }
      if (shot !== null) break;
    }
    expect(shot, 'a side shot reaches a wreck piece first').not.toBeNull();

    const comVel = (): { vx: number; vy: number } => {
      let vx = 0, vy = 0, m = 0;
      for (const id of ids) {
        const st = internal.wreckState(id)!;
        const mi = massOf(id);
        vx += st.vx * mi; vy += st.vy * mi; m += mi;
      }
      return { vx: vx / m, vy: vy / m };
    };
    // Relative pose of every pair: b's centre in a's frame, and b's angle less a's.
    const relPoses = (): number[] => {
      const out: number[] = [];
      for (let i = 0; i < ids.length; i++) {
        const a = internal.wreckState(ids[i]!)!;
        const ca = Math.cos(a.angle), sa = Math.sin(a.angle);
        for (let j = i + 1; j < ids.length; j++) {
          const b = internal.wreckState(ids[j]!)!;
          const rx = b.x - a.x, ry = b.y - a.y;
          out.push(rx * ca + ry * sa, -rx * sa + ry * ca, b.angle - a.angle);
        }
      }
      return out;
    };

    const v0 = comVel();
    const rel0 = relPoses();
    internal.spawnTestProjectile('bb-shooter', shot!.sx, shot!.sy, shot!.dx * SHELL_SPEED, shot!.dy * SHELL_SPEED, 'naval_xl', SHELL_DAMAGE);

    let worstPos = 0, worstAng = 0;
    while (sinceDeath + STEP_MS <= WRECK_CRACK_MS - 100) {
      await harness.advance(STEP_MS);
      sinceDeath += STEP_MS;
      const rel = relPoses();
      for (let k = 0; k < rel.length; k += 3) {
        worstPos = Math.max(worstPos, Math.hypot(rel[k]! - rel0[k]!, rel[k + 1]! - rel0[k + 1]!));
        worstAng = Math.max(worstAng, Math.abs(wrap(rel[k + 2]! - rel0[k + 2]!)));
      }
    }
    expect(internal.wreckState(ids[0]!), 'still inside the hold: the pieces live').not.toBeNull();
    const v1 = comVel();
    const along = (v1.vx - v0.vx) * shot!.dx + (v1.vy - v0.vy) * shot!.dy;
    const t = shipTuning(kind);
    const expected = Math.min((SHELL_DAMAGE / kind.maxHealth) * t.wreckKnockSpeed, t.wreckKnockMax);
    const spins = ids.map((id) => internal.wreckState(id)!.angvel);
    console.log(`[wreck rigid hold] ${ids.length} pieces, shot hit ${shot!.id} after ${shot!.dist.toFixed(0)} u; worst relative drift ${worstPos.toFixed(3)} u / ${(worstAng * 180 / Math.PI).toFixed(4)} deg; wreck Δv along shot ${along.toFixed(3)} u/s (expected ~${expected.toFixed(3)}); spins ${spins.map((w) => (w * 180 / Math.PI).toFixed(3)).join(', ')} deg/s`);

    expect(worstPos, 'every piece keeps its place in the hull until the split (u)').toBeLessThan(1);
    expect(worstAng * 180 / Math.PI, 'every piece keeps its angle in the hull until the split (deg)').toBeLessThan(0.1);
    expect(along, 'the hit shoves the wreck as a whole along the shot (u/s)').toBeGreaterThan(0.5 * expected);
    expect(along, '...by about the expected impulse').toBeLessThan(1.3 * expected);
  }, 60_000);
});

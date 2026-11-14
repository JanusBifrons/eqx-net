/**
 * Overkill shoves capital wreck pieces (owner request 2026-11-13: "The thing
 * which knocks them back should be the impact of subsequent shells, if any
 * overkill happens due to incoming shots after destruction.").
 *
 * Wreck pieces are immune, so a shell that lands on one after the kill (the
 * rest of the salvo) used to stop dead and change nothing: the piece kept its
 * slow parting drift. Now each hit gives the piece an impulse at the hit
 * point along the shot: J = (damage ÷ the parent hull's max hull) × the hull's
 * mass × `shipTuning(kind).wreckKnockSpeed`, the resulting speed change capped
 * at `wreckKnockMax` (#18).
 *
 * Repro: a real 16" shell kills a heavy cruiser (capital wrecks on). Once the
 * pieces have parted, a second real 16" shell hits the biggest piece off its
 * centre, travelling away from the rest of the wreck. The piece's velocity
 * must change along the shot by about the expected amount, and its spin must
 * change in the direction the off-centre hit turns it.
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

describe('SectorRoom integration: overkill shells knock wreck pieces back', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('a 16" shell landing on a wreck piece after the kill shoves it along the shot and turns it', async () => {
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

    // The killing shell, from just off the starboard beam (as wreckPiecesSeparate does).
    const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
    const kx = pose.x + kind.radius * 0.6 * c, ky = pose.y + kind.radius * 0.6 * s;
    internal.spawnTestProjectile('bb-shooter', kx, ky, -c * SHELL_SPEED, -s * SHELL_SPEED, 'naval_xl', SHELL_DAMAGE);
    for (let i = 0; i < 40 && internal.wreckDescriptors().length === 0; i++) await harness.advance(50);
    const d = internal.wreckDescriptors()[0];
    expect(d, 'the shell killed the cruiser and it broke up').toBeDefined();

    // Let the hull crack and the pieces part a little.
    await harness.advance(WRECK_CRACK_MS + 2500);

    const geom = wreckPieceGeometry({
      kindId: d!.parentKind as ShipKindId, seed: d!.seed, killX: d!.killX, killY: d!.killY,
      killBlowDamage: d!.killBlowDamage, recentDamageRate: d!.recentDamageRate, snapChance: d!.snapChance,
    });
    const ids = [...internal.swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).map((r) => r.id);
    // Fracture v7 breaks a hull into 3–7 chunky pieces.
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const massOf = (id: string): number => geom.find((g) => g.index === Number(id.slice(id.lastIndexOf('-') + 1)))!.mass;

    // The biggest piece, and the wreck's centre of mass.
    let target = ids[0]!;
    let cmx = 0, cmy = 0, mTot = 0;
    for (const id of ids) {
      const st = internal.wreckState(id)!;
      const m = massOf(id);
      cmx += st.x * m; cmy += st.y * m; mTot += m;
      if (m > massOf(target)) target = id;
    }
    cmx /= mTot; cmy /= mTot;
    const t0 = internal.wreckState(target)!;
    const rPiece = internal.swarmRegistry.get(target)!.radius;

    // A shot whose first hit is the target, off its centre, heading as far
    // away from the rest of the wreck as possible (so the shove doesn't drive
    // the piece into a neighbour while we measure).
    let outX = t0.x - cmx, outY = t0.y - cmy;
    const ol = Math.hypot(outX, outY) || 1;
    outX /= ol; outY /= ol;
    let best: { sx: number; sy: number; dx: number; dy: number; off: number; dist: number; score: number } | null = null;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      for (const off of [0.3, -0.3, 0.2, -0.2]) {
        const o = off * rPiece;
        const sx = t0.x - dx * (rPiece + 200) - dy * o;
        const sy = t0.y - dy * (rPiece + 200) + dx * o;
        const h = internal.rayHit(sx, sy, dx, dy, rPiece * 2 + 400, 'bb-shooter');
        if (h === null || h.id !== target || h.dist < 20) continue;
        // No grazing a neighbour on the way: lines 20 u either side (the
        // pieces drift and turn a little during the flight) hit it first too.
        let clear = true;
        for (const side of [-20, 20]) {
          const hs = internal.rayHit(sx - dy * side, sy + dx * side, dx, dy, rPiece * 2 + 400, 'bb-shooter');
          if (hs === null || hs.id !== target) clear = false;
        }
        if (!clear) continue;
        const score = dx * outX + dy * outY;
        if (best === null || score > best.score) best = { sx, sy, dx, dy, off: o, dist: h.dist, score };
      }
    }
    expect(best, 'some line of fire reaches the biggest piece first').not.toBeNull();
    const shot = best!;

    const before = internal.wreckState(target)!;
    internal.spawnTestProjectile('bb-shooter', shot.sx, shot.sy, shot.dx * SHELL_SPEED, shot.dy * SHELL_SPEED, 'naval_xl', SHELL_DAMAGE);
    // Long enough for the shell to arrive, short enough that the shoved
    // piece can't reach a neighbour while we measure.
    await harness.advance((shot.dist / SHELL_SPEED) * 1000 + 120);
    const after = internal.wreckState(target)!;

    const dvx = after.vx - before.vx, dvy = after.vy - before.vy;
    const along = dvx * shot.dx + dvy * shot.dy;
    const across = Math.abs(-dvx * shot.dy + dvy * shot.dx);
    const dw = after.angvel - before.angvel;
    const t = shipTuning(kind);
    const expected = Math.min((SHELL_DAMAGE / kind.maxHealth) * kind.mass * t.wreckKnockSpeed / massOf(target), t.wreckKnockMax);
    console.log(`[wreck knockback] piece ${target} mass ${massOf(target).toFixed(0)} r ${rPiece.toFixed(0)}: Δv along ${along.toFixed(2)} u/s (expected ${expected.toFixed(2)}), across ${across.toFixed(2)}, Δω ${(dw * 180 / Math.PI).toFixed(3)} deg/s, offset ${shot.off.toFixed(0)} u`);

    expect(along, 'the overkill shell shoves the piece along the shot (u/s)').toBeGreaterThan(10);
    expect(along, '...by about the expected impulse').toBeGreaterThan(0.7 * expected);
    expect(along, '...and no more').toBeLessThan(1.2 * expected);
    expect(along, 'nothing flies off absurdly fast').toBeLessThan(0.03 * kind.radius);
    expect(across, 'the shove is along the shot').toBeLessThan(0.25 * along);
    // An off-centre hit turns the piece: the hit point sits `off` to the left
    // of the line through the centre, so a shot along +d turns it clockwise
    // (negative ω) for off > 0.
    expect(Math.abs(dw) * 180 / Math.PI, 'the off-centre hit turns the piece (deg/s)').toBeGreaterThan(0.3);
    expect(Math.sign(dw), 'it turns the way the off-centre hit pushes it').toBe(-Math.sign(shot.off));
  }, 60_000);
});

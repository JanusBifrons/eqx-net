/**
 * A drone-faction ship that warps out (a morale Flee) is drawn leaving: the
 * client path from the snapshot's `drones[].warp` (applyDroneMountAngles)
 * through to WarpFx, fed the way PixiRenderer.drawWarpFx feeds swarm ships
 * (while their phase is set, and one frame after it clears).
 *
 * Take 7 (2026-11-14): the followed fighter sat still and then vanished with
 * no effect. The room now shows the run before it removes the ship; the
 * snapshot and the swarm stream are separate packets, so the ship can still
 * be in the swarm mirror for a frame after the snapshot stops naming it.
 */
import { describe, it, expect } from 'vitest';
import { WarpFx } from './WarpFx.js';
import { applyDroneMountAngles } from '../../net/snapshotRemoteSync.js';
import type { RenderMirror, SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../../shared-types/messages.js';

const EID = 41;
const STERN = 30;

/** One render frame of the swarm ships, as drawWarpFx feeds them. */
function render(fx: WarpFx, ms: number, mirror: RenderMirror, fed: Set<number>): void {
  fx.beginFrame(ms);
  for (const [eid, e] of mirror.swarm!) {
    if (e.kind !== 1) continue;
    if (e.warp === undefined && !fed.has(eid)) continue;
    // Pixi space: y flipped (the sprite pose the renderer hands WarpFx).
    fx.draw(`swarm-${eid}`, { x: e.x, y: -e.y, rotation: -e.angle, warp: e.warp, stern: STERN, isLocal: false });
    if (e.warp === undefined) fed.delete(eid); else fed.add(eid);
  }
  fx.endFrame();
}

const snap = (warp?: 1 | 2): SnapshotMessage => ({ drones: warp === undefined ? undefined : [{ id: EID, warp }] }) as unknown as SnapshotMessage;

describe('WarpFx: a swarm ship warping out', () => {
  it('draws the departure where it spooled, and nothing more while the swarm stream catches up', () => {
    const fx = new WarpFx();
    const fed = new Set<number>();
    // A drone-faction fighter at (500, 200) flying north (nose +y).
    const ship = { kind: 1, x: 500, y: 200, angle: 0, radius: 12, shipKind: 'fighter' } as SwarmRenderState;
    const mirror = { swarm: new Map<number, SwarmRenderState>([[EID, ship]]) } as unknown as RenderMirror;
    let t = 0;
    // The spool: it keeps flying north.
    for (let i = 0; i < 30; i++) {
      applyDroneMountAngles(snap(1), mirror);
      ship.y += 10;
      render(fx, (t += 100), mirror, fed);
    }
    expect(fx.burstCount()).toBe(0);
    const spoolY = ship.y;
    // The run begins: the departure.
    applyDroneMountAngles(snap(2), mirror);
    render(fx, (t += 16), mirror, fed);
    expect(fx.burstCount(), 'the departure is drawn').toBe(1);
    const b = fx.lastBurst();
    expect(b.kind).toBe('depart');
    // At its spool pose (less the stern), Pixi space.
    expect(Math.hypot(b.x - 500, b.y - -(spoolY - STERN))).toBeLessThan(1);
    // The room removes it: the snapshot stops naming it a frame before the
    // swarm stream drops it. No second effect (no "arrival"), still hidden.
    applyDroneMountAngles(snap(undefined), mirror);
    render(fx, (t += 16), mirror, fed);
    expect(ship.warp, 'still on its run (hidden)').toBe(2);
    expect(fx.lastBurst().kind, 'no arrival drawn').toBe('depart');
    mirror.swarm!.delete(EID);
    render(fx, (t += 16), mirror, fed);
    expect(fx.burstCount()).toBe(1);
    expect(fx.lastBurst().kind).toBe('depart');
  });
});

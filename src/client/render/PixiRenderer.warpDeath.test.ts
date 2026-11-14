/**
 * Take 12 film review (fleet-melee 26.5-27.5 s): an AI fighter killed while
 * spooling a warp left two long, straight orange lines running off screen
 * from its wreck halves, for about two seconds. They read as engine trails on
 * the wreck, a ship still flying.
 *
 * They were the warp DEPARTURE (a white hull streak, then two burning engine
 * trails 1600 u along the spool heading, 2.2 s). WarpFx reads "a spooling
 * ship left the mirror" as "it warped out to another sector", and a ship that
 * dies leaves the mirror too. A ship that dies mid-spool did not warp: it
 * must draw no departure (its explosion and wreck are the whole story).
 *
 * Driven at the renderer: the real `drawWarpFx` on a prototype-backed
 * instance (a full PixiRenderer needs WebGL), with a real `WarpFx`, so the
 * test exercises the death decision where it lives.
 */
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { PixiRenderer } from './PixiRenderer';
import { WarpFx } from './pixi/WarpFx';
import type { RenderMirror, SwarmRenderState } from '@core/contracts/IRenderer';

type Harness = { drawWarpFx(mirror: RenderMirror): void };

function makeRenderer(): { r: Harness; fx: WarpFx; setNow(ms: number): void } {
  let now = 0;
  const fx = new WarpFx();
  const r = Object.create(PixiRenderer.prototype) as Harness & Record<string, unknown>;
  const sprite = new Container();
  sprite.position.set(100, -200);
  r._warpFx = fx;
  r._spoolFx = { beginFrame: () => {}, endFrame: () => {} };
  r.drawSpoolFx = () => {};
  r.fxClock = { now: () => now };
  r.world = { scale: { x: 1 } };
  r.sprites = new Map([['swarm-7', sprite]]);
  r._warpShipScratch = { x: 0, y: 0, rotation: 0, warp: undefined, stern: 0, isLocal: false };
  r._warpStern = new Map<string, number>();
  r._droneWarpFed = new Set<string>();
  r._droneWarpKeys = new Map<number, string>();
  return { r, fx, setNow: (ms) => { now = ms; } };
}

function mirror(swarm: Map<number, SwarmRenderState>, exploding: string[] = []): RenderMirror {
  return { ships: new Map(), swarm, explodingShips: new Set(exploding) } as unknown as RenderMirror;
}

const spooling = (): SwarmRenderState => ({ kind: 1, x: 100, y: 200, angle: 0, radius: 12, shipKind: 'fighter', warp: 1 } as SwarmRenderState);

describe('PixiRenderer.drawWarpFx — a ship killed mid-spool draws no warp departure', () => {
  it('an AI ship that dies while spooling leaves no departure trails', () => {
    const { r, fx, setNow } = makeRenderer();
    const swarm = new Map([[7, spooling()]]);
    for (let f = 0; f < 10; f++) { setNow(f * 16); r.drawWarpFx(mirror(swarm)); }
    expect(fx.spoolCount()).toBe(1);
    // Killed: the client drops its swarm entry and marks it exploding, same frame.
    swarm.delete(7);
    setNow(200);
    r.drawWarpFx(mirror(swarm, ['swarm-7']));
    expect(fx.burstCount(), 'a death is not a warp-out').toBe(0);
  });

  it('an AI ship that leaves mid-spool without dying still draws its departure', () => {
    const { r, fx, setNow } = makeRenderer();
    const swarm = new Map([[7, spooling()]]);
    for (let f = 0; f < 10; f++) { setNow(f * 16); r.drawWarpFx(mirror(swarm)); }
    swarm.delete(7);
    setNow(200);
    r.drawWarpFx(mirror(swarm));
    expect(fx.burstCount()).toBe(1);
  });
});

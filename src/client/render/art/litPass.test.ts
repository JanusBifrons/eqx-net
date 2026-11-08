/**
 * The GPU-lit art's one lighting pass a frame (plan prancy-squishing-donut
 * R2): meshes register when built and leave when destroyed; `finish` lights
 * only meshes shown under the world container, from their pose in it.
 */
import { describe, expect, it } from 'vitest';
import { Container, Texture } from 'pixi.js';
import { LitPass } from './litPass.js';
import { LitShipMesh, type LitTile } from './litShipShader.js';
import { LOOK_NIGHT } from './lightingSettings.js';
import { DEFAULT_RIG } from './shade.js';

function tile(): LitTile {
  return { tex: Texture.WHITE, w: 1, rows: 1, y0: 0, hullH: 1, ppu: 1, maxH: 1, emisMax: 1 };
}

describe('LitPass', () => {
  it('lights only registered meshes shown under the world, and forgets destroyed ones', () => {
    const pass = new LitPass();
    const world = new Container(), ship = new Container(), hidden = new Container();
    world.addChild(ship, hidden);
    hidden.visible = false;
    const a = new LitShipMesh(tile(), LOOK_NIGHT), b = new LitShipMesh(tile(), LOOK_NIGHT), stray = new LitShipMesh(tile(), LOOK_NIGHT);
    ship.addChild(a); hidden.addChild(b);
    pass.register(a); pass.register(b); pass.register(stray); pass.register(a);
    expect(pass.count).toBe(3);
    pass.begin();
    pass.finish(world, DEFAULT_RIG);
    expect(pass.lastLit).toBe(1); // b is hidden, stray isn't under the world
    a.emit('destroyed', a); // what destroy() sends
    expect(pass.count).toBe(2);
  });

  it("a big hull becomes an occluder at its pose in the world", () => {
    const pass = new LitPass();
    const world = new Container();
    world.position.set(500, 300); world.scale.set(0.5); // camera
    const hull = new Container();
    hull.position.set(100, -40); hull.rotation = 0.7;
    world.addChild(hull);
    const m = new LitShipMesh(tile(), LOOK_NIGHT);
    m.occluderId = 3;
    hull.addChild(m);
    pass.register(m, { hx: 40, hy: 300, h: 70, color: 0x888888 });
    pass.begin();
    pass.finish(world, DEFAULT_RIG);
    const o = pass.scene.occluders[0]!;
    expect(pass.scene.occluderCount).toBe(1);
    expect(o.x).toBeCloseTo(100); expect(o.y).toBeCloseTo(-40); expect(o.rot).toBeCloseTo(0.7);
  });
});

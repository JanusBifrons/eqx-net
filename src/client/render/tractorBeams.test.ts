/**
 * Tractor beams on screen (salvage plan PR 11b): `fillTractorBeams` turns
 * `mirror.tractorLinks` into the tractor pool's beam views (one glowing beam
 * from the barrel tip to the target), and the
 * decode → draw path from the snapshot's beam links to drawn sprites.
 */
import { describe, expect, it } from 'vitest';
import { fillTractorBeams } from './tractorBeams.js';
import { BeamSpritePool, type BeamView } from './BeamSpritePool.js';
import { TRACTOR_BEAM_STYLE, TRACTOR_BEAM_COLOR, TRACTOR_BEAM_CROSS_SECTION, MINING_LASER_STYLE } from './beamStyles.js';
import { MINING_LASER_WIDTH } from '../../core/combat/WeaponCatalogue.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipShotMuzzle } from '../../core/combat/muzzle.js';
import { TractorLinkClient } from '../net/tractorLinks.js';
import { encodeTractorLink, type BeamLinks } from '../../shared-types/beamLinksWire.js';
import type { RenderMirror, ShipRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';

const KIND = getShipKind('interceptor');
const MOUNT = KIND.mounts![0]!;
const SCALE = 0.5; // screen px per world u

function mirror(over: Partial<RenderMirror> = {}): Pick<RenderMirror, 'ships' | 'swarm' | 'tractorLinks'> {
  const ships = new Map<string, ShipRenderState>([
    ['me', { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'interceptor' } as ShipRenderState],
  ]);
  const swarm = new Map<number, SwarmRenderState>([
    [42, { x: 0, y: 1500, angle: 0, vx: 0, vy: 0, kind: 1, radius: 20, shipKind: 'fighter' } as SwarmRenderState],
  ]);
  return { ships, swarm, tractorLinks: [{ emitter: 'me', mountId: MOUNT.id, target: 42 }], ...over };
}

const views = (): BeamView[] => [];

describe('fillTractorBeams', () => {
  it('draws the beam from the mount barrel tip to the target centre, in the tractor beam style', () => {
    const out = views();
    const n = fillTractorBeams(mirror(), 0, SCALE, out);
    expect(n).toBe(1);
    const line = out[0]!;
    expect(line.style).toBe(TRACTOR_BEAM_STYLE);
    const pivotX = MOUNT.localX, pivotY = MOUNT.localY; // angle 0
    const muzzle = shipShotMuzzle(KIND, MOUNT);
    // Mount at rest (no angles): the barrel points along baseAngle.
    expect(line.fromX).toBeCloseTo(pivotX - Math.sin(MOUNT.baseAngle) * muzzle, 6);
    expect(line.fromY).toBeCloseTo(pivotY + Math.cos(MOUNT.baseAngle) * muzzle, 6);
    expect(line.toX).toBe(0);
    expect(line.toY).toBe(1500);
  });

  it('draws the beam alone (no pulses or rings)', () => {
    const out = views();
    expect(fillTractorBeams(mirror(), 1234, SCALE, out)).toBe(1);
    expect(out[0]!.style).toBe(TRACTOR_BEAM_STYLE);
  });

  it('draws nothing when the emitter or the target is not in the mirror (or no links)', () => {
    expect(fillTractorBeams(mirror({ tractorLinks: [{ emitter: 'gone', mountId: MOUNT.id, target: 42 }] }), 0, SCALE, views())).toBe(0);
    expect(fillTractorBeams(mirror({ tractorLinks: [{ emitter: 'me', mountId: MOUNT.id, target: 7 }] }), 0, SCALE, views())).toBe(0);
    expect(fillTractorBeams(mirror({ tractorLinks: [] }), 0, SCALE, views())).toBe(0);
  });

  it('reuses its views frame to frame (no allocation once grown, #14)', () => {
    const out = views();
    fillTractorBeams(mirror(), 0, SCALE, out);
    const first = out[0];
    fillTractorBeams(mirror(), 16, SCALE, out);
    expect(out[0]).toBe(first);
  });
});

describe('tractor look (owner: "like a beam weapon, just with a blue glow")', () => {
  it('draws like a beam weapon: a baked cross-section, solid to the target, a beam width, blue', () => {
    expect(TRACTOR_BEAM_STYLE.crossSection).toBe(TRACTOR_BEAM_CROSS_SECTION);
    expect(TRACTOR_BEAM_STYLE.taper).toBeFalsy();
    expect(TRACTOR_BEAM_STYLE.width).toBeGreaterThan(MINING_LASER_WIDTH / 2);
    expect(TRACTOR_BEAM_STYLE.width).toBeLessThan(MINING_LASER_STYLE.width);
    // More glow than body: a wider soft edge than the mining laser.
    expect(TRACTOR_BEAM_CROSS_SECTION.span).toBeGreaterThan(MINING_LASER_STYLE.crossSection!.span);
    // The glow (every stop past the white core) is blue.
    for (const st of TRACTOR_BEAM_CROSS_SECTION.stops.slice(2)) {
      const r = (st.color >> 16) & 0xff, b = st.color & 0xff;
      expect(b).toBeGreaterThan(r);
    }
    const r = (TRACTOR_BEAM_COLOR >> 16) & 0xff, g = (TRACTOR_BEAM_COLOR >> 8) & 0xff, b = TRACTOR_BEAM_COLOR & 0xff;
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });
});

describe('decode → draw (snapshot beam links to tractor sprites)', () => {
  it('a snapshot tractor link becomes a glowing beam in the tractor pool', () => {
    const m = mirror({ tractorLinks: undefined });
    const client = new TractorLinkClient(m as never, new Map());
    const flat: BeamLinks = [];
    encodeTractorLink(flat, 0, 'me', MOUNT.id, 42, 10, 22);
    client.sync(flat, { structure: () => {}, tractor: client.add }, null);
    const out = views();
    const n = fillTractorBeams(m, 500, SCALE, out);
    const pool = new BeamSpritePool(TRACTOR_BEAM_STYLE);
    pool.setBeams(out, n, SCALE);
    expect(pool.liveCount).toBe(n);
    const line = pool.coreAt(0)!;
    expect(line.parent).toBe(pool.styledContainer);
    expect(line.tint).toBe(0xffffff); // the cross-section carries the colours
    expect(line.alpha).toBeCloseTo(TRACTOR_BEAM_STYLE.alpha, 6);
    // The lease ends: nothing drawn.
    client.sync(undefined, { structure: () => {}, tractor: client.add }, null);
    pool.setBeams(out, fillTractorBeams(m, 516, SCALE, out), SCALE);
    expect(pool.liveCount).toBe(0);
  });
});

describe('fillTractorBeams: the beam leaves the drawn dish (owner bug: beams between the dishes)', () => {
  // The drawn gun turns by `mountAngles[i]` (applyMountAngles); its tip is
  // pivot + forward(ship.angle + baseAngle + angle) * the shared muzzle.
  function tip(kind: ReturnType<typeof getShipKind>, m: typeof MOUNT, shipAngle: number, mountAngle: number): { x: number; y: number } {
    const c = Math.cos(shipAngle), s = Math.sin(shipAngle);
    const px = m.localX * c - m.localY * s, py = m.localX * s + m.localY * c;
    const a = shipAngle + m.baseAngle + mountAngle;
    const mz = shipShotMuzzle(kind, m);
    return { x: px - Math.sin(a) * mz, y: py + Math.cos(a) * mz };
  }

  it('starts at the drawn barrel tip, not the point toward the target, when the turret is turned', () => {
    const m = mirror();
    const ship = m.ships.get('me')!;
    ship.mountAngles = KIND.mounts!.map(() => 0);
    ship.mountAngles[0] = 0.6; // barrel turned off the target line
    const out = views();
    fillTractorBeams(m, 0, SCALE, out);
    const t = tip(KIND, MOUNT, 0, 0.6);
    expect(out[0]!.fromX).toBeCloseTo(t.x, 6);
    expect(out[0]!.fromY).toBeCloseTo(t.y, 6);
  });

  it('finds an activated (latent) tractor mount and starts at its dish', () => {
    const fighter = getShipKind('fighter');
    const latent = fighter.latentMounts![0]!;
    const ships = new Map<string, ShipRenderState>([
      ['me', {
        x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'fighter',
        activatedMounts: [{ slotId: latent.id, weaponId: 'tractor' }],
      } as ShipRenderState],
    ]);
    const n = (fighter.mounts ?? []).length;
    ships.get('me')!.mountAngles = new Array<number>(n + 1).fill(0);
    ships.get('me')!.mountAngles![n] = -0.4; // catalogue/instance order: latent after base
    const m = mirror({ ships, tractorLinks: [{ emitter: 'me', mountId: latent.id, target: 42 }] });
    const out = views();
    fillTractorBeams(m, 0, SCALE, out);
    const t = tip(fighter, { ...latent, weaponId: 'tractor' } as typeof MOUNT, 0, -0.4);
    expect(out[0]!.fromX).toBeCloseTo(t.x, 6);
    expect(out[0]!.fromY).toBeCloseTo(t.y, 6);
  });
});

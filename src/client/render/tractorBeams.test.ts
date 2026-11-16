/**
 * Tractor beams on screen (salvage plan PR 11b): `fillTractorBeams` turns
 * `mirror.tractorLinks` into the tractor pool's beam views (a faint line from
 * the barrel tip to the target, rings travelling toward the emitter), and the
 * decode → draw path from the snapshot's beam links to drawn sprites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillTractorBeams, TRACTOR_MAX_PULSES, TRACTOR_PULSE_SPACING_PX } from './tractorBeams.js';
import { BeamSpritePool, type BeamView } from './BeamSpritePool.js';
import { TRACTOR_BEAM_STYLE, TRACTOR_PULSE_STYLE, TRACTOR_BEAM_COLOR, TRACTOR_BEAM_CROSS_SECTION, MINING_LASER_STYLE, setBeamLooks } from './beamStyles.js';
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
  // Look B (`?tractorLook=b`) draws the pulses; look A only the beam.
  beforeEach(() => setBeamLooks('?tractorLook=b'));
  afterEach(() => setBeamLooks(''));

  it('draws the beam from the mount barrel tip to the target centre, in the tractor beam style', () => {
    const out = views();
    const n = fillTractorBeams(mirror(), 0, SCALE, out);
    expect(n).toBeGreaterThan(1);
    const line = out[0]!;
    expect(line.style).toBe(TRACTOR_BEAM_STYLE);
    const pivotX = MOUNT.localX, pivotY = MOUNT.localY; // angle 0
    const muzzle = shipShotMuzzle(KIND, MOUNT);
    const d = Math.hypot(0 - pivotX, 1500 - pivotY);
    expect(line.fromX).toBeCloseTo(pivotX + ((0 - pivotX) / d) * muzzle, 6);
    expect(line.fromY).toBeCloseTo(pivotY + ((1500 - pivotY) / d) * muzzle, 6);
    expect(line.toX).toBe(0);
    expect(line.toY).toBe(1500);
  });

  it('look A (default) draws the beam alone, no pulses', () => {
    setBeamLooks('');
    const out = views();
    expect(fillTractorBeams(mirror(), 1234, SCALE, out)).toBe(1);
    expect(out[0]!.style).toBe(TRACTOR_BEAM_STYLE);
  });

  it('look B pulses travel along the beam TOWARD the emitter as game time runs', () => {
    const m = mirror();
    const a = views(), b = views();
    fillTractorBeams(m, 10_000, SCALE, a);
    fillTractorBeams(m, 10_100, SCALE, b); // 100 ms later
    const ringY = (v: BeamView) => (v.fromY + v.toY) / 2;
    // The same (first) ring, 100 ms on: closer to the emitter (y 0).
    expect(a[1]!.style).toBe(TRACTOR_PULSE_STYLE);
    expect(ringY(b[1]!)).toBeLessThan(ringY(a[1]!));
    // Along the beam: a pulse is parallel to it.
    const l = a[0]!, ring = a[1]!;
    expect((ring.toX - ring.fromX) * (l.toY - l.fromY) - (ring.toY - ring.fromY) * (l.toX - l.fromX)).toBeCloseTo(0, 3);
    expect(Math.hypot(ring.toX - ring.fromX, ring.toY - ring.fromY)).toBeGreaterThan(0);
  });

  it('pulses fade in at the target and out at the barrel; spacing is in screen px; capped per beam', () => {
    const out = views();
    const n = fillTractorBeams(mirror(), 1234, SCALE, out);
    for (let i = 1; i < n; i++) {
      expect(out[i]!.alphaMul).toBeGreaterThan(0);
      expect(out[i]!.alphaMul).toBeLessThanOrEqual(1);
    }
    const mid = (v: BeamView) => [(v.fromX + v.toX) / 2, (v.fromY + v.toY) / 2] as const;
    const gap = Math.hypot(mid(out[2]!)[0] - mid(out[1]!)[0], mid(out[2]!)[1] - mid(out[1]!)[1]);
    expect(gap).toBeCloseTo(TRACTOR_PULSE_SPACING_PX / SCALE, 6);
    // A very long beam at a far zoom: never more than the cap.
    const far = mirror();
    far.swarm!.get(42)!.y = 200_000;
    expect(fillTractorBeams(far, 0, 2, views()) - 1).toBeLessThanOrEqual(TRACTOR_MAX_PULSES);
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
  it('a snapshot tractor link becomes a glowing beam plus pulses in the tractor pool', () => {
    setBeamLooks('?tractorLook=b');
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
    const ring = pool.coreAt(1)!;
    expect(ring.parent).toBe(pool.styledContainer);
    expect(ring.alpha).toBeCloseTo(TRACTOR_PULSE_STYLE.alpha * out[1]!.alphaMul!, 6);
    // The lease ends: nothing drawn.
    client.sync(undefined, { structure: () => {}, tractor: client.add }, null);
    pool.setBeams(out, fillTractorBeams(m, 516, SCALE, out), SCALE);
    expect(pool.liveCount).toBe(0);
    setBeamLooks('');
  });
});

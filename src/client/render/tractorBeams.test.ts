/**
 * Tractor beams on screen (salvage plan PR 11b): `fillTractorBeams` turns
 * `mirror.tractorLinks` into the tractor pool's beam views (a faint line from
 * the barrel tip to the target, rings travelling toward the emitter), and the
 * decode → draw path from the snapshot's beam links to drawn sprites.
 */
import { describe, expect, it } from 'vitest';
import { fillTractorBeams, TRACTOR_MAX_PULSES, TRACTOR_PULSE_SPACING_PX } from './tractorBeams.js';
import { BeamSpritePool, type BeamView } from './BeamSpritePool.js';
import { TRACTOR_BEAM_STYLE, TRACTOR_PULSE_STYLE, TRACTOR_BEAM_COLOR, REMOTE_BEAM_STYLE, MINING_BEAM_STYLE } from './beamStyles.js';
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
  it('draws the line from the mount barrel tip to the target centre, in the pool style', () => {
    const out = views();
    const n = fillTractorBeams(mirror(), 0, SCALE, out);
    expect(n).toBeGreaterThan(1);
    const line = out[0]!;
    expect(line.style).toBeNull(); // the tractor pool's own style: TRACTOR_BEAM_STYLE
    const pivotX = MOUNT.localX, pivotY = MOUNT.localY; // angle 0
    const muzzle = shipShotMuzzle(KIND, MOUNT);
    const d = Math.hypot(0 - pivotX, 1500 - pivotY);
    expect(line.fromX).toBeCloseTo(pivotX + ((0 - pivotX) / d) * muzzle, 6);
    expect(line.fromY).toBeCloseTo(pivotY + ((1500 - pivotY) / d) * muzzle, 6);
    expect(line.toX).toBe(0);
    expect(line.toY).toBe(1500);
  });

  it('rings travel along the line TOWARD the emitter as game time runs', () => {
    const m = mirror();
    const a = views(), b = views();
    fillTractorBeams(m, 10_000, SCALE, a);
    fillTractorBeams(m, 10_100, SCALE, b); // 100 ms later
    const ringY = (v: BeamView) => (v.fromY + v.toY) / 2;
    // The same (first) ring, 100 ms on: closer to the emitter (y 0).
    expect(a[1]!.style).toBe(TRACTOR_PULSE_STYLE);
    expect(ringY(b[1]!)).toBeLessThan(ringY(a[1]!));
    // Across the line: a ring is perpendicular to it.
    const l = a[0]!, ring = a[1]!;
    expect((ring.toX - ring.fromX) * (l.toX - l.fromX) + (ring.toY - ring.fromY) * (l.toY - l.fromY)).toBeCloseTo(0, 6);
    expect(Math.abs(a[1]!.fromX - a[1]!.toX)).toBeGreaterThan(0);
  });

  it('rings fade in at the target and out at the barrel; spacing is in screen px; capped per beam', () => {
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

describe('tractor look (owner: faint, thin, pale blue; not a weapon beam)', () => {
  it('fainter and thinner than the combat and mining beams, flat (no taper), pale blue', () => {
    expect(TRACTOR_BEAM_STYLE.alpha).toBeLessThan(0.5);
    expect(TRACTOR_BEAM_STYLE.alpha).toBeLessThan(REMOTE_BEAM_STYLE.alpha);
    expect(TRACTOR_BEAM_STYLE.width).toBeLessThan(REMOTE_BEAM_STYLE.width);
    expect(TRACTOR_BEAM_STYLE.width).toBeLessThan(MINING_BEAM_STYLE.width);
    expect(TRACTOR_BEAM_STYLE.taper).toBeFalsy();
    const r = (TRACTOR_BEAM_COLOR >> 16) & 0xff, g = (TRACTOR_BEAM_COLOR >> 8) & 0xff, b = TRACTOR_BEAM_COLOR & 0xff;
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(0x80); // pale, not a saturated blue
  });
});

describe('decode → draw (snapshot beam links to tractor sprites)', () => {
  it('a snapshot tractor link becomes a faint line plus rings in the tractor pool', () => {
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
    expect(line.parent).toBe(pool.container);
    expect(line.tint).toBe(TRACTOR_BEAM_COLOR);
    expect(line.alpha).toBeCloseTo(TRACTOR_BEAM_STYLE.alpha, 6);
    expect(line.width).toBeCloseTo(TRACTOR_BEAM_STYLE.minScreenPx! / SCALE, 6); // a hair at any zoom
    const ring = pool.coreAt(1)!;
    expect(ring.parent).toBe(pool.styledContainer);
    expect(ring.alpha).toBeCloseTo(TRACTOR_PULSE_STYLE.alpha * out[1]!.alphaMul!, 6);
    // The lease ends: nothing drawn.
    client.sync(undefined, { structure: () => {}, tractor: client.add }, null);
    pool.setBeams(out, fillTractorBeams(m, 516, SCALE, out), SCALE);
    expect(pool.liveCount).toBe(0);
  });
});

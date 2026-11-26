/**
 * Base platforms (bp-35) — the deck's draw order on `shipContainer`.
 *
 * Owner report: power cables drew over road tiles, over a freight dock's
 * loading apron and over building art. The cables (static chunks and their
 * per-frame flow) now ride their own band:
 *
 *   plates < zone paint < cables < road tiles (+ joins, lamps) < rig pads
 *   < bodies (connector pylons, fence posts) and fence beams.
 */
import { describe, it, expect } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { ConnectorRenderer } from './ConnectorRenderer.js';
import { DECK_UNDER_Z } from './structureDeckPlates.js';
import { CABLE_UNDER_Z, DECK_ZONE_Z, ROAD_UNDER_Z } from './structureDeckZones.js';
import { RIG_OVER_Z, RIG_UNDER_Z } from './structureRigs.js';
import { DECK_FENCE_POST_KIND } from '../../../core/structures/deckLinks.js';
import { hexCornerInto, HEX_DIRS } from '../../../core/hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto } from '../../../core/hex/plates.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';

/** Hull / structure body band (sprites keep zIndex 0). */
const BODY_Z = 0;

describe('deck layer bands (zIndex)', () => {
  it('plates < zone paint < cables < roads < rig pads < bodies < rig over band', () => {
    const order = [DECK_UNDER_Z, DECK_ZONE_Z, CABLE_UNDER_Z, ROAD_UNDER_Z, RIG_UNDER_Z, BODY_Z, RIG_OVER_Z];
    for (let i = 1; i < order.length; i++) expect(order[i]!).toBeGreaterThan(order[i - 1]!);
  });

  it('the connector renderer puts its cables on the cable band; rings, walls and fence beams stay on the body band', () => {
    const r = new ConnectorRenderer();
    expect(r.cableStaticGfx.zIndex).toBe(CABLE_UNDER_Z);
    expect(r.cableGfx.zIndex).toBe(CABLE_UNDER_Z);
    expect(r.staticGfx.zIndex).toBe(BODY_Z);
    expect(r.gfx.zIndex).toBe(BODY_Z);
  });

  it('sorted on one container, whatever the add order: plates, zones, cables, road, pad, pylon', () => {
    const r = new ConnectorRenderer();
    const ship = new Container();
    ship.sortableChildren = true;
    const named = (label: string, z: number): Container => { const c = new Container(); c.label = label; c.zIndex = z; return c; };
    // Add order as in game: connector layers first (init), sprites and deck later.
    r.staticGfx.label = 'rings+fence'; r.gfx.label = 'perFrame';
    r.cableStaticGfx.label = 'cables'; r.cableGfx.label = 'cableFlow';
    ship.addChild(r.staticGfx, r.gfx, r.cableStaticGfx, r.cableGfx);
    ship.addChild(named('pylon', BODY_Z), named('pad', RIG_UNDER_Z), named('road', ROAD_UNDER_Z), named('zones', DECK_ZONE_Z), named('plates', DECK_UNDER_Z));
    ship.sortChildren();
    expect(ship.children.map((c) => c.label)).toEqual(
      ['plates', 'zones', 'cables', 'cableFlow', 'road', 'pad', 'rings+fence', 'perFrame', 'pylon'],
    );
  });
});

describe('which connector layer a deck link draws on', () => {
  const pose = (kind: string, x: number, y: number): SwarmRenderState => ({
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: [], ringHead: 0, radius: 40, kind: 2, shipKind: kind, sleeping: true, lastUpdateTick: 0,
  }) as unknown as SwarmRenderState;
  const row = (): StructureRenderState => ({
    powered: true, netPower: 50, connTo: [], built: true, buildPct: 1, deconstructPct: 0, wallActive: false,
  }) as unknown as StructureRenderState;
  const centre = deckHexCentreInto(0, 0, { x: 0, y: 0 });
  const corner = (i: number): { x: number; y: number } => hexCornerInto(centre.x, centre.y, DECK_HEX_SIZE, i, { x: 0, y: 0 });
  const c0 = corner(0), c1 = corner(1);
  const d = HEX_DIRS[2]!;
  const p = deckHexCentreInto(d.q, d.r, { x: 0, y: 0 });

  /** A fence (post–post on one seam) and/or a building cable (anchor–solar). */
  function mirror(fence: boolean, cable: boolean): RenderMirror {
    const swarm = new Map<number, SwarmRenderState>([
      [1, pose(DECK_FENCE_POST_KIND, c0.x, c0.y)], [2, pose(DECK_FENCE_POST_KIND, c1.x, c1.y)],
      [3, pose('connector', centre.x, centre.y)], [4, pose('solar', p.x, p.y)],
    ]);
    const structures = new Map<number, StructureRenderState>([[1, row()], [2, row()], [3, row()], [4, row()]]);
    const link = (a: number, b: number): void => { structures.get(a)!.connTo.push(b); structures.get(b)!.connTo.push(a); };
    if (fence) link(1, 2);
    if (cable) link(3, 4);
    return { swarm, structures, deckPlates: { deck: true } } as unknown as RenderMirror;
  }

  function strokes(layer: Container): number {
    let n = 0;
    for (const c of layer.children as Graphics[]) {
      if (!c.visible) continue;
      for (const i of (c.context as unknown as { instructions: { action: string }[] }).instructions) if (i.action === 'stroke') n++;
    }
    return n;
  }

  function draw(fence: boolean, cable: boolean): ConnectorRenderer {
    const r = new ConnectorRenderer();
    r.socketCables = true;
    r.cables.fenceBeams = true;
    r.update(mirror(fence, cable), 0.5, 0);
    return r;
  }

  it('a building cable draws only on the cable band', () => {
    const r = draw(false, true);
    expect(r.cables.isFenceBeam(pose('connector', 0, 0), pose('solar', p.x, p.y))).toBe(false);
    expect(strokes(r.cableStaticGfx)).toBeGreaterThan(0);
    expect(strokes(r.staticGfx)).toBe(0);
  });

  it('a fence beam keeps the body band (over road tiles at a gate), never the cable band', () => {
    const r = draw(true, false);
    expect(strokes(r.staticGfx)).toBeGreaterThan(0);
    expect(strokes(r.cableStaticGfx)).toBe(0);
  });
});

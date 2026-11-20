/**
 * Style C family "heavyIndustry" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Heavy industry: ore processing complex, assembly plant, shipyard.
 * This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import { GraphicsContext } from 'pixi.js';
import type { Rig } from '../../../core/articulation/rig.js';
import {
  SHIPYARD_CLAMP_HALF_W, SHIPYARD_CLAMP_LEN, SHIPYARD_CLAMP_XS, SHIPYARD_CLAMP_Y, SHIPYARD_GANTRY_BOGIE,
  SHIPYARD_GANTRY_HALF_X, SHIPYARD_GANTRY_TRAVEL, SHIPYARD_HOIST_HALF, SHIPYARD_RAIL_Y, SHIPYARD_SLIP_HALF_W, SHIPYARD_SLIP_X0, SHIPYARD_SLIP_X1,
  SHIPYARD_WALL_HALF_L, SHIPYARD_WALL_HALF_T, SHIPYARD_WALL_TRAVEL, SHIPYARD_WALL_Y, SHIPYARD_BAY_COUNT, shipyardBayKeel,
} from '../../../core/articulation/rigs/heavyIndustry.js';
import {
  CRANE, HAZARD, LAMP_AMBER, LAMP_WHITE, RIVET, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, STEEL, chamferBox, chevron,
  core, deck, glow, grime, lamp, ngon, poly, rivets, stencil, strip, walkway, weld, wornStripe,
  type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';
import {
  SHIPYARD_BAY_MARK_XS, shipyardKeelContext, shipyardLightContext, shipyardPartShow, shipyardPrintContext, shipyardRowClip,
} from './structureStyleC.shipyardBuild.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'h4';

/** Shipyard (`shipyard`, 960 × 600, mock-up C "build frame" for sub-caps).
 *  Baked here: the deck, a sunken slipway down the middle with keel blocks
 *  (its mouth open at the bow, +x, with hazard chevrons) marked into
 *  its build bays (loop 3R), the clamp ledges
 *  and pivot bosses, the wall tracks the side walls slide out along, the
 *  gantry rails on the long edges and the stern headhouse. The walls,
 *  gantry + hoist, clamps and light strips are the `shipyard-frame` rig's
 *  parts, drawn by `shipyardPartContext`; the build sequence's
 *  printed hull, fittings and lit lamps are `structureStyleC.shipyardBuild.ts`. Symmetric in y, so the Pixi flip
 *  changes nothing. */
function shipyard(c: StyleCtx): void {
  const sw = SHIPYARD_SLIP_HALF_W, x0 = SHIPYARD_SLIP_X0, x1 = SHIPYARD_SLIP_X1;
  deck(c);
  grime(c, -440, -250, 880, 500, 18, 9);
  // Slipway: a sunken channel, keel blocks on its centre line.
  poly(c, chamferBox(x0, -sw, x1 - x0, 2 * sw, 10), SOOT, 'metal', -10, 4, { seams: 40, seamAngle: Math.PI / 2 });
  for (let x = x0 + 50; x < x1 - 40; x += 70) poly(c, chamferBox(x - 14, -10, 28, 20, 4), SLAB_DARK, 'metal', 2, 1.5);
  // Bay marks (loop 3R): a hazard stripe across the slip between bays and
  // each bay's number by the edge, so the slip reads as a row of build slots.
  for (const bx of SHIPYARD_BAY_MARK_XS) poly(c, strip([bx, -sw + 4], [bx, sw - 4], 8), HAZARD, 'hazard', 1, 0.6);
  for (let b = 0; b < SHIPYARD_BAY_COUNT; b++) stencil(c, String(b + 1), shipyardBayKeel(b).x - 60, sw - 60, 22);
  for (const s of [-1, 1]) {
    weld(c, [x0 + 10, s * (sw - 4)], [x1 - 10, s * (sw - 4)]);
    // Clamp ledge with a pivot boss at each station.
    poly(c, chamferBox(-340, s > 0 ? sw + 2 : -sw - 30, 680, 28, 4), SLAB_LIGHT, 'metal', 6, 2);
    for (const x of SHIPYARD_CLAMP_XS) poly(c, ngon(x, s * SHIPYARD_CLAMP_Y, 11, 8, Math.PI / 8), SLAB_DARK, 'metal', 8, 2);
    // Wall track: the bed each wall slides out along (seen as it parts).
    const t0 = SHIPYARD_WALL_Y - SHIPYARD_WALL_HALF_T - 4, t1 = SHIPYARD_WALL_Y + SHIPYARD_WALL_HALF_T + SHIPYARD_WALL_TRAVEL + 2;
    poly(c, chamferBox(-SHIPYARD_WALL_HALF_L - 6, s > 0 ? t0 : -t1, 2 * SHIPYARD_WALL_HALF_L + 12, t1 - t0, 6), SLAB_DARK, 'metal', 2, 2);
    for (const x of [-250, -80, 80, 250]) poly(c, strip([x, s * t0], [x, s * t1], 5), STEEL, 'metal', 3, 1);
    // Gantry rail on the long edge, with end stops and a walkway inboard.
    const ry = s * SHIPYARD_RAIL_Y, rx = SHIPYARD_GANTRY_TRAVEL + SHIPYARD_GANTRY_HALF_X + 8;
    poly(c, strip([-rx, ry], [rx, ry], 10), STEEL, 'metal', 5, 1.5);
    rivets(c, [-rx + 6, ry], [rx - 6, ry], 22, 2);
    for (const e of [-1, 1]) {
      poly(c, chamferBox(e * rx - 7, ry - 10, 14, 20, 3), HAZARD, 'hazard', 7, 1.5);
      lamp(c, e * (rx - 20), ry - s * 16, 3.5, LAMP_AMBER);
    }
    walkway(c, [-300, s * 246], [300, s * 246], 12);
  }
  // Stern headhouse: the control block the gantry parks over.
  const head = core(c, chamferBox(-455, -200, 100, 400, 20), SLAB, 24, Math.PI / 2);
  wornStripe(c, head, Math.PI / 2, -440, 10, 71);
  glow(c, chamferBox(-420, -60, 26, 120, 6), c.live ? 0x7fd4ff : 0x142430, 0.8);
  rivets(c, [-445, -180], [-445, 180], 16);
  // Bow mouth: hazard chevrons pointing out of the slip, lamps either side.
  for (let k = 0; k < 3; k++) poly(c, chevron(x1 - 70 + k * 24, 0, 18, 60, 6, 1), HAZARD, 'hazard', 1, 0.6);
  for (const s of [-1, 1]) lamp(c, x1 - 8, s * (sw + 14), 4, LAMP_WHITE);
  wornStripe(c, chamferBox(-340, -296, 680, 592, 8), 0, -sw - 50, 10, 72);
  stencil(c, '12', 300, -sw - 70, 28);
  if (c.livery) c.sigils.push({ x: -405, y: 120, r: 26 });
}

// ── shipyard-frame rig part art (in each part's own Pixi frame, y down) ──────

const _fill = { color: 0, alpha: 1 };
const _line = { color: 0x0a0c0e, width: 2, alpha: 1 };

function plate(g: GraphicsContext, x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
  g.rect(x, y, w, h);
  _fill.color = color; _fill.alpha = alpha; g.fill(_fill);
  g.stroke(_line);
}

function rivetRow(g: GraphicsContext, xa: number, ya: number, xb: number, yb: number, step: number): void {
  const n = Math.max(1, Math.floor(Math.hypot(xb - xa, yb - ya) / step));
  for (let i = 0; i <= n; i++) g.circle(xa + ((xb - xa) * i) / n, ya + ((yb - ya) * i) / n, 1.8);
  _fill.color = RIVET; _fill.alpha = 1; g.fill(_fill);
}

/** A side wall: a long gunmetal block, buttress ribs on its outer face, a
 *  hazard edge and work lamps on its inner (slip-side) face. `inner` is the
 *  inner face's Pixi y sign. */
function wallContext(inner: 1 | -1): GraphicsContext {
  const g = new GraphicsContext(), L = SHIPYARD_WALL_HALF_L, T = SHIPYARD_WALL_HALF_T;
  plate(g, -L, -T, 2 * L, 2 * T, SLAB);
  plate(g, -L + 10, -T + 8, 2 * L - 20, 2 * T - 16, SLAB_LIGHT);
  for (let x = -L + 40; x < L - 20; x += 60) plate(g, x - 6, inner > 0 ? -T - 6 : T, 12, 6, SLAB_DARK);
  for (let x = -L + 10; x < L - 10; x += 24) {
    g.poly([x, inner * T, x + 12, inner * T, x + 18, inner * (T - 6), x + 6, inner * (T - 6)], true);
    _fill.color = HAZARD; _fill.alpha = 0.9; g.fill(_fill);
  }
  rivetRow(g, -L + 16, -inner * (T - 14), L - 16, -inner * (T - 14), 18);
  for (const x of [-L + 50, 0, L - 50]) {
    g.circle(x, inner * (T - 10), 3.5);
    _fill.color = LAMP_AMBER; _fill.alpha = 1; g.fill(_fill);
  }
  return g;
}

/** A hull clamp: a hinged arm from its pivot (0, 0) along +x, a pin hub on
 *  the pivot, a padded gripper jaw on the tip. Symmetric about its axis. */
function clampContext(): GraphicsContext {
  const g = new GraphicsContext(), L = SHIPYARD_CLAMP_LEN, w = SHIPYARD_CLAMP_HALF_W;
  plate(g, 0, -w, L - 8, 2 * w, CRANE);
  plate(g, L - 10, -w - 4, 10, 2 * w + 8, SLAB_DARK);
  g.circle(0, 0, w + 3); _fill.color = SLAB_LIGHT; _fill.alpha = 1; g.fill(_fill); g.stroke(_line);
  g.circle(0, 0, 3); _fill.color = RIVET; g.fill(_fill);
  return g;
}

/** The gantry bridge: an open crane-yellow truss across the frame (two
 *  chord girders, X-braced, open between them, so the hull printing on the
 *  slip below shows through), on a wheeled bogie over each rail. */
function gantryContext(): GraphicsContext {
  const g = new GraphicsContext(), X = SHIPYARD_GANTRY_HALF_X, Y = SHIPYARD_RAIL_Y, c = X * 0.7, w = 7;
  for (const s of [-1, 1]) plate(g, s > 0 ? c - w : -c, -Y, w, 2 * Y, CRANE);
  for (let y = -Y; y < Y - 1; y += 40) {
    g.moveTo(-c + w, y).lineTo(c - w, y + 40).moveTo(c - w, y).lineTo(-c + w, y + 40);
  }
  g.stroke({ color: CRANE, width: 2.5 });
  for (const s of [-1, 1]) {
    plate(g, -X, s * Y - SHIPYARD_GANTRY_BOGIE, 2 * X, 2 * SHIPYARD_GANTRY_BOGIE, SLAB_DARK);
    for (const x of [-X + 7, X - 7]) { g.circle(x, s * Y, 5); _fill.color = SLAB_LIGHT; _fill.alpha = 1; g.fill(_fill); }
    g.circle(0, s * (Y - 22), 3.5); _fill.color = LAMP_AMBER; g.fill(_fill);
  }
  return g;
}

/** The hoist trolley on the gantry: an open frame on the two chords, the
 *  winch drum at one end and the hook ring over the middle, open beneath
 *  so the block it sets shows through. */
function hoistContext(): GraphicsContext {
  const g = new GraphicsContext(), h = SHIPYARD_HOIST_HALF, t = 6;
  plate(g, -h, -h, 2 * h, t, SLAB);
  plate(g, -h, h - t, 2 * h, t, SLAB);
  plate(g, -h, -h + t, t, 2 * h - 2 * t, SLAB);
  plate(g, h - t, -h + t, t, 2 * h - 2 * t, SLAB);
  plate(g, -h + t, -h + t, 2 * h - 2 * t, h * 0.35, SLAB_DARK);
  g.circle(0, 0, h * 0.3); g.stroke({ color: HAZARD, width: 2 });
  return g;
}

const partCtx = new Map<string, GraphicsContext>();

/** The shared art of `shipyard-frame` part `i` (built on first use; one per
 *  art kind), or null for an unknown part. */
export function shipyardPartContext(rig: Rig, i: number): GraphicsContext | null {
  const id = rig.partIds[i]!;
  const key = id.startsWith('clamp-') ? 'clamp' : id.startsWith('light-') ? 'light' : id;
  const hit = partCtx.get(key);
  if (hit !== undefined) return hit;
  // Pixi y is game -y: the port wall (game +y) has its inner face at Pixi +y.
  const ctx = key === 'clamp' ? clampContext()
    : key === 'light' ? shipyardLightContext(false)
      : key === 'keel' ? shipyardKeelContext()
      : key.startsWith('hull-') || key.startsWith('fit-') ? shipyardPrintContext(key)
      : key === 'wall-port' ? wallContext(1)
        : key === 'wall-stbd' ? wallContext(-1)
          : key === 'gantry' ? gantryContext()
            : key === 'gantry-hoist' ? hoistContext()
              : null;
  if (ctx !== null) partCtx.set(key, ctx);
  return ctx;
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  shipyard,
};

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {
  'shipyard-frame': { partArt: shipyardPartContext, partShow: shipyardPartShow, rowClip: shipyardRowClip },
};

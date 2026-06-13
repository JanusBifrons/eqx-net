/**
 * HAVOK — the first multi-component (composite) ship kind (composite-ships
 * Phase 1). Its geometry AND styling are ported VERBATIM from the Equinox repo
 * (github.com/JanusBifrons/Equinox — `js/ships/debug.js` `createComponents`
 * plus each component's `createPoints()` for the silhouette and `draw()` for the
 * detail pass): a red fighter built from two rear wings, two main wings, two
 * pads, and a cockpit body, with the iconic green cockpit dome.
 *
 * Equinox authors components in +x-forward / y-down screen space; eqx-net
 * catalogue shapes are Pixi-up (nose at -y). `equinoxPartPoints` performs the
 * per-instance mirror/scale, the `adjustCenter` centroid-centring, the offset,
 * and the final `(x,y)->(y,-x)` re-frame.
 *
 * STYLING: Equinox's base `Component.draw` fills each component's collision
 * silhouette with the PRIMARY colour; the component's own `draw()` then layers
 * SECONDARY detail (highlight strips, the wing "porthole" circles, the cockpit
 * tip-highlight + tail strips) on top. We reproduce that as: one primary-filled
 * ShipPart per silhouette + one secondary ShipPart per detail shape. Detail
 * shapes pass `centroidSource = <parent silhouette>` so they stay glued to the
 * component instead of centring on themselves. Per-part live collision is NOT
 * modelled — the gross `hull` (convex hull of all points) is the one collider.
 *
 * Stat block (physics / shield / energy / AI) is copied from FIGHTER — Havok is
 * a fighter-class chassis with a bespoke silhouette. It is `engineeringOnly` so
 * it stays out of the random ambient spawn pool for now while remaining
 * player-selectable.
 */

import {
  ShipKindSchema,
  LEGACY_FORWARD_MOUNT,
  LEGACY_PRIMARY_SLOT,
  type ShipKind,
  type ShipPart,
} from '../types.js';
import { equinoxPartPoints, convexHull } from './equinoxTransform.js';

// ---------------------------------------------------------------------------
// Equinox component createPoints (verbatim from js/components/**). These are the
// collision SILHOUETTES (the primary-filled body of each component).
// +x = forward, y-down. (0,0) is the component's attach point.
// ---------------------------------------------------------------------------
const WING: ReadonlyArray<readonly [number, number]> = [
  [-5, -32],
  [0, -30],
  [20, -15],
  [30, -5],
  [30, 0],
  [0, 0],
];
const REARWING: ReadonlyArray<readonly [number, number]> = [
  [-12, 0],
  [-19, -26],
  [-18, -33],
  [0, -10],
];
const COCKPIT: ReadonlyArray<readonly [number, number]> = [
  [-1, 1],
  [-3, 2],
  [-5, 3],
  [-7, 4],
  [-15, 4],
  [-18, 6],
  [-25, 8],
  [-25, -8],
  [-18, -6],
  [-15, -4],
  [-7, -4],
  [-5, -3],
  [-3, -2],
  [-1, -1],
  [0, 0],
];
const PAD: ReadonlyArray<readonly [number, number]> = [
  [2, -5],
  [10, -7],
  [20, -12],
  [25, -10],
  [27, -5],
  [20, 0],
  [0, 0],
];

// ---------------------------------------------------------------------------
// Colours — a red Equinox fighter (team-2 palette: red PRIMARY body, white
// SECONDARY highlights). Black strokes, like Equinox. Green cockpit dome.
// ---------------------------------------------------------------------------
const PRIMARY = 0xcc3333;
const SECONDARY = 0xf2f2f2;
const STROKE = 0x000000;
const DOME_FILL = 0x33dd55;

// ---------------------------------------------------------------------------
// Detail shapes, ported VERBATIM from each component's draw() — the styling
// pass the silhouette alone misses. Raw Equinox local space.
// ---------------------------------------------------------------------------
interface Detail {
  role: string;
  color: number;
  /** Polygon detail (highlight strip / tip / tail). */
  poly?: ReadonlyArray<readonly [number, number]>;
  /** Circle detail (cx, cy, r) — e.g. the wing porthole. */
  circle?: readonly [number, number, number];
  /** Ellipse detail (cx, cy, rx, ry) — the skewed cockpit dome. */
  ellipse?: readonly [number, number, number, number];
}

// Wing.draw(): secondary highlight strip down the leading edge + two concentric
// secondary "porthole" circles at (5,-6) (r5 then r3).
const WING_DETAILS: Detail[] = [
  {
    role: 'strip',
    color: SECONDARY,
    poly: [
      [30, -3],
      [20, -13],
      [0, -28],
      [-5, -30],
      [-5, -32],
      [0, -30],
      [20, -15],
      [30, -5],
    ],
  },
  { role: 'ring', color: SECONDARY, circle: [5, -6, 5] },
  { role: 'ring-inner', color: SECONDARY, circle: [5, -6, 3] },
];

// RearWing.draw(): two secondary highlight lines along the spar.
const REARWING_DETAILS: Detail[] = [
  {
    role: 'hl',
    color: SECONDARY,
    poly: [
      [-8, -3],
      [-16, -26],
      [-15, -29],
      [-18, -33],
      [-19, -26],
      [-12, 0],
    ],
  },
  {
    role: 'hl2',
    color: SECONDARY,
    poly: [
      [-1, -9],
      [-7, -16],
      [-6, -18],
      [0, -10],
    ],
  },
];

// Pad.draw(): a single secondary highlight wedge.
const PAD_DETAILS: Detail[] = [
  {
    role: 'hl',
    color: SECONDARY,
    poly: [
      [10, 0],
      [23, -11],
      [20, -12],
      [10, -7],
      [2, -5],
      [0, 0],
    ],
  },
];

// Cockpit.draw(): nose tip highlight, a thin tip strip, the green dome
// (scale(1.75,1) of circle(-14,0,5) -> centre (-24.5,0) rx 8.75 ry 5), and the
// secondary tail strips.
const COCKPIT_DETAILS: Detail[] = [
  {
    role: 'tip',
    color: SECONDARY,
    poly: [
      [0, 0],
      [-1, -1],
      [-3, -2],
      [-5, -3],
      [-7, -4],
      [-9, -4],
      [-9, 4],
      [-7, 4],
      [-5, 3],
      [-3, 2],
      [-1, 1],
    ],
  },
  {
    role: 'tip-strip',
    color: SECONDARY,
    poly: [
      [-11, -4],
      [-11, 4],
      [-12, 4],
      [-12, -4],
    ],
  },
  { role: 'dome', color: DOME_FILL, ellipse: [-24.5, 0, 8.75, 5] },
  {
    role: 'tail',
    color: SECONDARY,
    poly: [
      [-25, -5],
      [-30, 0],
      [-25, 5],
      [-27, 5],
      [-35, 0],
      [-27, -5],
    ],
  },
];

/** `segments` points of an ellipse (cx, cy, rx, ry) in raw Equinox space. A
 *  circle is `rx === ry`. */
function ellipsePoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  segments: number,
): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

/** Build one Equinox component instance into ShipParts: the primary-filled
 *  silhouette + one secondary part per detail shape. The mirror is BAKED into
 *  the points by `equinoxPartPoints`, so ShipParts carry no mirror flag; detail
 *  shapes pass `centroidSource = silhouette` so they centre with the body. */
function componentInstance(
  silhouette: ReadonlyArray<readonly [number, number]>,
  details: Detail[],
  offset: readonly [number, number],
  scale: number,
  mirror: boolean,
  roleBase: string,
): ShipPart[] {
  const parts: ShipPart[] = [
    {
      points: equinoxPartPoints(silhouette, offset, scale, mirror),
      color: PRIMARY,
      stroke: STROKE,
      strokeWidth: 1,
      offsetX: 0,
      offsetY: 0,
      role: roleBase,
      canScrap: true,
    },
  ];
  for (const d of details) {
    const raw = d.poly
      ? d.poly
      : d.circle
        ? ellipsePoints(d.circle[0], d.circle[1], d.circle[2], d.circle[2], 10)
        : ellipsePoints(
            d.ellipse![0],
            d.ellipse![1],
            d.ellipse![2],
            d.ellipse![3],
            8,
          );
    parts.push({
      points: equinoxPartPoints(raw, offset, scale, mirror, silhouette),
      color: d.color,
      stroke: STROKE,
      strokeWidth: 1,
      offsetX: 0,
      offsetY: 0,
      role: `${roleBase}-${d.role}`,
      canScrap: false,
    });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Assembly — mirrors debug.js createComponents (component, offset, scale,
// mirror). Order is back-to-front so the cockpit + dome draw LAST (on top).
//   RearWing (-30,-12) 1 false ; RearWing (-30,12) 1 true
//   Wing     (-10,-20) 1 false ; Wing     (-10,20) 1 true
//   Pad      (0,-8)  1.5 false ; Pad      (0,8)  1.5 true
//   Cockpit  (40,0)  1.5 false  (+ tip / strip / green dome / tail details)
// ---------------------------------------------------------------------------
const PARTS: ShipPart[] = [
  ...componentInstance(REARWING, REARWING_DETAILS, [-30, -12], 1, false, 'rear-wing-l'),
  ...componentInstance(REARWING, REARWING_DETAILS, [-30, 12], 1, true, 'rear-wing-r'),
  ...componentInstance(WING, WING_DETAILS, [-10, -20], 1, false, 'wing-l'),
  ...componentInstance(WING, WING_DETAILS, [-10, 20], 1, true, 'wing-r'),
  ...componentInstance(PAD, PAD_DETAILS, [0, -8], 1.5, false, 'pad-l'),
  ...componentInstance(PAD, PAD_DETAILS, [0, 8], 1.5, true, 'pad-r'),
  ...componentInstance(COCKPIT, COCKPIT_DETAILS, [40, 0], 1.5, false, 'cockpit'),
];

// ---------------------------------------------------------------------------
// Derive the gross collision hull (convex hull of every part point) and the
// overall draw scale so the bounding radius is ~20 u.
// ---------------------------------------------------------------------------
const ALL_POINTS: [number, number][] = PARTS.flatMap((p) =>
  p.points.map(([x, y]) => [x, y] as [number, number]),
);
const HULL = convexHull(ALL_POINTS);

/** Max point magnitude over all parts (pre-shape-scale). The bounding radius. */
const MAX_MAG = Math.sqrt(
  ALL_POINTS.reduce((m, [x, y]) => Math.max(m, x * x + y * y), 0),
);

/** Overall shape scale so the post-scale bounding radius is ~20 u. */
const HAVOK_SCALE = Math.round((20 / MAX_MAG) * 100) / 100;
/** Catalogue collider radius = scaled bounding circle. */
const HAVOK_RADIUS = Math.round(MAX_MAG * HAVOK_SCALE);

export const HAVOK: ShipKind = ShipKindSchema.parse({
  id: 'havok',
  displayName: 'Havok',
  description:
    'Multi-component red fighter ported from Equinox. Iconic green cockpit dome.',
  // -- FIGHTER stat block (verbatim copy of the physics/shield/energy/ai
  //    fields) — Havok is a fighter-class chassis with a bespoke silhouette.
  thrustImpulse: 2.0,
  reverseFactor: 0.5,
  boostMultiplier: 2.0,
  maxAngvel: 2.0,
  maxSpeed: 850,
  linearDamping: 0.3,
  angularDamping: 0,
  lateralGrip: 0.025,
  radius: HAVOK_RADIUS,
  maxHealth: 150,
  shieldMax: 150,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 150 / 120,
  energyMax: 150,
  energyRegenRate: 0.25,
  ai: { thrust: 0.9, turnKp: 6.0, maxTorque: 3.0 },
  // Keep out of the random ambient spawn pool for now; still player-selectable.
  engineeringOnly: true,
  shape: {
    kind: 'composite',
    scale: HAVOK_SCALE,
    hull: HULL,
    parts: PARTS,
  },
  mounts: [LEGACY_FORWARD_MOUNT],
  slots: [LEGACY_PRIMARY_SLOT],
});

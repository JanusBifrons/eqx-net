/**
 * Mining-barge hull LOOK OPTIONS (plan partitioned-chasing-lark, PR 14). The
 * owner's brief: a container ship. Maximise cargo volume, about 1.3× a
 * battleship's length, broad and boxy, a container-stack deck, no barbettes
 * for guns, lined both sides with mining lasers and tractors of varying sizes
 * (to strip-mine a field), and gigantic engines on the stern.
 *
 * Three variants for the owner to pick from, built with the warship
 * generator's helpers (`warshipDesign.ts`: rect, circle, convexHull,
 * `solveCapitalPhysics`) into an ordinary capital catalogue record:
 *  - A  classic container ship: blunt bow, bridge aft, one long container deck;
 *  - B  twin-hull barge: two pontoons round a central hold of containers, the
 *       mouth between their bows lined with tractors, a throat laser and an
 *       intake slot;
 *  - C  blocky ore carrier: a forward mining "jaw" of big lasers, hatch covers.
 *
 * Fix pass (hostile review of the first takes):
 *  - Engines: a stern engine module 1.4× the hull beam that protrudes past the
 *    stern — engine room, radiator fins, piping, service gantries and one
 *    housing per nozzle — with 3–4 round bell nozzles about a quarter beam
 *    across (`thrusters.bell`) and a full-thrust plume 30 % of the hull length
 *    (`thrusters.plume`), both read by the forge and the engine FX.
 *  - Mounts: three size classes. A few big mining lasers (round emitter with a
 *    lens barrel, `turretLayout`) at the bow corners angled forward; rows of
 *    tractor dishes down the sides (look A: AA to XL, the size ladder).
 *  - Paint: the warships' cool steel, so the barge reads as lit by the same
 *    sun; fitted parts (cargo, deckhouse, stern gear) use roles the forge
 *    paints as their own (`OWN_PAINT_ROLES`), so no hull metal band crosses
 *    them. A dark hold base under the cargo is the shadow between stacks.
 *  - Deckhouse: tiers in hull steel with window strips, bridge wings, a mast.
 *
 * Tractor mounts (ids `tractor-*`) carry the `tractor` weapon, lasers the
 * `mining_laser`. Ships are never faction-bound: no allegiance here, ever.
 *
 * The owner picked look A (2026-11-15): it is the catalogue kind `barge`
 * (`BARGE_KIND_ID`, `capitals/index.ts`), pilotable, never in a random
 * spawn pool. All three looks stay viewable as kind `barge-look` behind the
 * dev flag `?bargeLook=` / `EQX_BARGE_LOOK` (`bargeLookConfig.ts`). Coordinates as in
 * `warshipDesign.ts` (Pixi-up points, mount `localY` positive forward).
 * Pure: imports only shared data.
 */
import { capitalTargets, solveCapitalPhysics, CAPITAL_MAPPINGS, type CapitalMountSize } from '../../shipScale/capitalReference.js';
import { CAPITAL_TURRETS } from '../../shipScale/capitalTurrets.js';
import type { MountSize } from '../../shipScale/tuning.js';
import type { CapitalMap } from './capitalConfig.js';
import { circle, convexHull, hullHalfWidth, rect, type Pt } from './warshipDesign.js';

import type { BargeLook } from './bargeLookConfig.js';
export type { BargeLook };
export const BARGE_LOOKS: readonly BargeLook[] = ['A', 'B', 'C'];
/** The look kind's id (the R&D flag's kind). */
export const BARGE_LOOK_KIND_ID = 'barge-look';
/** The real mining barge's kind id (look `BARGE_PICK`). */
export const BARGE_KIND_ID = 'barge';
/** The owner's pick (2026-11-15): "just use A". */
export const BARGE_PICK: BargeLook = 'A';

/** Mount width in world units per size class at 1× (a battleship's 16"
 *  house is ~320): mining lasers and tractor dishes alike.
 *  The catalogue scales it with the hull (`defineCapitalShipKind`); reach,
 *  beam radius and tractor power come from the mount size
 *  (`MOUNT_SIZE_TUNING`, #18). */
const HOUSE: Readonly<Record<MountSize, number>> = { AA: 70, S: 100, M: 150, L: 230, XL: 320 };
/** Traverse (rad/s): mining turrets slew faster than naval guns. */
const SLEW: Readonly<Record<MountSize, number>> = { AA: 0.7, S: 0.5, M: 0.35, L: 0.25, XL: 0.18 };
/** The weapon a `tractor-*` mount carries. */
/** Side-mount cone, each way about the side-facing rest bearing (owner
 *  2026-11-18: a cone of ±45°, not the whole flank). Every mount takes it
 *  unless it passes its own arc. */
export const SIDE_MOUNT_ARC = Math.PI / 4;
export const TRACTOR_WEAPON = 'tractor';
/** Cargo capacity (weight units) per u² of plan cargo footprint: a hold
 *  several times a battleship's (look A ≈ 105,000). */
const HOLD_PER_AREA = 0.04;
/** The stern engine module's width × the hull beam. */
export const ENGINE_WIDTH = 1.4;
/** Full-thrust plume length × the hull length. */
export const PLUME = 0.3;
/** Hull stern, as a fraction of the total length (the engine module is aft of it). */
const T_HULL = 0.935;

/** The warships' steel (style A: hull 0x56677a, deck 0x6b7887); the
 *  deckhouse sits at deck brightness, not the warships' paler upperworks. */
const COLORS = {
  hull: 0x56677a, deck: 0x63707e, holdBase: 0x22262b, tier: 0x6b7887, tier2: 0x74808d, window: 0x141c25,
  module: 0x48515a, housing: 0x59626b, radiator: 0x343b42, radiator2: 0x5b646d, pipe: 0x7c858e, gantry: 0x6f7881,
  mast: 0x8a939c, plate: 0x4f5862, intake: 0x101316, coaming: 0x2b3036,
};
/** Container paints (weathered, a touch muted): rust, blue, teal, ochre, grey, maroon, green. */
const CONTAINERS = [0x86493a, 0x355878, 0x3e6c62, 0x977a3f, 0x6c737b, 0x5e3d4e, 0x50683d];
/** Ore-carrier hatch covers, alternating (C). */
const HATCHES = [0x7a4b35, 0x5d6c3e];

const shade = (hex: number, f: number): number => {
  const c = (s: number): number => Math.max(0, Math.min(255, Math.round(((hex >> s) & 255) * f)));
  return (c(16) << 16) | (c(8) << 8) | c(0);
};

interface VariantSpec {
  label: string;
  length: number;
  beam: number;
  thrusters: { count: number; size: number; bell: true; plume: number };
}
const variant = (label: string, beam: number, count: number, nozzleBeams: number): VariantSpec => ({
  label, length: 7480, beam, thrusters: { count, size: Math.round(beam * nozzleBeams), bell: true, plume: PLUME },
});
export const BARGE_VARIANTS: Readonly<Record<BargeLook, VariantSpec>> = {
  A: variant('container ship', 1400, 4, 0.25),
  B: variant('twin-hull barge', 1640, 4, 0.26),
  C: variant('ore carrier with mining jaw', 1360, 3, 0.3),
};

/** Half-breadth (× beam) at t = 0, 0.05 … 1 for the boxy container hull (A). */
const PLAN_BOX = [0.3, 0.62, 0.8, 0.9, 0.96, 0.99, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.99, 0.98, 0.96, 0.94];

export interface BargeDesign {
  record: Record<string, unknown>;
  length: number;
  beam: number;
  /** Mount counts per size, lasers and tractors separately. */
  lasers: Record<MountSize, number>;
  tractors: Record<MountSize, number>;
  /** Plan area of the cargo footprint (container stacks, hatch covers), u². */
  holdArea: number;
  /** Stern engine module width (u). */
  engineWidth: number;
}

const area = (pts: readonly Pt[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!, [x1, y1] = pts[(i + 1) % pts.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
};

/** Pattern letter → mount: upper case a mining laser, lower case a tractor
 *  dish; `a`/`A` is the AA size, `x`/`X` the XL size, the rest their own
 *  size letter. */
const patternMount = (ch: string): { kind: 'laser' | 'tractor'; size: MountSize } => {
  const up = ch.toUpperCase();
  return { kind: ch === up ? 'laser' : 'tractor', size: up === 'A' ? 'AA' : up === 'X' ? 'XL' : (up as CapitalMountSize) };
};

/** `kindId`: `BARGE_LOOK_KIND_ID` (default) builds the R&D look kind
 *  (npcOnly); `BARGE_KIND_ID` the real, pilotable mining barge. */
export function bargeDesign(look: BargeLook, map: CapitalMap = 'C', kindId: string = BARGE_LOOK_KIND_ID): BargeDesign {
  const v = BARGE_VARIANTS[look];
  const L = v.length, B = v.beam;
  /** Total-length station (0 bow … 1 engine module's aft face). */
  const yAt = (t: number): number => -L / 2 + t * L;
  /** Hull station (0 bow … 1 hull stern, forward of the engine module). */
  const hy = (t: number): number => yAt(t * T_HULL);
  const Lh = L * T_HULL;
  // The turret geometry is scaled by the collider's widest extent, which is
  // the engine module (`muzzle.ts` hullBeam), so mounts are sized against it.
  const Bc = B * ENGINE_WIDTH;
  const parts: Array<Record<string, unknown>> = [];
  const part = (points: Pt[], color: number, role: string): void => {
    parts.push({ points, color, offsetX: 0, offsetY: 0, role });
  };
  const mounts: Array<Record<string, unknown>> = [];
  const lasers = { AA: 0, S: 0, M: 0, L: 0, XL: 0 }, tractors = { AA: 0, S: 0, M: 0, L: 0, XL: 0 };
  let holdArea = 0;
  const hold = (points: Pt[], color: number): void => { holdArea += area(points); part(points, color, 'cargo'); };

  /** A mining laser or a tractor dish on a deck plate. `facing`: rest
   *  bearing in the mount frame (0 forward, −π/2 starboard, +π/2 port);
   *  `arc`: the swing each way about it (default `SIDE_MOUNT_ARC`). */
  const mount = (kind: 'laser' | 'tractor', size: MountSize, x: number, y: number, facing: number, arc = SIDE_MOUNT_ARC): void => {
    const scale = HOUSE[size] / (CAPITAL_TURRETS[size].houseW * Bc);
    part(circle(x, y, HOUSE[size] * 0.62, 16), COLORS.plate, 'housing');
    const n = (kind === 'laser' ? lasers : tractors)[size]++;
    mounts.push({
      id: `${kind}-${size.toLowerCase()}${n + 1}${x > 0.5 ? 's' : x < -0.5 ? 'p' : 'c'}`, localX: x, localY: -y,
      baseAngle: facing, arcMin: -arc, arcMax: arc, rotationSpeed: SLEW[size],
      weaponId: kind === 'laser' ? 'mining_laser' : TRACTOR_WEAPON, size, barrels: 1, turretScale: scale,
    });
  };
  /** A row down both sides, inboard of the edge (pattern: `patternMount`). */
  const sideRows = (pattern: string, t0: number, t1: number, edge: (t: number) => number): void => {
    const n = pattern.length;
    for (let i = 0; i < n; i++) {
      const { kind, size } = patternMount(pattern[i]!);
      const t = n === 1 ? t0 : t0 + ((t1 - t0) * i) / (n - 1);
      for (const side of [1, -1] as const) {
        mount(kind, size, side * (edge(t) - HOUSE[size] * 0.62 - B * 0.02), hy(t), side > 0 ? -Math.PI / 2 : Math.PI / 2);
      }
    }
  };
  /** Container stacks on a dark hold base (the base is the shadow between
   *  rows): `bays` rows along hull stations [t0, t1], `cols` across ±w/2;
   *  every other bay a shade darker so the rows read at play zoom. */
  const containerDeck = (t0: number, t1: number, w: number, bays: number, cols: number, seed = 0): void => {
    part(rect(0, (hy(t0) + hy(t1)) / 2, w * 1.04, hy(t1) - hy(t0) + B * 0.03, 0.03), COLORS.holdBase, 'hold');
    const bayL = (hy(t1) - hy(t0)) / bays, colW = w / cols;
    for (let b = 0; b < bays; b++) {
      for (let c = 0; c < cols; c++) {
        const paint = CONTAINERS[(b * 7 + c * 3 + seed + ((b * c) % 5)) % CONTAINERS.length]!;
        hold(rect(-w / 2 + colW * (c + 0.5), hy(t0) + bayL * (b + 0.5), colW * 0.88, bayL * 0.8, 0.04), shade(paint, b % 2 ? 0.95 : 1.2));
      }
    }
  };
  /** The aft deckhouse: tiers in hull steel, a window strip on each tier's
   *  front, bridge wings out to the sides on the top tier, and a mast. */
  const deckhouse = (t0: number, t1: number, tiers: readonly number[], wingHalf: number): void => {
    const y0 = hy(t0), y1 = hy(t1), len = y1 - y0;
    const fronts: Array<[number, number]> = [];
    tiers.forEach((w, i) => {
      const inset = len * 0.12 * i;
      part(rect(0, (y0 + y1) / 2 + inset * 0.5, B * w, len - inset, 0.08), i % 2 ? COLORS.tier2 : COLORS.tier, 'deckhouse');
      fronts.push([y0 + inset, B * w]);
    });
    const [topFront, topW] = fronts[fronts.length - 1]!;
    part(rect(0, topFront + len * 0.08, wingHalf * 2, len * 0.11, 0.1), COLORS.tier2, 'bridge-wing');
    for (const [fy, w] of fronts) part(rect(0, fy + len * 0.03, w * 0.86, len * 0.035, 0.2), COLORS.window, 'window');
    part(rect(0, topFront + len * 0.08, wingHalf * 2 * 0.94, len * 0.03, 0.2), COLORS.window, 'window');
    const my = topFront + len * 0.32;
    part(rect(0, my, topW * 0.75, len * 0.025, 0.2), COLORS.mast, 'mast');
    part(circle(0, my, B * 0.025, 12), COLORS.mast, 'mast');
    for (const sx of [-1, 1]) part(circle(sx * topW * 0.22, my + len * 0.12, B * 0.03, 12), COLORS.tier2, 'mast');
  };
  /** The stern engine module: an engine room 1.4 beams wide reaching past
   *  the hull stern, radiator fins outboard, piping from the hull, two service
   *  gantries, and a housing per nozzle lined up with the forge's nozzle
   *  spread (`fields.ts`: span = (count − 1) × r × 2.4). */
  const engineModule = (): void => {
    const nr = v.thrusters.size / 2, n = v.thrusters.count, W = Bc;
    const a = yAt(0.895), b = yAt(0.975);
    for (const sx of [-1, 1]) part(rect(sx * B * 0.25, (hy(0.88) + a) / 2 + L * 0.01, B * 0.05, a - hy(0.88) + L * 0.03, 0.3), COLORS.pipe, 'pipe');
    part(rect(0, (a + b) / 2, W, b - a, 0.1), COLORS.module, 'housing');
    for (let k = 0; k < 8; k++) {
      const y = a + ((b - a) * (k + 0.5)) / 8;
      for (const sx of [-1, 1]) part(rect(sx * W * 0.4, y, W * 0.18, (b - a) * 0.075, 0.1), k % 2 ? COLORS.radiator2 : COLORS.radiator, 'radiator');
    }
    for (const sx of [-1, 1]) part(rect(sx * W * 0.2, (a + b) / 2, W * 0.035, (b - a) * 0.92, 0.3), COLORS.pipe, 'pipe');
    for (const gy of [a + (b - a) * 0.15, a + (b - a) * 0.62]) part(rect(0, gy, W * 0.62, L * 0.006, 0.2), COLORS.gantry, 'gantry');
    const span = (n - 1) * nr * 2.4;
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
      part(rect(x, yAt(1) - nr * 1.35, nr * 2.5, nr * 2.7, 0.3), COLORS.housing, 'housing');
    }
  };

  if (look === 'A') {
    const s = { plan: PLAN_BOX };
    const N = 20;
    const right: Pt[] = [];
    for (let i = 0; i <= N; i++) right.push([hullHalfWidth(s, i / N) * B, hy(i / N)]);
    part([[0, hy(0) - L * 0.004], ...right, ...right.slice().reverse().map(([x, y]): Pt => [-x, y])], COLORS.hull, 'hull');
    part(right.slice(1).map(([x, y]): Pt => [x * 0.92, y]).concat(right.slice(1).reverse().map(([x, y]): Pt => [-x * 0.92, y])), COLORS.deck, 'weather-deck');
    engineModule();
    containerDeck(0.17, 0.75, B * 0.66, 13, 6);
    deckhouse(0.77, 0.85, [0.84, 0.6, 0.36], B * 0.47);
    const edge = (t: number): number => hullHalfWidth(s, t) * B;
    // The size ladder down each side (owner: "barge gets L/XL tractors"): an
    // XL tractor dish at the forward end, nearest the bow XL lasers, takes the
    // big pieces they cut; an L dish at the aft end, nearest the L lasers; an
    // M dish forward and one amidships; one S dish; AA dishes and lasers between.
    sideRows('xamMAmAMsal', 0.18, 0.74, edge);
    // Big lasers: the bow corners angled forward, the aft corners outboard-forward.
    mount('laser', 'XL', B * 0.25, hy(0.1), -0.3, 1.9);
    mount('laser', 'XL', -B * 0.25, hy(0.1), 0.3, 1.9);
    mount('laser', 'L', B * 0.36, hy(0.9), -0.9, 1.6);
    mount('laser', 'L', -B * 0.36, hy(0.9), 0.9, 1.6);
  } else if (look === 'B') {
    // Two pontoons with blunt, full-width bows (structure, not spikes) round a
    // mouth between them; a flat transom across both meets the engine module.
    const right: Pt[] = [[0, hy(0.15)], [B * 0.21, hy(0.15)], [B * 0.21, hy(0.03)], [B * 0.25, hy(0)], [B * 0.47, hy(0)], [B * 0.5, hy(0.035)], [B * 0.5, hy(1)]];
    part([...right, ...right.slice(1).reverse().map(([x, y]): Pt => [-x, y])], COLORS.hull, 'hull');
    for (const side of [1, -1]) part(rect(side * B * 0.355, hy(0.52), B * 0.25, Lh * 0.92, 0.06), COLORS.deck, 'weather-deck');
    // The mouth: an intake slot across its back wall, the throat laser behind it.
    part(rect(0, hy(0.158), B * 0.36, L * 0.012, 0.15), COLORS.intake, 'intake');
    engineModule();
    containerDeck(0.22, 0.83, B * 0.38, 14, 4, 2);
    deckhouse(0.855, 0.91, [0.9, 0.55, 0.3], B * 0.49);
    sideRows('sMsssMsssMs', 0.2, 0.82, () => B * 0.5);
    mount('laser', 'XL', 0, hy(0.19), 0, 1.4);
    for (const side of [1, -1] as const) {
      // Prong tips: XL lasers angled forward; the inner faces: tractor dishes
      // facing into the mouth; the hold rim: tractors facing over the cargo.
      mount('laser', 'XL', side * B * 0.36, hy(0.06), -side * 0.25, 1.9);
      for (const t of [0.05, 0.11]) mount('tractor', 'S', side * (B * 0.21 + HOUSE.S * 0.62 + B * 0.015), hy(t), side * Math.PI / 2, 1.4);
      for (const t of [0.32, 0.52, 0.72]) mount('tractor', 'M', side * B * 0.275, hy(t), side * Math.PI / 2, 1.6);
    }
  } else {
    // The jaw: two prongs ahead of the hold, a mouth between them.
    const right: Pt[] = [[0, hy(0.2)], [B * 0.2, hy(0.195)], [B * 0.22, hy(0.03)], [B * 0.3, hy(0)], [B * 0.42, hy(0.015)], [B * 0.49, hy(0.09)], [B * 0.5, hy(0.15)], [B * 0.5, hy(0.97)], [B * 0.47, hy(1)]];
    part([...right, ...right.slice(1).reverse().map(([x, y]): Pt => [-x, y])], COLORS.hull, 'hull');
    part(rect(0, hy(0.6), B * 0.9, Lh * 0.76, 0.04), COLORS.deck, 'weather-deck');
    engineModule();
    // Ore-carrier hatches: a dark coaming (its shadow) and a ridged cover, the
    // covers alternating paint so each reads at play zoom.
    const hatches = 8, h0 = 0.25, h1 = 0.78, hl = (h1 - h0) / hatches;
    for (let i = 0; i < hatches; i++) {
      const cy = hy(h0 + hl * (i + 0.5));
      part(rect(0, cy, B * 0.72, Lh * hl * 0.92, 0.05), COLORS.coaming, 'coaming');
      hold(rect(0, cy, B * 0.66, Lh * hl * 0.76, 0.08), HATCHES[i % 2]!);
      part(rect(0, cy, B * 0.04, Lh * hl * 0.76, 0.2), shade(HATCHES[i % 2]!, 0.7), 'coaming');
    }
    deckhouse(0.8, 0.87, [0.66, 0.46, 0.26], B * 0.47);
    sideRows('sMssLssMs', 0.27, 0.77, () => B * 0.5);
    // The jaw: XL cutters on the prong tips, L cutters lining the mouth
    // (angled in), and an XL tractor dish on the mouth's back wall.
    for (const side of [1, -1] as const) {
      mount('laser', 'XL', side * B * 0.33, hy(0.055), -side * 0.2, 1.9);
      mount('laser', 'L', side * B * 0.3, hy(0.13), side * Math.PI / 4, 1.6);
    }
    mount('tractor', 'M', 0, hy(0.235), 0, 1.4);
  }

  // Physics: the battleship's, scaled to the barge's length and beam, heavier,
  // slower and less nimble (a loaded freighter).
  const bs = capitalTargets('battleship', CAPITAL_MAPPINGS[map]);
  const mass = bs.mass * (L / bs.length) * (B / bs.beam) * 1.2;
  const p = solveCapitalPhysics({
    ...bs, length: L, beam: B, mass, topSpeed: bs.topSpeed * 0.7,
    accelSeconds: bs.accelSeconds * 1.6, turnDiameter: bs.turnDiameter * 1.6, turnResponseSeconds: bs.turnResponseSeconds * 1.6,
  });
  const hull = convexHull(parts.flatMap((q) => q['points'] as Pt[]));
  // The engine module's corners reach past the half-length circle.
  const radius = Math.max(p.radius, ...hull.map(([x, y]) => Math.hypot(x, y)));
  const health = Math.round(900 * Math.pow(mass / CAPITAL_MAPPINGS[map].destroyerMass, 0.85));
  const ids = mounts.map((m) => m['id'] as string);
  const record = {
    id: kindId,
    displayName: 'Mining Barge',
    description: kindId === BARGE_KIND_ID
      ? 'Mining barge: a container hold, mining lasers and tractors down both sides, oversized stern engines.'
      : `Mining barge look option ${look} (${v.label}): container hold, mining lasers and tractors down both sides, oversized stern engines.`,
    // The real barge is pilotable; the R&D look kind stays NPC-only.
    npcOnly: kindId !== BARGE_KIND_ID,
    randomSpawn: false,
    sizeClass: 'capital',
    thrustImpulse: p.thrustImpulse,
    reverseFactor: 0.3,
    boostMultiplier: 1,
    maxAngvel: p.maxAngvel,
    turnTorque: p.turnTorque,
    maxSpeed: p.maxSpeed,
    linearDamping: p.linearDamping,
    angularDamping: p.angularDamping,
    lateralGrip: 0.05,
    radius,
    mass: p.mass,
    thrusters: v.thrusters,
    maxHealth: health,
    // Capitals have no shield (owner: "capital ships never have shields"),
    // the barge included: every hit lands on the hull.
    shieldMax: 0,
    shieldRegenDelayTicks: 600,
    shieldRegenRate: 0,
    energyMax: 600,
    energyRegenRate: 2,
    cargoCapacity: Math.round(holdArea * HOLD_PER_AREA),
    ai: { thrust: p.thrustImpulse },
    aiRole: 'civilian',
    shape: { kind: 'composite', scale: 1, hull, parts },
    mounts,
    slots: [
      { id: 'laser', displayName: 'Mining lasers', mountIds: ids.filter((i) => i.startsWith('laser-')), colour: 0 },
      { id: 'tractor', displayName: 'Tractors', mountIds: ids.filter((i) => i.startsWith('tractor-')), colour: 1 },
    ],
  };
  return { record, length: L, beam: B, lasers, tractors, holdArea, engineWidth: Bc };
}

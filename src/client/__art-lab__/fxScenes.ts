/**
 * FX lab — deterministic scenes for weapons, shields, explosions and the
 * environment (plan iridescent-seeking-rainbow v2). A frame is a pure function
 * of `t`, so captures are frame-exact and every arm sees the same scene.
 * Pixi space (y down); a ship's nose is local -y.
 */
import type { Cam, Pose, ShipE, StructE } from './scenes.js';

export type FxShotKind = 'beam' | 'bolt' | 'cannon' | 'missile';

export interface FxShot {
  kind: FxShotKind;
  from: number;
  to: number;
  t0: number;
  t1: number;
  color: number;
  /** Seconds between shots (not beams). */
  period?: number;
  /** World units per second (not beams). */
  speed?: number;
  /** Aim at shield fence `wall` (index into `fences`), at `wallT` (0..1
   *  along it) instead of at ship `to`. */
  wall?: number;
  wallT?: number;
}

/** A shield fence between two emitters. `up`: the intervals it is raised.
 *  A gate's gaps are it opening; anything else's are a power loss. */
export interface FxFence { ax: number; ay: number; bx: number; by: number; up: Array<[number, number]>; gate?: boolean }

export type BoomSize = 'small' | 'ship' | 'large';
export interface FxBoom { x: number; y: number; t0: number; size: BoomSize; /** Ship index that dies here. */ ship?: number }

export interface FxShield { ship: number; radius: number; breakAt?: number; color: number }

export interface FxRock { x: number; y: number; r: number; resource?: 'ice' | 'crystal'; rot: number; spin: number; id: number }
export interface FxWisp { x: number; y: number; size: number; tint: number; rot: number }
export interface FxWreck { kind: string; x: number; y: number; scale: number; spread: number }

export interface FxScene {
  ships: ShipE[];
  structs: StructE[];
  shots: FxShot[];
  booms: FxBoom[];
  shields: FxShield[];
  rocks: FxRock[];
  wisps: FxWisp[];
  wreck?: FxWreck;
  fences?: FxFence[];
  /** Round 2: the sector key the sky is seeded from, and nebula volumes to
   *  fly through (world space). */
  sky?: string;
  regions?: Array<{ x: number; y: number; r: number; variant: 'emission' | 'reflection' | 'dark'; seed: number }>;
  /** Draw a distant planet in the backdrop. */
  planet?: boolean;
  camera: (t: number, out: Cam) => void;
  duration: number;
}

export const FX_SCENE_IDS = ['flythrough', 'weapons', 'shield', 'shield-beams', 'fences', 'explosions', 'zoom', 'nebula', 'environment', 'battle'] as const;
export type FxSceneId = (typeof FX_SCENE_IDS)[number];

/** A ship holding station at (x, y), facing (tx, ty), with a small bob. */
function station(id: string, x: number, y: number, tx: number, ty: number, ph: number, paint?: number): ShipE {
  return {
    id, paint, trail: false,
    pose: (t, o) => {
      o.x = x + Math.sin(t * 0.7 + ph) * 5;
      o.y = y + Math.cos(t * 0.5 + ph) * 6;
      o.rot = Math.atan2(ty - o.y, tx - o.x) + Math.PI / 2 + Math.sin(t * 1.1 + ph) * 0.04;
      o.thrust = 0.35;
    },
  };
}

function flyer(id: string, p: (t: number) => [number, number], paint?: number): ShipE {
  return {
    id, paint, trail: true,
    pose: (t, o) => {
      const [x, y] = p(t);
      const [x2, y2] = p(t + 0.02);
      o.x = x; o.y = y;
      o.rot = Math.atan2(y2 - y, x2 - x) + Math.PI / 2;
      o.thrust = 1;
    },
  };
}

function baseStructs(): StructE[] {
  return [
    { id: 'capital', x: 0, y: 0, rot: 0, seed: 1 },
    { id: 'connector', x: 360, y: 0, rot: 0, seed: 2 },
    { id: 'connector', x: -360, y: 0, rot: 0, seed: 3 },
    { id: 'connector', x: 0, y: 360, rot: 0, seed: 4 },
    { id: 'solar', x: 620, y: -110, rot: 0, seed: 5 },
    { id: 'solar', x: 620, y: 110, rot: 0, seed: 6 },
    { id: 'solar', x: -620, y: -110, rot: 0, seed: 7 },
    { id: 'turret', x: 330, y: 380, rot: 0, seed: 8 },
    { id: 'turret', x: -330, y: 380, rot: 0, seed: 9 },
  ];
}

/** A loose asteroid field with some ice and crystal rocks. */
function rockField(cx: number, cy: number, n: number, spread: number, seed: number): FxRock[] {
  const out: FxRock[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i * 2.399 + seed) % (Math.PI * 2));
    const d = spread * Math.sqrt((i + 0.5) / n);
    const k = (i * 7 + seed) % 10;
    out.push({
      x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d * 0.7,
      r: 18 + ((i * 37 + seed) % 50),
      resource: k < 2 ? 'ice' : k < 3 ? 'crystal' : undefined,
      rot: i * 1.3, spin: (((i * 13) % 7) - 3) * 0.02, id: 1000 + seed * 100 + i,
    });
  }
  return out;
}

export function buildFxScene(id: FxSceneId, zoomOverride?: number, n = 12): FxScene {
  const zoomOr = (z: number): number => zoomOverride ?? z;
  const empty = { structs: [], shots: [], booms: [], shields: [], rocks: [], wisps: [] };
  switch (id) {
    case 'weapons': {
      // Four lanes, shooter left, target right: beam, bolts, autocannon, missiles.
      const lanes = [-225, -75, 75, 225];
      const ships: ShipE[] = [];
      for (let i = 0; i < 4; i++) {
        ships.push(station(i === 3 ? 'missile-frigate' : 'fighter', -340, lanes[i]!, 340, lanes[i]!, i));
        ships.push(station(i % 2 ? 'robot-square' : 'heavy', 340, lanes[i]!, -340, lanes[i]!, i + 4));
      }
      const shots: FxShot[] = [
        { kind: 'beam', from: 0, to: 1, t0: 0.3, t1: 5.7, color: 0x5fc8ff },
        { kind: 'bolt', from: 2, to: 3, t0: 0, t1: 6, color: 0xffc860, period: 0.32, speed: 520 },
        { kind: 'cannon', from: 4, to: 5, t0: 0, t1: 6, color: 0xffe6a0, period: 0.085, speed: 1150 },
        { kind: 'missile', from: 6, to: 7, t0: 0, t1: 6, color: 0xff9a40, period: 0.85, speed: 300 },
      ];
      return { ...empty, ships, shots, duration: 6, camera: (_t, c) => { c.x = 0; c.y = 0; c.zoom = zoomOr(1.35); } };
    }
    case 'shield': {
      // One heavy under fire from five sides; the shield breaks at 4.2 s, then
      // the shots hit the hull.
      const ships: ShipE[] = [station('heavy', 0, 0, 0, -400, 0)];
      const R = 250;
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.62 + (i > 2 ? Math.PI : 0);
        ships.push(station(i === 2 ? 'interceptor' : 'robot-square', Math.cos(a) * R, Math.sin(a) * R, 0, 0, i + 1));
      }
      const shots: FxShot[] = [
        { kind: 'bolt', from: 1, to: 0, t0: 0.1, t1: 6, color: 0xff5a7a, period: 0.42, speed: 480 },
        { kind: 'bolt', from: 2, to: 0, t0: 0.3, t1: 6, color: 0xff5a7a, period: 0.5, speed: 480 },
        { kind: 'beam', from: 3, to: 0, t0: 1.2, t1: 2.4, color: 0xff4f8a },
        { kind: 'bolt', from: 4, to: 0, t0: 0.6, t1: 6, color: 0xff5a7a, period: 0.37, speed: 480 },
        { kind: 'cannon', from: 5, to: 0, t0: 2.6, t1: 6, color: 0xffd0a0, period: 0.11, speed: 1100 },
      ];
      return { ...empty, ships, shots, shields: [{ ship: 0, radius: 48, breakAt: 4.2, color: 0x7fd8ff }], duration: 6,
        camera: (_t, c) => { c.x = 0; c.y = 0; c.zoom = zoomOr(1.7); } };
    }
    case 'flythrough': {
      // 12 000 u in 20 s: cruise (450 u/s) for 10 s, then boost (750 u/s),
      // through an emission nebula and past the sector's landmarks.
      const xAt = (t: number): number => (t < 10 ? 450 * t : 4500 + 750 * (t - 10));
      const yAt = (x: number): number => 300 * Math.sin(x / 2500);
      const wing = (dx: number, dy: number) => (t: number): [number, number] => { const x = xAt(t) + dx; return [x, yAt(x) + dy]; };
      const ships: ShipE[] = [flyer('fighter', wing(0, 0)), flyer('fighter', wing(-70, -60)), flyer('fighter', wing(-70, 60))];
      return {
        ...empty, ships, duration: 20, sky: 'emerald-span',
        rocks: [...rockField(2400, 350, 9, 380, 2), ...rockField(5200, -420, 8, 340, 5), ...rockField(9800, 250, 9, 380, 9)],
        regions: [{ x: 6800, y: 0, r: 2300, variant: 'emission', seed: 1 }, { x: 11600, y: 300, r: 1500, variant: 'reflection', seed: 2 }],
        camera: (t, c) => { const x = xAt(t); c.x = x + 80; c.y = yAt(x); c.zoom = zoomOr(0.9); },
      };
    }
    case 'fences': {
      // A fenced compound: bolts and lasers on the fence, the gate opening
      // for a ship and closing behind it, then the west fence losing power
      // and coming back up.
      const P0: [number, number] = [-240, -170], P1: [number, number] = [240, -170], P2: [number, number] = [240, 170], P3: [number, number] = [-240, 170];
      const G1: [number, number] = [55, 170], G2: [number, number] = [-55, 170];
      const f = (a: [number, number], b: [number, number], up: Array<[number, number]>, gate = false): FxFence => ({ ax: a[0], ay: a[1], bx: b[0], by: b[1], up, gate });
      const fences: FxFence[] = [
        f(P0, P1, [[0.4, 9]]), f(P1, P2, [[0, 9]]), f(P2, G1, [[0, 9]]),
        f(G1, G2, [[0, 3.4], [5.4, 9]], true), f(G2, P3, [[0, 9]]), f(P3, P0, [[0, 6.0], [7.3, 9]]),
      ];
      const ships: ShipE[] = [
        station('robot-square', -110, -420, -110, 0, 1), station('robot-square', 120, -430, 120, 0, 2),
        station('interceptor', 560, -60, 0, -60, 3), station('interceptor', 560, 40, 0, 40, 4), station('interceptor', 560, 110, 0, 110, 5),
        {
          id: 'fighter', trail: true,
          pose: (t, o) => {
            const k = Math.min(1, Math.max(0, (t - 3.6) / 1.5));
            const e = k * k * (3 - 2 * k);
            o.x = 0; o.y = 470 - e * 520; o.rot = 0; o.thrust = k > 0 && k < 1 ? 1 : 0.3;
          },
        },
      ];
      const shots: FxShot[] = [
        { kind: 'bolt', from: 0, to: 0, wall: 0, wallT: 0.27, t0: 1.0, t1: 9, color: 0xff5a7a, period: 0.45, speed: 480 },
        { kind: 'bolt', from: 1, to: 1, wall: 0, wallT: 0.75, t0: 1.25, t1: 9, color: 0xff5a7a, period: 0.5, speed: 480 },
        { kind: 'beam', from: 2, to: 2, wall: 1, wallT: 0.32, t0: 2.0, t1: 5.6, color: 0xff4f8a },
        { kind: 'beam', from: 3, to: 3, wall: 1, wallT: 0.62, t0: 2.6, t1: 5.6, color: 0xff4f8a },
        { kind: 'beam', from: 4, to: 4, wall: 1, wallT: 0.7, t0: 3.2, t1: 5.6, color: 0xff4f8a },
      ];
      return { ...empty, ships, shots, fences, duration: 9,
        structs: [P0, P1, P2, P3, G1, G2].map(([x, y], i) => ({ id: 'shield_pylon', x, y, rot: 0, seed: i + 1 })),
        camera: (_t, c) => { c.x = 70; c.y = -10; c.zoom = zoomOr(0.95); } };
    }
    case 'shield-beams': {
      // Held beam contact: 1 beam, then a 2nd from another side, then a 3rd
      // landing close to the first (they share one brighter patch), then bolts
      // and autocannon on top.
      const at = (a: number, r: number): [number, number] => [Math.cos(a) * r, Math.sin(a) * r];
      const up = -Math.PI / 2;
      const [ax, ay] = at(up, 270), [bx, by] = at(up - 0.85, 270), [cx, cy] = at(up + 0.22, 300);
      const [dx, dy] = at(0.15, 280), [ex, ey] = at(1.1, 270);
      const ships: ShipE[] = [
        station('heavy', 0, 0, 0, -400, 0),
        station('interceptor', ax, ay, 0, 0, 1), station('interceptor', bx, by, 0, 0, 2), station('interceptor', cx, cy, 0, 0, 3),
        station('robot-square', dx, dy, 0, 0, 4), station('robot-square', ex, ey, 0, 0, 5),
      ];
      const shots: FxShot[] = [
        { kind: 'beam', from: 1, to: 0, t0: 0.3, t1: 7.6, color: 0xff4f8a },
        { kind: 'beam', from: 2, to: 0, t0: 2.0, t1: 7.6, color: 0xff4f8a },
        { kind: 'beam', from: 3, to: 0, t0: 3.6, t1: 6.8, color: 0xff4f8a },
        { kind: 'bolt', from: 4, to: 0, t0: 5.0, t1: 8, color: 0xff5a7a, period: 0.4, speed: 480 },
        { kind: 'cannon', from: 5, to: 0, t0: 5.4, t1: 8, color: 0xffd0a0, period: 0.11, speed: 1100 },
      ];
      return { ...empty, ships, shots, shields: [{ ship: 0, radius: 52, color: 0x7fd8ff }], duration: 8,
        camera: (_t, c) => { c.x = 0; c.y = -40; c.zoom = zoomOr(1.6); } };
    }
    case 'explosions': {
      const ships: ShipE[] = [
        flyer('havok', (t) => [-420 + t * 150, -120 + Math.sin(t) * 20]),
        flyer('heavy', (t) => [380 - t * 60, 200 - t * 30]),
      ];
      return {
        ...empty, ships, structs: [{ id: 'solar', x: 420, y: -160, rot: 0, seed: 3 }],
        booms: [
          { x: -260, y: 160, t0: 0.3, size: 'small' },
          { x: -420 + 1.3 * 150, y: -120 + Math.sin(1.3) * 20, t0: 1.3, size: 'ship', ship: 0 },
          { x: 420, y: -160, t0: 2.5, size: 'large' },
          { x: 380 - 3.7 * 60, y: 200 - 3.7 * 30, t0: 3.7, size: 'ship', ship: 1 },
        ],
        duration: 5.6, camera: (_t, c) => { c.x = 0; c.y = 0; c.zoom = zoomOr(0.95); },
      };
    }
    case 'zoom': {
      // The scripted zoom sweep: 0.15 → 3 → 0.15, panning gently.
      const ships: ShipE[] = [];
      for (let i = 0; i < 5; i++) {
        ships.push(flyer(i ? 'fighter' : 'heavy', (t) => [-900 + t * 160 - (i % 2) * 60, -380 + (i - 2) * 55 + Math.sin(t * 0.6 + i) * 30]));
      }
      return {
        ...empty, ships, structs: baseStructs(), rocks: rockField(-900, 500, 22, 600, 3), planet: true,
        wisps: [{ x: -900, y: 520, size: 1100, tint: 0x6fa8ff, rot: 0.3 }],
        duration: 10,
        camera: (t, c) => {
          const k = Math.min(1, Math.max(0, t / 10));
          const e = 0.5 - 0.5 * Math.cos(k * Math.PI * 2); // 0 → 1 → 0
          c.zoom = zoomOr(0.15 * Math.pow(20, e));
          c.x = -200 + t * 40; c.y = -150 + t * 10;
        },
      };
    }
    case 'nebula':
      return {
        ...empty, ships: [flyer('fighter', (t) => [-300 + t * 120, -40])], structs: baseStructs(), planet: true,
        duration: 6, camera: (t, c) => { c.x = -600 + t * 220; c.y = -200 + t * 40; c.zoom = zoomOr(0.45); },
      };
    case 'environment':
      return {
        ...empty,
        ships: [flyer('fighter', (t) => [-700 + t * 170, 80 + Math.sin(t * 0.8) * 60]), flyer('fighter', (t) => [-760 + t * 170, 140 + Math.sin(t * 0.8) * 60])],
        rocks: rockField(-200, 0, 34, 700, 7),
        wisps: [
          { x: -320, y: -80, size: 900, tint: 0x5f9cff, rot: 0.4 },
          { x: 200, y: 160, size: 700, tint: 0xb07cff, rot: 2.1 },
          { x: -650, y: 260, size: 600, tint: 0x6fd6c8, rot: 4.0 },
        ],
        wreck: { kind: 'havok', x: 360, y: -170, scale: 3, spread: 70 },
        planet: true,
        duration: 8, camera: (t, c) => { c.x = -350 + t * 75; c.y = 0; c.zoom = zoomOr(0.75); },
      };
    case 'battle': {
      // Two fleets trading every weapon type, shields on the big ships, ships
      // dying through the clip. `n` ships a side.
      const ships: ShipE[] = [];
      const shots: FxShot[] = [];
      const shields: FxShield[] = [];
      const booms: FxBoom[] = [];
      const kinds = ['fighter', 'heavy', 'interceptor', 'missile-frigate'];
      const half = Math.max(2, n);
      for (let side = 0; side < 2; side++) {
        for (let i = 0; i < half; i++) {
          const row = i % 6, col = Math.floor(i / 6);
          const x = (side ? 1 : -1) * (300 + col * 110);
          const y = (row - 2.5) * 95;
          const id = side ? (i % 3 === 0 ? 'robot-hexagon' : 'robot-square') : kinds[i % kinds.length]!;
          ships.push(station(id, x, y, -x, y, i + side * 50));
        }
      }
      for (let i = 0; i < half; i++) {
        const a = i, b = half + ((i * 5) % half);
        const k = i % 4;
        const kind: FxShotKind = k === 0 ? 'beam' : k === 1 ? 'bolt' : k === 2 ? 'cannon' : 'missile';
        shots.push({ kind, from: a, to: b, t0: (i * 0.13) % 1, t1: 10, color: kind === 'beam' ? 0x5fc8ff : kind === 'cannon' ? 0xffe6a0 : 0xffc860,
          period: kind === 'bolt' ? 0.34 : kind === 'cannon' ? 0.09 : 1.1, speed: kind === 'bolt' ? 520 : kind === 'cannon' ? 1150 : 300 });
        shots.push({ kind: i % 2 ? 'bolt' : 'cannon', from: b, to: a, t0: (i * 0.29) % 1, t1: 10, color: 0xff5a7a,
          period: i % 2 ? 0.45 : 0.11, speed: i % 2 ? 480 : 1100 });
      }
      for (let i = 1; i < half; i += 4) shields.push({ ship: i, radius: 44, color: 0x7fd8ff, breakAt: 3 + i * 0.4 });
      for (let i = 0; i < half; i += 5) shields.push({ ship: half + i, radius: 44, color: 0xff7aa8 });
      for (let k = 0; k < 4; k++) {
        const s = half + 2 + k * 3;
        if (s >= half * 2) break;
        booms.push({ x: 0, y: 0, t0: 1.8 + k * 2.1, size: 'ship', ship: s });
      }
      return {
        ...empty, ships, shots, shields, booms, rocks: rockField(0, 520, 14, 500, 11),
        wisps: [{ x: 0, y: 560, size: 900, tint: 0x6fa8ff, rot: 1 }], planet: true,
        duration: 10, camera: (t, c) => { c.x = Math.sin(t * 0.2) * 60; c.y = 40; c.zoom = zoomOr(0.85); },
      };
    }
  }
}

/** Pose of ship `i` at `t` into `out` (convenience). */
export function shipPose(s: FxScene, i: number, t: number, out: Pose): Pose {
  s.ships[i]!.pose(t, out);
  return out;
}

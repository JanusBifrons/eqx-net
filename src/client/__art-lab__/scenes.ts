/**
 * Art lab — deterministic scenes. A frame is a pure function of `t` (seconds),
 * so captures are frame-exact and every style sees the identical scene.
 * Space is Pixi space (y down); a ship's nose is local -y.
 */
import { npcFactionDef, type FactionId } from '../../shared-types/factions.js';
import { SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { buildStructureVisual } from '../render/pixi/structureVisuals.js';
import { shipExtent } from '../render/art/fields.js';

export interface Pose { x: number; y: number; rot: number; thrust: number }

export interface ShipE {
  id: string;
  paint?: number;
  pose: (t: number, out: Pose) => void;
  /** Leave an exhaust trail (false for ships turning on the spot). */
  trail: boolean;
}

export interface StructE { id: string; x: number; y: number; rot: number; seed: number }

export interface Boom { x: number; y: number; t0: number; size: number }

export interface Cam { x: number; y: number; zoom: number }

/** A weapon stream between two ships (indices into `ships`). Beams are
 *  continuous over [t0, t1]; bolts fire every `period` s and fly at `speed`. */
export interface Shot {
  kind: 'beam' | 'bolt';
  from: number;
  to: number;
  t0: number;
  t1: number;
  color: number;
  period?: number;
  speed?: number;
  /** Target has its shield up: hits flash a rim instead of sparking the hull. */
  shield?: boolean;
  /** Fire from this point in the shooter's frame (art-local units), with a muzzle flash. */
  muzzle?: [number, number];
  /** Aim at this world point instead of the target ship (`to` is ignored). */
  at?: [number, number];
  /** Size of the round, its flash, impact and lights (1 = a bolt; a 16" shell ~6). */
  size?: number;
}

export interface Scene {
  ships: ShipE[];
  structs: StructE[];
  booms: Boom[];
  shots?: Shot[];
  camera: (t: number, out: Cam) => void;
  duration: number;
}

export const SCENE_IDS = ['ships', 'factions', 'structures', 'base', 'explosion', 'sweep', 'bench', 'fleet', 'capitals', 'industry', 'mega', 'combat', 'spin', 'spinfleet', 'capfleet', 'broadside'] as const;

/** Sheet scenes fit their content into this view (the capture size). */
const SHEET_W = 1600, SHEET_H = 900;

/** Shelf-pack items (w × h, world units) into rows no wider than `maxW`;
 *  returns centres plus the overall bounds. */
function shelf(sizes: Array<{ w: number; h: number }>, maxW: number, gap: number): { pos: Array<[number, number]>; w: number; h: number } {
  const pos: Array<[number, number]> = [];
  let x = 0, y = 0, rowH = 0, W = 0;
  for (const sz of sizes) {
    if (x > 0 && x + sz.w > maxW) { y += rowH + gap; x = 0; rowH = 0; }
    pos.push([x + sz.w / 2, y + sz.h / 2]);
    x += sz.w + gap; rowH = Math.max(rowH, sz.h); W = Math.max(W, x - gap);
  }
  return { pos, w: W, h: y + rowH };
}

function fitZoom(w: number, h: number, margin = 0.9): number {
  return Math.min((SHEET_W * margin) / w, (SHEET_H * margin) / h);
}

const CORE_STRUCTS = new Set(['capital', 'connector', 'solar', 'turret', 'teleporter']);
const MEGA_STRUCTS = ['deep_core_rig', 'ore_processing_complex', 'assembly_plant', 'shipyard', 'teleporter_large', 'alien_gate'];

function structSheet(ids: string[], aspect: number, zoomOr: (z: number) => number): Scene {
  const sizes = ids.map((id) => {
    const fp = buildStructureVisual(id, { accent: getStructureKind(id).color, seed: 1, omitSpans: true }).footprint;
    return { w: fp.w, h: fp.h };
  });
  let area = 0;
  for (const z of sizes) area += (z.w + 60) * (z.h + 60);
  const L = shelf(sizes, Math.sqrt(area * aspect) * 1.05, 60);
  const structs: StructE[] = ids.map((id, i) => ({ id, x: L.pos[i]![0] - L.w / 2, y: L.pos[i]![1] - L.h / 2, rot: 0, seed: 1 + i }));
  const z = fitZoom(L.w, L.h);
  return { ships: [], structs, booms: [], duration: 4, camera: (_t, c) => { c.x = 0; c.y = 0; c.zoom = zoomOr(z); } };
}

function shipSheet(ids: string[], zoomOr: (z: number) => number): Scene {
  const sizes = ids.map((id) => { const d = shipExtent(id) * 2.3; return { w: d, h: d }; });
  let area = 0;
  for (const z of sizes) area += (z.w + 16) * (z.h + 16);
  const L = shelf(sizes, Math.sqrt(area * (SHEET_W / SHEET_H)) * 1.1, 16);
  const ships = ids.map((id, i) => spinner(id, L.pos[i]![0] - L.w / 2, L.pos[i]![1] - L.h / 2, 0.5 + i * 0.7, 0.4));
  const z = fitZoom(L.w, L.h, 0.85);
  return { ships, structs: [], booms: [], duration: 8, camera: (_t, c) => { c.x = 0; c.y = 0; c.zoom = zoomOr(z); } };
}
export type SceneId = (typeof SCENE_IDS)[number];

const ROUND1_SHIPS = ['fighter', 'heavy', 'missile-frigate', 'trader-hauler', 'havok', 'robot-hexagon'];
const SHIP_SPAN: Record<string, number> = { fighter: 34, heavy: 40, 'missile-frigate': 58, 'trader-hauler': 80, havok: 50, 'robot-hexagon': 50 };

function spinner(id: string, x: number, y: number, phase: number, rate: number, paint?: number): ShipE {
  return {
    id, paint, trail: false,
    pose: (t, o) => { o.x = x; o.y = y; o.rot = phase + t * rate; o.thrust = 0.35; },
  };
}

/** A ship following path p(t); rotation from the path's tangent. */
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
    { id: 'turret', x: -620, y: 150, rot: 0, seed: 10 },
    { id: 'teleporter', x: 0, y: 920, rot: 0, seed: 11 },
  ];
}

function fleet(t0: number): ShipE[] {
  const lane = (dy: number, speed: number, delay: number) => (t: number): [number, number] => {
    const s = (t - delay + t0) * speed;
    return [-1500 + s, -330 + dy + Math.sin(s / 260) * 60];
  };
  return [
    flyer('heavy', lane(0, 170, 0)),
    flyer('fighter', lane(-60, 170, -0.35)),
    flyer('fighter', lane(60, 170, -0.35)),
    flyer('missile-frigate', lane(-20, 150, 1.2)),
    flyer('trader-hauler', lane(140, 110, 0.4)),
  ];
}

export function buildScene(id: SceneId, zoomOverride?: number, n = 40): Scene {
  const zoomOr = (z: number): number => zoomOverride ?? z;
  switch (id) {
    case 'ships': {
      let x = 0;
      const ships = ROUND1_SHIPS.map((sid, i) => {
        const w = SHIP_SPAN[sid] ?? 50;
        const s = spinner(sid, x + w / 2, 0, i * 0.9, 0.55);
        x += w + 26;
        return s;
      });
      const mid = (x - 26) / 2;
      return { ships, structs: [], booms: [], duration: 8, camera: (_t, c) => { c.x = mid; c.y = 0; c.zoom = zoomOr(2.2); } };
    }
    case 'factions': {
      const fac: Array<FactionId | null> = [null, 'core', 'verdant-reach', 'crimson-expanse', 'azure-deep', 'traders'];
      const ships = fac.map((f, i) => spinner('heavy', i * 64, 0, 0.6, 0.3, f ? npcFactionDef(f)?.color : undefined));
      return { ships, structs: [], booms: [], duration: 6, camera: (_t, c) => { c.x = 160; c.y = 0; c.zoom = zoomOr(2.6); } };
    }
    case 'structures':
      return {
        ships: [],
        structs: [
          { id: 'capital', x: 0, y: 0, rot: 0, seed: 1 },
          { id: 'solar', x: 520, y: -170, rot: 0, seed: 2 },
          { id: 'turret', x: 450, y: 120, rot: 0, seed: 3 },
          { id: 'teleporter', x: -760, y: 0, rot: 0, seed: 4 },
        ],
        booms: [],
        duration: 4,
        camera: (_t, c) => { c.x = -120; c.y = 0; c.zoom = zoomOr(0.62); },
      };
    case 'base':
      return { ships: fleet(3.2), structs: baseStructs(), booms: [], duration: 10, camera: (_t, c) => { c.x = 0; c.y = -60; c.zoom = zoomOr(0.5); } };
    case 'explosion':
      return {
        ships: [flyer('fighter', (t) => [200 + t * 140, 120 - t * 30]), flyer('fighter', (t) => [520 - t * 60, 620 - t * 150])],
        structs: baseStructs(),
        booms: [{ x: 330, y: 380, t0: 1.0, size: 1 }, { x: 360, y: 0, t0: 2.6, size: 0.6 }],
        duration: 5,
        camera: (_t, c) => { c.x = 230; c.y = 230; c.zoom = zoomOr(1.1); },
      };
    case 'sweep':
      return {
        ships: fleet(2.5),
        structs: baseStructs(),
        booms: [],
        duration: 7,
        camera: (t, c) => {
          const k = Math.min(1, Math.max(0, (t - 0.5) / 6));
          const e = k * k * (3 - 2 * k);
          c.zoom = 0.3 * Math.pow(10, e);
          c.x = 330 * e; c.y = 380 * e;
        },
      };
    case 'spin':
      // GPU-lit R&D: one ship turning a full circle in 8 s, close up, so the
      // light can be watched moving across the hull (baked: 16 blended steps).
      return {
        ships: [{ id: 'missile-frigate', trail: false, pose: (t, o) => { o.x = 0; o.y = 0; o.rot = (t / 8) * Math.PI * 2; o.thrust = 0; } }],
        structs: [],
        booms: [],
        duration: 8,
        camera: (_t, c) => { c.x = 0; c.y = 0; c.zoom = 4.5; },
      };
    case 'broadside': {
      // GPU-lit R&D (1b): a battleship's 16" broadside on a base, escorts
      // around it, so the shells' muzzle flashes, flight and impacts light
      // the hulls and the structures. Wide on the battleship, then the
      // camera drops to the base as the shells land.
      const bsY = -2100, bsRot = Math.PI / 2;
      // The battleship's local +x points at the base (its starboard side).
      const world = (lx: number, ly: number): [number, number] => [-ly, bsY + lx];
      const mains = [-1496, -984, 1841]; // turret stations (art-local y)
      const salvos: Array<[number, Array<[number, number]>]> = [
        [0.8, [[-360, 0], [0, -40], [360, 0]]],
        [4.0, [[620, -110], [-620, 150], [0, 360]]],
        [6.6, [[330, 380], [-330, 380], [-360, 0]]],
      ];
      const SPEED = 1700;
      const shots: Shot[] = [];
      const booms: Boom[] = [];
      for (const [t0, aims] of salvos) {
        mains.forEach((ly, i) => {
          const at = aims[i]!, m = world(340, ly);
          const flight = Math.hypot(at[0] - m[0], at[1] - m[1]) / SPEED;
          shots.push({ kind: 'bolt', from: 0, to: 0, t0: t0 + i * 0.12, t1: t0 + i * 0.12, color: 0xffc070, period: 20, speed: SPEED, muzzle: [340, ly], at, size: 6 });
          booms.push({ x: at[0], y: at[1], t0: t0 + i * 0.12 + flight, size: 0.9 });
        });
      }
      const orbit = (r: number, w: number, ph: number) => (t: number): [number, number] => [Math.cos(ph + t * w) * r, 300 + Math.sin(ph + t * w) * r * 0.7];
      const ships: ShipE[] = [
        { id: 'battleship', trail: false, pose: (_t, o) => { o.x = 0; o.y = bsY; o.rot = bsRot; o.thrust = 0.15; } },
        flyer('fighter', orbit(820, 0.35, 0.3)),
        flyer('heavy', orbit(900, 0.3, 2.2)),
        flyer('gunship', orbit(760, 0.4, 4.1)),
        flyer('interceptor', orbit(980, 0.33, 5.3)),
      ];
      // Secondary battery (5" class) on the escorts.
      [-690, 0, 690].forEach((ly, i) => shots.push({ kind: 'bolt', from: 0, to: 1 + i, t0: 1.6 + i * 0.4, t1: 9.5, color: 0xffd890, period: 1.4, speed: 1500, muzzle: [260, ly], size: 2 }));
      return {
        ships, structs: baseStructs(), booms, shots, duration: 10,
        camera: (t, c) => {
          const k = Math.min(1, Math.max(0, (t - 1.8) / 1.8)), e = k * k * (3 - 2 * k);
          c.x = 0; c.y = -1400 + 1700 * e; c.zoom = zoomOr(0.18 + 0.34 * e);
        },
      };
    }
    case 'capfleet': {
      // GPU-lit R&D (1b): a destroyer with escorts alongside on its shadow side
      // (capital shadows, occlusion, bounce), robots firing at them and
      // explosions among them (point lights).
      const capRot = (t: number): number => 0.25 + t * 0.03;
      const along = (lx: number, ly: number, t: number, o: Pose, bob: number): void => {
        const r = capRot(t), c = Math.cos(r), s = Math.sin(r);
        const x = lx + Math.sin(t * 0.9 + bob) * 6, y = ly + Math.cos(t * 0.7 + bob) * 8;
        o.x = x * c - y * s; o.y = x * s + y * c; o.rot = r + Math.sin(t * 1.1 + bob) * 0.08; o.thrust = 0.4;
      };
      const escorts: Array<[string, number, number]> = [['fighter', -175, -380], ['interceptor', -190, -180], ['heavy', -215, 30], ['gunship', -180, 230], ['missile-frigate', -260, 420], ['fighter', -165, 560]];
      const ships: ShipE[] = [
        { id: 'destroyer', trail: false, pose: (t, o) => { o.x = 0; o.y = 0; o.rot = capRot(t); o.thrust = 0.2; } },
        ...escorts.map(([id, lx, ly], i): ShipE => ({ id, trail: false, pose: (t, o) => along(lx, ly, t, o, i * 1.7) })),
        { id: 'robot-hexagon', trail: false, pose: (t, o) => { o.x = -760 + Math.sin(t) * 10; o.y = -120 + Math.cos(t * 0.8) * 12; o.rot = Math.PI / 2 + Math.sin(t * 0.6) * 0.1; o.thrust = 0.3; } },
        { id: 'robot-circle', trail: false, pose: (t, o) => { o.x = -720 + Math.cos(t) * 10; o.y = 300 + Math.sin(t * 0.9) * 12; o.rot = Math.PI / 2 + Math.sin(t * 0.5) * 0.1; o.thrust = 0.3; } },
      ];
      return {
        ships,
        structs: [],
        booms: [{ x: -330, y: -60, t0: 1.6, size: 0.35 }, { x: -300, y: 340, t0: 4.2, size: 0.45 }],
        shots: [
          { kind: 'bolt', from: 7, to: 2, t0: 0.3, t1: 7.5, color: 0xff6a5a, period: 0.35, speed: 520 },
          { kind: 'beam', from: 8, to: 4, t0: 2.5, t1: 5.5, color: 0xff4fd0 },
          { kind: 'bolt', from: 3, to: 7, t0: 0.8, t1: 7.5, color: 0x8fd8ff, period: 0.3, speed: 600 },
        ],
        duration: 8,
        camera: (_t, c) => { c.x = -330; c.y = 90; c.zoom = 0.62; },
      };
    }
    case 'spinfleet': {
      // GPU-lit R&D: six different ships turning in place, a full turn in 8 s.
      const ids = ['fighter', 'missile-frigate', 'robot-hexagon', 'interceptor', 'trader-hauler', 'gunship'];
      const SP = 150;
      return {
        ships: ids.map((id, i) => ({
          id, trail: false,
          pose: (t: number, o: Pose) => { o.x = ((i % 3) - 1) * SP; o.y = (Math.floor(i / 3) - 0.5) * SP; o.rot = (t / 8) * Math.PI * 2 + i * 0.9; o.thrust = 0; },
        })),
        structs: [],
        booms: [],
        duration: 8,
        camera: (_t, c) => { c.x = 0; c.y = 0; c.zoom = 1.6; },
      };
    }
    case 'fleet':
      return shipSheet(SHIP_KINDS_LIST.filter((k) => shipExtent(k.id) < 100).map((k) => k.id), zoomOr);
    case 'capitals':
      return shipSheet(SHIP_KINDS_LIST.filter((k) => shipExtent(k.id) >= 100).map((k) => k.id), zoomOr);
    case 'industry':
      return structSheet(['miner', 'battery', 'shield_pylon', 'laser_bolt_turret', 'missile_turret', 'autocannon_turret', 'mine_layer',
        'cargo_bay', 'shield_gate', 'shield_airlock', 'gas_collector', 'reclaimer', 'smelter', 'refinery', 'silicon_works', 'hydroponics',
        'fabricator', 'munitions_works', 'research_lab', 'reactor', 'battery_bank', 'storage_vault', 'habitat_module', 'tower_module',
        'freight_dock'].filter((id) => !CORE_STRUCTS.has(id)), SHEET_W / SHEET_H, zoomOr);
    case 'mega':
      return structSheet(MEGA_STRUCTS, SHEET_W / SHEET_H, zoomOr);
    case 'combat': {
      // Sol patrol (left) against a robot pack (right).
      const face = (id: string, x: number, y: number, tx: number, ty: number, ph: number, paint?: number): ShipE => ({
        id, paint, trail: false,
        pose: (t, o) => {
          o.x = x + Math.sin(t * 0.7 + ph) * 6; o.y = y + Math.cos(t * 0.5 + ph) * 8;
          o.rot = Math.atan2(ty - o.y, tx - o.x) + Math.PI / 2 + Math.sin(t * 1.3 + ph) * 0.06;
          o.thrust = 0.35;
        },
      });
      const sol = npcFactionDef('core')?.color;
      const ships = [
        face('heavy', -150, 0, 150, 0, 0, sol),
        face('fighter', -125, -70, 140, -60, 1, sol),
        face('fighter', -125, 70, 140, 60, 2, sol),
        face('robot-hexagon', 150, 0, -150, 0, 3),
        face('robot-square', 140, -60, -125, -70, 4),
        face('robot-square', 140, 60, -125, 70, 5),
      ];
      const shots: Shot[] = [
        { kind: 'beam', from: 0, to: 3, t0: 0.4, t1: 3.2, color: 0x6fd0ff },
        { kind: 'bolt', from: 1, to: 4, t0: 0, t1: 6, color: 0xffd27a, period: 0.32, speed: 520 },
        { kind: 'bolt', from: 2, to: 5, t0: 0.15, t1: 6, color: 0xffd27a, period: 0.32, speed: 520 },
        { kind: 'bolt', from: 3, to: 0, t0: 0.2, t1: 6, color: 0xff5a7a, period: 0.45, speed: 420, shield: true },
        { kind: 'beam', from: 4, to: 1, t0: 3.6, t1: 5.6, color: 0xff4f8a, shield: true },
      ];
      return { ships, structs: [], booms: [], shots, duration: 6, camera: (_t, c) => { c.x = 0; c.y = 0; c.zoom = zoomOr(2.4); } };
    }
    case 'bench': {
      const structs: StructE[] = [];
      const kinds = ['capital', 'solar', 'turret', 'connector', 'solar', 'turret', 'connector', 'turret'];
      let k = 0;
      for (let gy = -6; gy <= 6 && structs.length < 150; gy++) {
        for (let gx = -6; gx <= 6 && structs.length < 150; gx++) {
          const id = kinds[k++ % kinds.length]!;
          structs.push({ id, x: gx * 600, y: gy * 600, rot: 0, seed: k });
        }
      }
      const ships: ShipE[] = [];
      for (let i = 0; i < n; i++) {
        const id = ROUND1_SHIPS[i % ROUND1_SHIPS.length]!;
        const r = 400 + (i * 97) % 2400, ph = i * 1.7, sp = 0.06 + (i % 5) * 0.02;
        ships.push(flyer(id, (t) => [Math.cos(ph + t * sp) * r, Math.sin(ph + t * sp) * r]));
      }
      return { ships, structs, booms: [], duration: 20, camera: (_t, c) => { c.x = 0; c.y = 0; c.zoom = zoomOr(0.5); } };
    }
  }
}

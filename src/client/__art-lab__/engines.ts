/**
 * Engine exhaust lab (rnd/engine-fx). Dev-only.
 *
 *   /__art-lab__/engines.html?arm=today|flame|ribbon|both&scene=flight|close|swarm&w=&h=&zoom=
 *
 * One deterministic flight, four looks:
 *  - `today`  — the game's own EngineEmitter + particle factory, fed the same
 *               game-space pose the renderer gives it (one stern point);
 *  - `flame`  — a baked plume at each Machined nozzle, sized by thrust/boost;
 *  - `ribbon` — a hot rope through each nozzle's recent positions;
 *  - `both`   — flame + a fainter ribbon.
 *
 * The flight: coast → thrust → boost → boosted turn → engines cut, with the
 * camera following like the game does (so speed shows as stars sliding by).
 * Pixi space (y down); a ship's nose is local -y. Simulation steps at a fixed
 * 1/60 s so a seek is frame-exact for the new arms (today's particles use
 * Math.random, as in the game).
 */
import { Application, Container, MeshRope, Point, Sprite, Texture, TilingSprite, CanvasSource, type BLEND_MODES } from 'pixi.js';
import { ArtCache, SUN_STEPS, type ShipArt } from './assets.js';
import type { BakeJob } from '../render/art/bake.js';
import { glowTex, starTileTex, type Img } from '../render/art/fx/fxTextures.js';
import { easeTo, exhaustTint, exhaustTrailTex, ExhaustRing, flameShape, flameTex, type FlameShape } from '../render/art/fx/engineFx.js';
import { EngineEmitter } from '../effects/perEffect/EngineEmitter.js';
import { buildEngineFactories } from '../effects/perEffect/engineFactories.js';
import { engineProfileForKind } from '../render/pixi/engineGeometry.js';

const qs = new URLSearchParams(location.search);
type Arm = 'today' | 'flame' | 'ribbon' | 'both';
const ARM = (['today', 'flame', 'ribbon', 'both'].includes(qs.get('arm') ?? '') ? qs.get('arm') : 'both') as Arm;
const SCENE = (['flight', 'close', 'swarm'].includes(qs.get('scene') ?? '') ? qs.get('scene') : 'flight') as 'flight' | 'close' | 'swarm';
const FLAME = ARM === 'flame' || ARM === 'both';
const RIBBON = ARM === 'ribbon' || ARM === 'both';
const STEP = 1 / 60;

const THRUST_OUT = 0xff7a30, THRUST_CORE = 0xffe0b0, BOOST_OUT = 0x4f9dff, BOOST_CORE = 0xe2f4ff;

// ------------------------------------------------------------------ flight

/** Throttle program shared by every ship: [time, thrust 0..1, boost 0/1, speed u/s, turn rad/s]. */
const PROGRAM: Array<[number, number, number, number, number]> = [
  [0, 0, 0, 140, 0],
  [2, 1, 0, 140, 0],
  [5, 1, 1, 460, 0],
  [9, 1, 1, 900, -0.55],
  [11, 0, 0, 900, 0],
  [14, 0, 0, 560, 0],
];
const DURATION = 14;

interface Track { x: Float32Array; y: Float32Array; rot: Float32Array; thrust: Float32Array; boost: Float32Array; vx: Float32Array; vy: Float32Array }

/** Integrate one ship's path at 1/60 s from (x0, y0) heading +x. */
function integrate(x0: number, y0: number, delay: number): Track {
  const n = Math.ceil(DURATION / STEP) + 2;
  const tr: Track = { x: new Float32Array(n), y: new Float32Array(n), rot: new Float32Array(n), thrust: new Float32Array(n),
    boost: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n) };
  let x = x0, y = y0, head = 0, speed = PROGRAM[0]![3];
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, i * STEP - delay);
    let k = 0;
    while (k + 1 < PROGRAM.length && PROGRAM[k + 1]![0] <= t) k++;
    const a = PROGRAM[k]!, b = PROGRAM[Math.min(k + 1, PROGRAM.length - 1)]!;
    const f = b[0] > a[0] ? Math.min(1, (t - a[0]) / (b[0] - a[0])) : 0;
    // Speed eases toward the next key; thrust/boost/turn hold per segment.
    speed = a[3] + (b[3] - a[3]) * f;
    head += a[4] * STEP;
    const vx = Math.cos(head) * speed, vy = Math.sin(head) * speed;
    x += vx * STEP; y += vy * STEP;
    tr.x[i] = x; tr.y[i] = y; tr.rot[i] = head + Math.PI / 2;
    tr.thrust[i] = a[1]; tr.boost[i] = a[2]; tr.vx[i] = vx; tr.vy[i] = vy;
  }
  return tr;
}

interface ShipDef { kind: string; dx: number; dy: number; delay: number }
function shipsFor(scene: typeof SCENE): ShipDef[] {
  if (scene === 'close') return [{ kind: 'heavy', dx: 0, dy: -60, delay: 0 }, { kind: 'fighter', dx: -40, dy: 70, delay: 0 }];
  if (scene === 'swarm') {
    const kinds = ['fighter', 'interceptor', 'heavy', 'gunship', 'scout', 'missile-frigate'];
    const out: ShipDef[] = [];
    for (let i = 0; i < 24; i++) out.push({ kind: kinds[i % kinds.length]!, dx: (i % 6) * -150, dy: (Math.floor(i / 6) - 1.5) * 150, delay: (i % 5) * 0.4 });
    return out;
  }
  return [
    { kind: 'fighter', dx: 0, dy: -210, delay: 0 },
    { kind: 'interceptor', dx: -80, dy: -70, delay: 0.15 },
    { kind: 'heavy', dx: -40, dy: 80, delay: 0.3 },
    { kind: 'gunship', dx: -120, dy: 230, delay: 0.45 },
  ];
}

// ------------------------------------------------------------------ textures

function toTexture(i: Img, repeat = false): Texture {
  const c = document.createElement('canvas');
  c.width = i.w; c.height = i.h;
  c.getContext('2d')!.putImageData(new ImageData(i.data as Uint8ClampedArray<ArrayBuffer>, i.w, i.h), 0, 0);
  return new Texture({ source: new CanvasSource({ resource: c, scaleMode: 'linear', addressMode: repeat ? 'repeat' : 'clamp-to-edge' }) });
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const W = Number(qs.get('w') ?? window.innerWidth) | 0;
  const H = Number(qs.get('h') ?? window.innerHeight) | 0;
  const ZOOM = qs.has('zoom') ? Number(qs.get('zoom')) : SCENE === 'close' ? 2.2 : SCENE === 'swarm' ? 0.55 : 1.2;
  const app = new Application();
  await app.init({ width: W, height: H, background: 0x03050b, antialias: true, autoStart: false, preference: 'webgl', preserveDrawingBuffer: true });
  document.getElementById('host')!.appendChild(app.canvas);

  const defs = shipsFor(SCENE);
  const cache = new ArtCache();
  const rig = cache.rig;
  const jobs: BakeJob[] = defs.map((d) => ({ type: 'ship', id: d.kind }));
  await cache.prebake(jobs, 4, qs.get('persist') !== '0');

  const T = {
    glow: toTexture(glowTex(64)),
    flame: toTexture(flameTex(128, 32, 0)),
    core: toTexture(flameTex(128, 32, 1)),
    trail: toTexture(exhaustTrailTex(128, 16)),
    stars: toTexture(starTileTex(512, 260, 23, 1.0), true),
    starsFar: toTexture(starTileTex(512, 900, 11, 1.3), true),
  };

  // ---- layers
  const sky = new Container();
  const world = new Container();
  app.stage.addChild(sky, world);
  const L = (blend: BLEND_MODES = 'normal'): Container => { const c = new Container(); c.blendMode = blend; world.addChild(c); return c; };
  const trailL = L('add'), todayL = L(), flameL = L('add'), shipL = L(), glowL = L('add');
  const far = new TilingSprite({ texture: T.starsFar, width: W, height: H }); far.blendMode = 'add'; far.alpha = 0.8;
  const mid = new TilingSprite({ texture: T.stars, width: W, height: H }); mid.blendMode = 'add'; mid.alpha = 0.9;
  sky.addChild(far, mid);

  const sprite = (tex: Texture, layer: Container, ax = 0.5, ay = 0.5): Sprite => {
    const s = new Sprite(tex); s.anchor.set(ax, ay); s.alpha = 0; layer.addChild(s); return s;
  };

  // ---- ships
  interface NozzleV { r: number; lx: number; ly: number; flame: Sprite | null; core: Sprite | null; glow: Sprite; ring: ExhaustRing | null; rope: MeshRope | null; pts: Point[] }
  interface ShipV { id: string; def: ShipDef; tr: Track; art: ShipArt; a: Sprite; b: Sprite; nozzles: NozzleV[]; thrust: number; boost: number; phase: number }
  // ~0.33 s of history at 60 Hz (shorter under a flame).
  const RING = ARM === 'both' ? 16 : 20;
  const ships: ShipV[] = defs.map((d, i) => {
    const art = cache.machinedShip(d.kind);
    const a = new Sprite(art.frames[0]!), b = new Sprite(art.frames[0]!);
    a.anchor.set(0.5); b.anchor.set(0.5); a.scale.set(1 / art.density); b.scale.set(1 / art.density);
    shipL.addChild(a, b);
    const nozzles: NozzleV[] = ARM === 'today' ? [] : art.nozzles.map((nz) => {
      const pts: Point[] = [];
      let rope: MeshRope | null = null;
      if (RIBBON) {
        for (let k = 0; k < RING + 1; k++) pts.push(new Point());
        rope = new MeshRope({ texture: T.trail, points: pts, textureScale: 0, width: nz.r * 2.4 });
        rope.alpha = 0; trailL.addChild(rope);
      }
      return {
        r: nz.r, lx: nz.x, ly: nz.y + nz.r * 0.4,
        flame: FLAME ? sprite(T.flame, flameL, 0, 0.5) : null,
        core: FLAME ? sprite(T.core, flameL, 0, 0.5) : null,
        glow: sprite(T.glow, glowL),
        ring: RIBBON ? new ExhaustRing(RING) : null, rope, pts,
      };
    });
    return { id: `s${i}`, def: d, tr: integrate(d.dx, d.dy, d.delay), art, a, b, nozzles, thrust: 0, boost: 0, phase: i * 0.37 };
  });

  // ---- today's emitter (the game's own code)
  const emitter = ARM === 'today' ? new EngineEmitter(todayL, () => 'high', buildEngineFactories()) : null;
  const profiles = ships.map((s) => engineProfileForKind(s.def.kind));
  const poseOut = { x: 0, y: 0, angle: 0, vx: 0, vy: 0 };
  let simIdx = 0;
  const shipIndex = new Map(ships.map((s, i) => [s.id, i]));
  const getPose = (id: string): typeof poseOut | null => {
    const i = shipIndex.get(id); if (i === undefined) return null;
    const tr = ships[i]!.tr, k = simIdx;
    // Pixi → game space: y flips, sprite.rotation = -angle.
    poseOut.x = tr.x[k]!; poseOut.y = -tr.y[k]!; poseOut.angle = -tr.rot[k]!;
    poseOut.vx = tr.vx[k]!; poseOut.vy = -tr.vy[k]!;
    return poseOut;
  };

  // ---- simulation step (fixed 1/60)
  const nzPt = { x: 0, y: 0 };
  const local = (sv: ShipV, k: number, lx: number, ly: number): void => {
    const r = sv.tr.rot[k]!, c = Math.cos(r), s = Math.sin(r);
    nzPt.x = sv.tr.x[k]! + lx * c - ly * s; nzPt.y = sv.tr.y[k]! + lx * s + ly * c;
  };
  const stepSim = (k: number): void => {
    simIdx = k;
    for (let i = 0; i < ships.length; i++) {
      const sv = ships[i]!;
      sv.thrust = easeTo(sv.thrust, sv.tr.thrust[k]!, STEP, 0.12);
      sv.boost = easeTo(sv.boost, sv.tr.boost[k]!, STEP, 0.2);
      if (emitter) {
        emitter.setActive(sv.id, 'thrust', sv.tr.thrust[k]! > 0.5, profiles[i]);
        emitter.setActive(sv.id, 'boost', sv.tr.boost[k]! > 0.5, profiles[i]);
      }
      for (const nz of sv.nozzles) {
        if (!nz.ring) continue;
        local(sv, k, nz.lx, nz.ly);
        nz.ring.push(nzPt.x, nzPt.y);
      }
    }
    emitter?.tick(STEP, getPose);
  };
  let simK = -1;
  const resetSim = (): void => {
    simK = -1;
    for (const sv of ships) { sv.thrust = 0; sv.boost = 0; for (const nz of sv.nozzles) nz.ring?.reset(); }
    emitter?.resetForSectorHandoff();
  };

  // ---- draw
  const shape: FlameShape = { len: 0, wid: 0, alpha: 0 };
  const draw = (t: number): void => {
    const k = simK;
    // Camera follows the formation's centre, like the game's follow camera.
    let cx = 0, cy = 0;
    for (const sv of ships) { cx += sv.tr.x[k]!; cy += sv.tr.y[k]!; }
    cx = cx / ships.length - 60 / ZOOM; cy /= ships.length;
    world.scale.set(ZOOM);
    world.position.set(W / 2 - cx * ZOOM, H / 2 - cy * ZOOM);
    far.tilePosition.set(-cx * 0.02 * ZOOM, -cy * 0.02 * ZOOM);
    mid.tilePosition.set(-cx * 0.12 * ZOOM, -cy * 0.12 * ZOOM);
    for (const sv of ships) {
      const x = sv.tr.x[k]!, y = sv.tr.y[k]!, rot = sv.tr.rot[k]!;
      let u = ((rig.sunAz - rot) / (Math.PI * 2)) * SUN_STEPS;
      u = ((u % SUN_STEPS) + SUN_STEPS) % SUN_STEPS;
      const j0 = Math.floor(u);
      sv.a.texture = sv.art.frames[j0]!; sv.b.texture = sv.art.frames[(j0 + 1) % SUN_STEPS]!; sv.b.alpha = u - j0;
      sv.a.position.set(x, y); sv.b.position.set(x, y); sv.a.rotation = rot; sv.b.rotation = rot;
      const outT = exhaustTint(THRUST_OUT, BOOST_OUT, sv.boost), coreT = exhaustTint(THRUST_CORE, BOOST_CORE, sv.boost);
      // Astern in Pixi: the nose is local -y, so the tail points along +y turned by rot.
      const astern = rot + Math.PI / 2;
      for (let n = 0; n < sv.nozzles.length; n++) {
        const nz = sv.nozzles[n]!;
        local(sv, k, nz.lx, nz.ly);
        const flick = Math.sin(t * 53 + sv.phase * 17 + n * 2.3) * 0.6 + Math.sin(t * 31 + n) * 0.4;
        flameShape(nz.r, sv.thrust, sv.boost, flick, shape);
        nz.glow.position.set(nzPt.x, nzPt.y); nz.glow.tint = coreT;
        nz.glow.scale.set((nz.r * (2.4 + 1.6 * sv.thrust + 1.2 * sv.boost)) / 64 * 2);
        nz.glow.alpha = 0.35 + 0.5 * sv.thrust;
        if (nz.flame && nz.core) {
          nz.flame.position.set(nzPt.x, nzPt.y); nz.flame.rotation = astern; nz.flame.tint = outT;
          nz.flame.scale.set(shape.len / 128, shape.wid / 32); nz.flame.alpha = shape.alpha;
          nz.core.position.set(nzPt.x, nzPt.y); nz.core.rotation = astern; nz.core.tint = coreT;
          nz.core.scale.set((shape.len * 0.55) / 128, (shape.wid * 0.8) / 32); nz.core.alpha = Math.min(1, shape.alpha * 1.1);
        }
        if (nz.rope && nz.ring && nz.ring.length > 1) {
          nz.pts[0]!.set(nzPt.x, nzPt.y);
          for (let q = 1; q < nz.pts.length; q++) nz.pts[q]!.set(nz.ring.x(q - 1), nz.ring.y(q - 1));
          nz.rope.tint = outT;
          nz.rope.alpha = (ARM === 'both' ? 0.55 : 0.85) * (0.15 + 0.7 * sv.thrust + 0.15 * sv.boost);
        }
      }
    }
    app.render();
  };

  let curT = 0;
  const update = (t: number): void => {
    const target = Math.min(ships[0]!.tr.x.length - 1, Math.round(t / STEP));
    if (target < simK || target - simK > 90) {
      resetSim();
      for (let k = Math.max(0, target - 60); k <= target; k++) { stepSim(k); simK = k; }
    } else {
      for (let k = simK + 1; k <= target; k++) { stepSim(k); simK = k; }
    }
    curT = t;
    draw(t);
  };

  // ---- harness API (same shape as fx.ts)
  let drawCalls = 0;
  const gl = (app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
  if (gl) {
    const de = gl.drawElements.bind(gl), da = gl.drawArrays.bind(gl);
    gl.drawElements = ((...a: Parameters<typeof de>) => { drawCalls++; de(...a); }) as typeof gl.drawElements;
    gl.drawArrays = ((...a: Parameters<typeof da>) => { drawCalls++; da(...a); }) as typeof gl.drawArrays;
  }
  const api = {
    ready: true, arm: ARM, scene: SCENE, duration: DURATION,
    seek(ms: number): void { update(ms / 1000); },
    stats() {
      drawCalls = 0; draw(curT);
      return { arm: ARM, scene: SCENE, t: curT, drawCallsPerFrame: drawCalls, ships: ships.length,
        nozzles: ships.reduce((n, s) => n + s.nozzles.length, 0), particles: emitter?.activeCount().particles ?? 0 };
    },
    bench(ms: number): Promise<{ frames: number; cpuP50: number; cpuP95: number; drawCalls: number }> {
      return new Promise((resolve) => {
        const cpu: number[] = [];
        const start = performance.now();
        let t = 0, dc = 0;
        resetSim();
        const step = (): void => {
          drawCalls = 0;
          const c0 = performance.now();
          if (t >= DURATION) { t = 0; resetSim(); }
          update(t); t += STEP;
          gl?.finish();
          cpu.push(performance.now() - c0);
          dc = Math.max(dc, drawCalls);
          if (performance.now() - start < ms) requestAnimationFrame(step);
          else {
            const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; };
            resolve({ frames: cpu.length, cpuP50: q(cpu, 0.5), cpuP95: q(cpu, 0.95), drawCalls: dc });
          }
        };
        requestAnimationFrame(step);
      });
    },
  };
  (window as unknown as { __artlab: typeof api }).__artlab = api;
  update(0);
}

void main().catch((err: unknown) => {
  (window as unknown as { __artlabError: string }).__artlabError = String((err as Error)?.stack ?? err);
});

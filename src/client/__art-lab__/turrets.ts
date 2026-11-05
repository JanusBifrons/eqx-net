/**
 * Weapon turret lab (rnd/turrets). Dev-only.
 *
 *   /__art-lab__/turrets.html?arm=today|new&scene=lineup|sizes|defence|swarm&size=1|1.5|2&aim=all|active&w=&h=
 *
 * Every armed hull (and the structure defences) tracks a target that circles
 * it and fires at its weapon's cadence. Both arms draw identical shots; only
 * the barrels differ:
 *  - `today` — the game's own MountVisualManager (flat 2.4 × 20 u bars, the
 *    shot leaving 20 u from the pivot, as in the game);
 *  - `new`   — baked housings + barrels (turretFx) sized to the hull, with
 *    recoil, a muzzle flash, tip heat and beam / charge glows.
 * `sizes` shows one gunship at 1×, 1.5× and 2× (the "bigger ships" question).
 * Pixi space (y down); a hull's nose is local -y. Fixed 1/60 s simulation, so
 * a seek is frame-exact.
 */
import { Application, Container, Rectangle, Sprite, Texture, TilingSprite, CanvasSource, type BLEND_MODES } from 'pixi.js';
import { ArtCache, SUN_STEPS, type ShipArt } from './assets.js';
import { seedVariant, type BakeJob } from '../render/art/bake.js';
import { glowTex, starTileTex, streakTex, type Img } from '../render/art/fx/fxTextures.js';
import { familyFor, flashFrameAt, heatAfter, muzzleFlashFlipbook, recoilAt, turretBarrelTex, turretBaseTex, type TurretFamily } from '../render/art/fx/turretFx.js';
import { MountVisualManager } from '../render/MountVisualManager.js';
import { getShipKind, type WeaponMount } from '../../shared-types/shipKinds.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { getWeapon, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { shipPrimaryColor } from '../../core/geometry/shipHullOutline.js';
import { MUZZLE_CLEARANCE } from '../../core/combat/Weapons.js';

const qs = new URLSearchParams(location.search);
const ARM = qs.get('arm') === 'today' ? 'today' : 'new';
const NEW = ARM === 'new';
type SceneId = 'lineup' | 'sizes' | 'defence' | 'swarm';
const SCENE = (['lineup', 'sizes', 'defence', 'swarm'].includes(qs.get('scene') ?? '') ? qs.get('scene') : 'lineup') as SceneId;
const SIZE = Number(qs.get('size') ?? 1) || 1;
const AIM_ACTIVE = qs.get('aim') === 'active';
/** Debug: every unit at rotation 0 with its target straight ahead (-y). */
const FREEZE = qs.get('freeze') === '1';
const STEP = 1 / 60;
const DURATION = 12;

const SHOT_COLOR: Record<TurretFamily, number> = { bolt: 0xffc060, beam: 0x6fd0ff, missile: 0xffa050, charge: 0xd890ff };

// ------------------------------------------------------------------ scene

interface UnitDef { kind: string; struct: boolean; x: number; y: number; size: number; orbit: number; spin: number; phase: number }
function unitsFor(scene: SceneId): UnitDef[] {
  const ship = (kind: string, x: number, y: number, i: number, size = SIZE): UnitDef =>
    ({ kind, struct: false, x: x * size, y: y * size, size, orbit: 85 * size, spin: 0.8 + (i % 3) * 0.15, phase: i * 1.7 });
  if (scene === 'sizes') return [1, 1.5, 2].map((s, i) => ({ ...ship('gunship', 0, 0, i, s), x: [-170, 0, 210][i]!, y: 0, orbit: 70 * s }));
  if (scene === 'defence') {
    return ['turret', 'laser_bolt_turret', 'missile_turret', 'autocannon_turret'].map((k, i) => ({
      kind: k, struct: true, x: (i % 2 ? 1 : -1) * 280, y: (i < 2 ? -1 : 1) * 230, size: 1, orbit: 200, spin: 0.55 + i * 0.07, phase: i * 1.3,
    }));
  }
  if (scene === 'swarm') {
    const kinds = ['fighter', 'gunship', 'interceptor', 'missile-frigate', 'heavy', 'robot-circle'];
    const out: UnitDef[] = [];
    for (let i = 0; i < 24; i++) out.push(ship(kinds[i % kinds.length]!, ((i % 6) - 2.5) * 150, (Math.floor(i / 6) - 1.5) * 150, i));
    return out;
  }
  const kinds = ['fighter', 'gunship', 'interceptor', 'missile-frigate', 'heavy', 'robot-circle'];
  return kinds.map((k, i) => ship(k, ((i % 3) - 1) * 170, (Math.floor(i / 3) - 0.5) * 170, i));
}
const ZOOM = qs.has('zoom') ? Number(qs.get('zoom')) : SCENE === 'lineup' ? 2.3 / SIZE : SCENE === 'sizes' ? 2.0 : SCENE === 'defence' ? 0.95 : 0.75;

// ------------------------------------------------------------------ textures

function toTexture(i: Img, repeat = false): Texture {
  const c = document.createElement('canvas');
  c.width = i.w; c.height = i.h;
  c.getContext('2d')!.putImageData(new ImageData(i.data as Uint8ClampedArray<ArrayBuffer>, i.w, i.h), 0, 0);
  return new Texture({ source: new CanvasSource({ resource: c, scaleMode: 'linear', addressMode: repeat ? 'repeat' : 'clamp-to-edge' }) });
}

const angNorm = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

async function main(): Promise<void> {
  const W = Number(qs.get('w') ?? window.innerWidth) | 0;
  const H = Number(qs.get('h') ?? window.innerHeight) | 0;
  const app = new Application();
  await app.init({ width: W, height: H, background: 0x03050b, antialias: true, autoStart: false, preference: 'webgl', preserveDrawingBuffer: true });
  document.getElementById('host')!.appendChild(app.canvas);

  const defs = unitsFor(SCENE);
  const cache = new ArtCache();
  const rig = cache.rig;
  const jobs: BakeJob[] = [];
  for (const d of defs) jobs.push(d.struct ? { type: 'struct', id: d.kind, seed: seedVariant(1) } : { type: 'ship', id: d.kind });
  await cache.prebake(jobs, 4, qs.get('persist') !== '0');

  const fam: TurretFamily[] = ['bolt', 'beam', 'missile', 'charge'];
  const T = {
    base: Object.fromEntries(fam.map((f) => [f, toTexture(turretBaseTex(f, 64))])) as Record<TurretFamily, Texture>,
    barrel: Object.fromEntries(fam.map((f) => [f, toTexture(turretBarrelTex(f, 16, 64))])) as Record<TurretFamily, Texture>,
    flash: [] as Texture[],
    glow: toTexture(glowTex(64)),
    streak: toTexture(streakTex(128, 32)),
    stars: toTexture(starTileTex(512, 260, 23, 1.0), true),
  };
  {
    const fb = muzzleFlashFlipbook(4, 64);
    const base = toTexture(fb.sheet);
    for (let f = 0; f < fb.frames; f++) T.flash.push(new Texture({ source: base.source, frame: new Rectangle(f * fb.cell, 0, fb.cell, fb.cell) }));
  }

  // ---- layers
  const sky = new TilingSprite({ texture: T.stars, width: W, height: H }); sky.blendMode = 'add'; sky.alpha = 0.7;
  const world = new Container();
  app.stage.addChild(sky, world);
  const L = (blend: BLEND_MODES = 'normal'): Container => { const c = new Container(); c.blendMode = blend; world.addChild(c); return c; };
  const unitL = L(), shotL = L('add'), fxL = L('add');
  const mvm = new MountVisualManager();
  mvm.setAimLinesVisible(!AIM_ACTIVE);

  // ---- units
  interface MountV {
    m: WeaponMount; family: TurretFamily; cd: number; charge: boolean; speed: number;
    angle: number; cdLeft: number; lastShot: number; heat: number; beamUntil: number; chargeFrom: number;
    // new arm
    barrelPivot: Container | null; barrel: Sprite | null; flash: Sprite | null; tipGlow: Sprite | null; len: number; wid: number;
    // world muzzle this frame
    mx: number; my: number;
  }
  interface UnitV { d: UnitDef; c: Container; a: Sprite; b: Sprite | null; art: ShipArt | null; mounts: MountV[]; rot: number; tx: number; ty: number; radius: number }
  const units: UnitV[] = defs.map((d, ui) => {
    const c = new Container(); c.position.set(d.x, d.y); c.scale.set(d.size); unitL.addChild(c);
    let a: Sprite, b: Sprite | null = null, art: ShipArt | null = null, radius: number, mounts: readonly WeaponMount[], color: number;
    if (d.struct) {
      const st = cache.machinedStruct(d.kind, 1);
      a = new Sprite(st.tex); a.anchor.set(0.5); a.scale.set(1 / st.density); c.addChild(a);
      const sk = getStructureKind(d.kind);
      mounts = sk.mounts ?? []; color = sk.color;
      radius = Math.min(sk.footprint?.w ?? 140, sk.footprint?.h ?? 140) / 2;
    } else {
      art = cache.machinedShip(d.kind);
      a = new Sprite(art.frames[0]!); b = new Sprite(art.frames[0]!);
      a.anchor.set(0.5); b.anchor.set(0.5); a.scale.set(1 / art.density); b.scale.set(1 / art.density);
      c.addChild(a, b);
      const k = getShipKind(d.kind);
      mounts = k.mounts ?? []; color = shipPrimaryColor(k); radius = k.radius;
    }
    if (!NEW) mvm.ensureForMounts(`u${ui}`, d.kind, mounts, color, c);
    const mv: MountV[] = mounts.map((m) => {
      const w = getWeapon(m.weaponId as WeaponId);
      const charge = w.mode === 'hitscan' && (w.chargeTicks ?? 0) > 0;
      const family = familyFor(m.weaponId, w.mode, charge);
      const centre = m.localX === 0 && m.localY === 0 && !d.struct;
      // New sizes: structures scale with their footprint; a turning ship
      // mount with its housing; a fixed centre gun is a short chin barrel
      // ending at today's 20 u muzzle (no server change needed for those).
      const rack = family === 'missile';
      const len = d.struct ? radius * (rack ? 0.4 : 0.62) : centre ? 9 : rack ? Math.max(5, radius * 0.3) : Math.max(7, radius * 0.75);
      const wid = d.struct ? radius * (rack ? 0.22 : 0.16) : rack ? Math.max(2.4, radius * 0.12) : Math.max(2.2, radius * 0.2);
      const v: MountV = {
        m, family, cd: Math.max(0.22, w.cooldownTicks / 60), charge, speed: w.mode === 'hitscan' ? 0 : Math.min(700, (w as { speed: number }).speed),
        angle: 0, cdLeft: 0.3 + ui * 0.07, lastShot: -9, heat: 0, beamUntil: -1, chargeFrom: -1,
        barrelPivot: null, barrel: null, flash: null, tipGlow: null, len, wid, mx: 0, my: 0,
      };
      if (NEW) {
        const px = m.localX, py = -m.localY - (centre ? MUZZLE_CLEARANCE - len : 0);
        if (!centre || d.struct) {
          const hr = d.struct ? radius * 0.42 : Math.max(3.2, wid * (rack ? 1.3 : 1.7));
          const base = new Sprite(T.base[family]); base.anchor.set(0.5); base.position.set(px, py);
          base.scale.set((hr * 2) / 64); base.rotation = -m.baseAngle; c.addChild(base);
        }
        const pivot = new Container(); pivot.position.set(px, py); c.addChild(pivot);
        const bar = new Sprite(T.barrel[family]); bar.anchor.set(0.5, 1); bar.scale.set(wid / (16 * 0.6), len / 64); pivot.addChild(bar);
        const flash = new Sprite(T.flash[0]!); flash.anchor.set(0.5, 1); flash.blendMode = 'add'; flash.tint = SHOT_COLOR[family]; flash.visible = false; pivot.addChild(flash);
        const tip = new Sprite(T.glow); tip.anchor.set(0.5); tip.blendMode = 'add'; tip.tint = family === 'bolt' ? 0xff6a2a : SHOT_COLOR[family]; tip.alpha = 0; pivot.addChild(tip);
        v.barrelPivot = pivot; v.barrel = bar; v.flash = flash; v.tipGlow = tip;
      }
      return v;
    });
    return { d, c, a, b, art, mounts: mv, rot: 0, tx: 0, ty: 0, radius };
  });
  const mountLists = units.map((u) => u.mounts.map((m) => m.m));
  const angleLists = units.map((u) => u.mounts.map(() => 0));

  // ---- shots (shared by both arms)
  interface Shot { s: Sprite; kind: 'bolt' | 'missile'; x: number; y: number; vx: number; vy: number; life: number; age: number }
  const shots: Shot[] = [];
  const freeShots: Shot[] = [];
  const beams: Sprite[] = units.flatMap((u) => u.mounts.map(() => { const s = new Sprite(T.streak); s.anchor.set(0, 0.5); s.visible = false; shotL.addChild(s); return s; }));
  const glows: Sprite[] = units.flatMap((u) => u.mounts.map(() => { const s = new Sprite(T.glow); s.anchor.set(0.5); s.visible = false; fxL.addChild(s); return s; }));
  const spawnShot = (kind: 'bolt' | 'missile', x: number, y: number, dirX: number, dirY: number, speed: number, color: number, scale: number): void => {
    const sh = freeShots.pop() ?? (() => { const s = new Sprite(kind === 'bolt' ? T.streak : T.glow); s.anchor.set(0.5); shotL.addChild(s); return { s, kind, x: 0, y: 0, vx: 0, vy: 0, life: 0, age: 0 }; })();
    sh.kind = kind; sh.s.texture = kind === 'bolt' ? T.streak : T.glow;
    sh.x = x; sh.y = y; sh.vx = dirX * speed; sh.vy = dirY * speed; sh.age = 0; sh.life = kind === 'bolt' ? 0.45 : 0.9;
    sh.s.visible = true; sh.s.tint = color; sh.s.rotation = Math.atan2(dirY, dirX);
    sh.s.scale.set(kind === 'bolt' ? (16 * scale) / 128 : (9 * scale) / 64, kind === 'bolt' ? (5 * scale) / 32 : (9 * scale) / 64);
    shots.push(sh);
  };

  // ---- simulation
  const muzzleOf = (u: UnitV, mv: MountV): void => {
    // Mount pivot in world, then along the barrel to its tip.
    const c = Math.cos(u.rot), s = Math.sin(u.rot), z = u.d.size;
    const centre = mv.m.localX === 0 && mv.m.localY === 0 && !u.d.struct;
    const lx = mv.m.localX, ly = -mv.m.localY;
    const px = u.d.x + (lx * c - ly * s) * z, py = u.d.y + (lx * s + ly * c) * z;
    const rho = u.rot - (mv.m.baseAngle + mv.angle);
    // Today and fixed centre guns: the muzzle is 20 u out (the game's
    // MUZZLE_CLEARANCE); new turning barrels end at their own tip.
    const reach = (!NEW || centre ? MUZZLE_CLEARANCE : mv.len) * z;
    mv.mx = px + Math.sin(rho) * reach; mv.my = py - Math.cos(rho) * reach;
  };
  let simT = 0;
  const stepSim = (t: number): void => {
    simT = t;
    for (const u of units) {
      // Target circles the unit.
      const ta = u.d.phase + t * u.d.spin;
      u.tx = u.d.x + Math.cos(ta) * u.d.orbit; u.ty = u.d.y + Math.sin(ta) * u.d.orbit * 0.8;
      if (FREEZE) { u.tx = u.d.x; u.ty = u.d.y - u.d.orbit; }
      if (!u.d.struct && !FREEZE) {
        // Ships turn their nose toward it (so fixed guns get shots in).
        const want = Math.atan2(u.tx - u.d.x, -(u.ty - u.d.y));
        const err = angNorm(want - u.rot);
        u.rot += Math.max(-1.1 * STEP, Math.min(1.1 * STEP, err));
      }
      for (const mv of u.mounts) {
        muzzleOf(u, mv);
        // Aim: barrel world rotation = rot - (base + angle).
        const want = Math.atan2(u.tx - mv.mx, -(u.ty - mv.my));
        const desired = angNorm(u.rot - want - mv.m.baseAngle);
        const clamped = Math.max(mv.m.arcMin, Math.min(mv.m.arcMax, desired));
        const slew = mv.m.rotationSpeed * STEP;
        mv.angle += Math.max(-slew, Math.min(slew, angNorm(clamped - mv.angle)));
        const aimErr = Math.abs(angNorm(u.rot - (mv.m.baseAngle + mv.angle) - want));
        mv.cdLeft -= STEP;
        let fired = 0;
        if (aimErr < 0.12 && mv.cdLeft <= 0) {
          mv.cdLeft = mv.family === 'beam' ? 1.4 : mv.cd;
          muzzleOf(u, mv);
          const rho = u.rot - (mv.m.baseAngle + mv.angle);
          const dx = Math.sin(rho), dy = -Math.cos(rho);
          if (mv.family === 'beam') { mv.beamUntil = t + 0.8; mv.lastShot = t; }
          else if (mv.family === 'charge') { mv.chargeFrom = t; mv.lastShot = t + 0.45; mv.beamUntil = t + 0.75; }
          else { spawnShot(mv.family === 'missile' ? 'missile' : 'bolt', mv.mx, mv.my, dx, dy, mv.family === 'missile' ? 260 : mv.speed, SHOT_COLOR[mv.family], u.d.struct ? 2.4 : u.d.size); mv.lastShot = t; fired = 1; }
        }
        mv.heat = heatAfter(mv.heat, STEP, fired + (t < mv.beamUntil && t >= mv.lastShot ? STEP * 1.2 : 0));
      }
    }
    for (let i = shots.length - 1; i >= 0; i--) {
      const sh = shots[i]!;
      sh.age += STEP; sh.x += sh.vx * STEP; sh.y += sh.vy * STEP;
      if (sh.age >= sh.life) { sh.s.visible = false; shots.splice(i, 1); freeShots.push(sh); }
    }
  };
  let simK = -1;
  const resetSim = (): void => {
    simK = -1;
    for (const u of units) { u.rot = 0; for (const mv of u.mounts) { mv.angle = 0; mv.cdLeft = 0.3; mv.heat = 0; mv.lastShot = -9; mv.beamUntil = -1; mv.chargeFrom = -1; } }
    for (const sh of shots) { sh.s.visible = false; freeShots.push(sh); }
    shots.length = 0;
  };

  // ---- draw
  const draw = (): void => {
    const t = simT;
    world.scale.set(ZOOM);
    world.position.set(W / 2, H / 2);
    sky.tilePosition.set(0, 0);
    let bi = 0;
    for (let ui = 0; ui < units.length; ui++) {
      const u = units[ui]!;
      u.c.rotation = u.rot;
      if (u.art && u.b) {
        let s = ((rig.sunAz - u.rot) / (Math.PI * 2)) * SUN_STEPS;
        s = ((s % SUN_STEPS) + SUN_STEPS) % SUN_STEPS;
        const j0 = Math.floor(s);
        u.a.texture = u.art.frames[j0]!; u.b.texture = u.art.frames[(j0 + 1) % SUN_STEPS]!; u.b.alpha = s - j0;
      }
      const angles = angleLists[ui]!;
      for (let k = 0; k < u.mounts.length; k++) {
        const mv = u.mounts[k]!;
        angles[k] = mv.angle;
        muzzleOf(u, mv);
        const beam = beams[bi]!, glow = glows[bi]!; bi++;
        const beamOn = t >= mv.lastShot && t < mv.beamUntil;
        // Shared shots: the beam from the muzzle to the target.
        if (beamOn) {
          const dx = u.tx - mv.mx, dy = u.ty - mv.my, len = Math.hypot(dx, dy);
          beam.visible = true; beam.position.set(mv.mx, mv.my); beam.rotation = Math.atan2(dy, dx);
          beam.scale.set(len / 128, ((u.d.struct ? 9 : 4) * u.d.size) / 32); beam.tint = SHOT_COLOR[mv.family];
          beam.alpha = 0.9;
        } else beam.visible = false;
        // The new arm's reactions.
        if (NEW && mv.barrelPivot && mv.barrel && mv.flash && mv.tipGlow) {
          mv.barrelPivot.rotation = -(mv.m.baseAngle + mv.angle);
          const since = t - mv.lastShot;
          const kick = mv.family === 'bolt' || mv.family === 'missile' ? recoilAt(since) * mv.len * (mv.family === 'missile' ? 0.08 : 0.22) : 0;
          mv.barrel.y = kick;
          const fr = mv.family === 'bolt' || mv.family === 'missile' ? flashFrameAt(since, T.flash.length) : -1;
          if (fr >= 0) { mv.flash.visible = true; mv.flash.texture = T.flash[fr]!; mv.flash.y = -mv.len + kick; mv.flash.scale.set((mv.wid * 3.2) / 64, (mv.wid * 4.2) / 64); }
          else mv.flash.visible = false;
          // Tip heat (bolts), the emitter glow while a beam holds, the charge wind-up.
          let ga = mv.family === 'bolt' ? mv.heat * 0.8 : 0;
          if (beamOn) ga = 0.9;
          if (mv.family === 'charge' && t >= mv.chargeFrom && t < mv.lastShot) ga = (t - mv.chargeFrom) / (mv.lastShot - mv.chargeFrom);
          mv.tipGlow.alpha = ga; mv.tipGlow.y = -mv.len + kick;
          mv.tipGlow.scale.set((mv.wid * (mv.family === 'bolt' ? 1.6 : 3)) / 64 * (1 + 0.4 * ga));
          glow.visible = false;
        } else {
          // Today: only the game's existing muzzle glow while a beam holds.
          glow.visible = beamOn; glow.position.set(mv.mx, mv.my); glow.tint = SHOT_COLOR[mv.family];
          glow.scale.set((14 * u.d.size) / 64); glow.alpha = 0.7;
        }
      }
      if (!NEW) mvm.applyMountAngles(`u${ui}`, mountLists[ui]!, angles);
    }
    for (const sh of shots) { sh.s.position.set(sh.x, sh.y); sh.s.alpha = sh.kind === 'bolt' ? 1 : 1 - sh.age / sh.life * 0.5; }
    app.render();
  };

  let curT = 0;
  const update = (t: number): void => {
    const target = Math.round(t / STEP);
    if (target < simK || target - simK > 120) { resetSim(); for (let k = 0; k <= target; k++) { stepSim(k * STEP); simK = k; } }
    else for (let k = simK + 1; k <= target; k++) { stepSim(k * STEP); simK = k; }
    curT = t;
    draw();
  };

  // ---- harness API (same shape as engines.ts)
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
    stats() { drawCalls = 0; draw(); return { arm: ARM, scene: SCENE, t: curT, drawCallsPerFrame: drawCalls, units: units.length, mounts: units.reduce((n, u) => n + u.mounts.length, 0) }; },
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

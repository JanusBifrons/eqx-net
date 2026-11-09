/**
 * Warp-to visuals (plan prancy-squishing-donut Phase 4, step 4c). Cheap
 * sprites only: the old WarpFilterChain shader effects are not used here.
 *
 * Driven by each ship's warp phase on the render mirror (`ShipRenderState.warp`:
 * 1 spool, 2 run; the local ship's is its predicted phase) and the ship's
 * resolved sprite pose (Pixi space, never re-interpolated):
 *
 *  - SPOOL: drawn by WarpSpoolFx (the engines overcharge).
 *  - ENGAGE (1→2): a flash at the engines, a hull streak shooting out along
 *    the run (the blur of the acceleration) and two burning engine trails left
 *    on the path that flicker and burn out (the "Back to the Future" look). An
 *    onlooker sees the ship zip out of view.
 *  - RUN, own ship: speed lines rush past and a streak trails the hull.
 *  - DROP (2→idle): a flash, a reverse streak and short trails where it lands.
 *
 * Sizes have an on-screen floor (`px` = world units per screen pixel), so the
 * effect still reads zoomed far out. All objects are pooled and reused; per
 * frame only scalar writes (#14).
 */
import { Container, Graphics, Sprite, Texture } from 'pixi.js';

/** Engine trails: reach along the path (world u), grow time, burn time (s). */
const TRAIL_LEN = 1600;
const TRAIL_GROW_S = 0.15;
const TRAIL_LIFE_S = 2.2;
/** Trail segments; each fades a little more towards the far end. */
/** 12 segments: with 5, the brightness steps showed along a capital's 28 km
 *  trail (fleet film review). */
const SEGS = 12;
const STREAK_LEN = 1400;
const STREAK_LIFE_S = 0.35;
const FLASH_LIFE_S = 0.3;
const ARRIVE_STREAK_LEN = 160;
const ARRIVE_TRAIL_LEN = 160;
const ARRIVE_LIFE_S = 0.6;
const SPEED_LINES = 28;
const FIRE_CORE = 0xffe6a8, FIRE_OUT = 0xff6a1c, STREAK = 0xcfe4ff;
/** Glow discs are drawn at this radius (fine tessellation) and scaled down. */
const GLOW_R = 256;

/** Effect proportions for a ship whose stern sits `stern` u behind its centre. */
export interface WarpFxSizes {
  trailLen: number; streakLen: number; arriveLen: number;
  /** Multiples of the stern. */
  gapK: number; coreK: number; outK: number; streakK: number; flashK: number;
  /** Seconds for the departure trail to reach full length (a capital's long
   *  trail visibly shoots out instead of appearing at once). */
  growS: number;
}

/**
 * W2c — warp effects at any ship size. Up to fighter size (stern ≤ 80 u)
 * these are exactly the original numbers. A capital (stern in the thousands)
 * used fixed fighter lengths with stern-sized widths: its trails came out
 * shorter than they were wide (blocky rectangles), 2 km apart, and its flash
 * ~9 km across. Bigger ships get lengths that grow with the hull and widths
 * that shrink relative to it (a long thin hull), reaching full scale by
 * stern 800 u. Pure (tests).
 */
export function warpFxSizes(stern: number): WarpFxSizes {
  const big = Math.max(0, Math.min(1, (stern - 80) / 720));
  return {
    trailLen: Math.max(TRAIL_LEN, stern * 10 * big),
    streakLen: Math.max(STREAK_LEN, stern * 6 * big),
    arriveLen: Math.max(ARRIVE_TRAIL_LEN, stern * 1.5 * big),
    // A capital's engines sit close together at the stern of a long thin
    // hull: trails a few percent of the stern apart, thin, and a streak no
    // taller than its engines (round 2 review: boxes at the hull edges).
    gapK: 0.4 - 0.37 * big,
    coreK: 0.06 - 0.052 * big,
    outK: 0.2 - 0.18 * big,
    streakK: 0.8 - 0.785 * big,
    flashK: 1 - 0.82 * big,
    growS: TRAIL_GROW_S + 0.45 * big,
  };
}

/** A smooth radial falloff (white → clear), radius GLOW_R, built once on a
 *  canvas; null where there is no canvas (unit tests). Stacked rings showed
 *  as stepped bands at capital size (fleet film review). */
let glowTex: Texture | null | undefined;
function glowTexture(): Texture | null {
  if (glowTex !== undefined) return glowTex;
  glowTex = null;
  const C = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas }).OffscreenCanvas;
  if (!C) return null;
  const cv = new C(GLOW_R * 2, GLOW_R * 2);
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const grad = ctx.createRadialGradient(GLOW_R, GLOW_R, 0, GLOW_R, GLOW_R, GLOW_R);
  // The old 14-ring stack's profile (alpha ≈ 0.98 · (1 − r)), smoothed.
  for (let i = 0; i <= 16; i++) { const t = i / 16; grad.addColorStop(t, `rgba(255,255,255,${(0.98 * (1 - t) ** 1.15).toFixed(3)})`); }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, GLOW_R * 2, GLOW_R * 2);
  glowTex = Texture.from(cv as unknown as HTMLCanvasElement);
  return glowTex;
}

/** A soft round glow, built once and scaled (centre at 0,0, radius GLOW_R). */
function glowGfx(color: number): Container {
  const tex = glowTexture();
  if (tex) {
    const sp = new Sprite(tex);
    sp.anchor.set(0.5);
    sp.tint = color;
    sp.blendMode = 'add';
    return sp;
  }
  const g = new Graphics();
  // 14 fine rings (same total as the old 7 at 0.14): at capital size the
  // coarse rings showed as hard bands.
  // Drawn at radius GLOW_R (scaled by 1/GLOW_R in place()): a unit circle is
  // tessellated with ~8 sides, which showed as octagons at capital size.
  const rings = 14;
  for (let i = rings; i >= 1; i--) g.circle(0, 0, (GLOW_R * i) / rings).fill({ color, alpha: 0.07 });
  g.blendMode = 'add';
  return g;
}
/** A 1×1 white sprite anchored on its left edge; scaled into a line. */
function bar(color: number): Sprite {
  const s = new Sprite(Texture.WHITE);
  s.anchor.set(0, 0.5);
  s.tint = color;
  s.blendMode = 'add';
  return s;
}

interface ShipWarpView {
  phase: 0 | 1 | 2;
  /** The arrival (3) was already drawn for this drop. */
  arrivedDrawn: boolean;
  spoolStart: number;
  /** Pose while spooling (Pixi space): where a departure starts, and the
   *  heading it leaves on (the spool turns the ship to face its target). */
  sx: number; sy: number; srot: number;
  /** The ship's stern distance (for a departure drawn after it vanished). */
  stern: number;
  gen: number;
  streak: Sprite;
}

interface Burst {
  kind: 'depart' | 'arrive';
  t0: number;
  /** Start point and unit direction (Pixi space). */
  x: number; y: number; dx: number; dy: number;
  /** Ship stern distance, world u. */
  stern: number;
  root: Container;
  /** [side * SEGS + seg]: two trails, SEGS pieces each. */
  core: Sprite[]; out: Sprite[];
  streak: Sprite; flash: Container;
  live: boolean;
  /** The pilot's own departure: its trails only reach as far as the ship has
   *  flown (it accelerates away behind them, never past them). */
  follow: boolean;
}

export interface WarpFxShip {
  /** Sprite pose (Pixi space). */
  x: number; y: number; rotation: number;
  /** Phase from the mirror: undefined idle, 1 spool, 2 run, 3 just dropped out. */
  warp: 1 | 2 | 3 | undefined;
  /** Stern distance from the centre, world u (engineProfileForKind). */
  stern: number;
  isLocal: boolean;
}

export class WarpFx {
  /** Under the hulls: trails, streaks, glows. */
  readonly layer = new Container();
  private readonly ships = new Map<string, ShipWarpView>();
  private readonly bursts: Burst[] = [];
  private readonly lines: Sprite[] = [];
  private readonly linePhase: number[] = [];
  private gen = 0;
  private now = 0;
  /** World units per screen pixel this frame. */
  private px = 1;
  private activeBursts = 0;
  /** Speed-line fade (0..1) and the run's direction for them. */
  private lineFade = 0;
  private lineLastT = 0;
  private lineFx = 0;
  private lineFy = -1;
  private spooling = 0;

  constructor() {
    this.layer.eventMode = 'none';
    // Deterministic speed-line layout (no Math.random: same look every run).
    let s = 0x9e3779b9;
    const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
    for (let i = 0; i < SPEED_LINES; i++) {
      const l = bar(0xffffff);
      l.visible = false;
      this.layer.addChild(l);
      this.lines.push(l);
      this.linePhase.push(rnd());
    }
  }

  /** `scale` = world zoom (screen px per world u). */
  beginFrame(nowMs: number, scale = 1): void {
    this.gen++;
    this.now = nowMs / 1000;
    this.px = 1 / Math.max(0.02, scale);
    this.spooling = 0;
  }

  /** One ship per frame. */
  draw(id: string, ship: WarpFxShip): void {
    let v = this.ships.get(id);
    if (!v) {
      v = this.newView();
      this.ships.set(id, v);
    }
    v.gen = this.gen;
    if (ship.isLocal) { this.localX = ship.x; this.localY = ship.y; }
    const raw = ship.warp ?? 0;
    const phase: 0 | 1 | 2 = raw === 3 ? 0 : raw;
    const fx = Math.sin(ship.rotation), fy = -Math.cos(ship.rotation); // nose direction (Pixi)
    if (phase !== v.phase) {
      if (phase === 1) v.spoolStart = this.now;
      if (phase === 2) {
        // Engage: leave from where it spooled, along the heading it had while
        // spooling (aligned to its target). The pose on this frame is
        // unreliable: another pilot's ship on its run has no prediction body,
        // so its mirror falls back to a stale position and heading.
        const spooled = v.phase === 1;
        const dx = spooled ? Math.sin(v.srot) : fx, dy = spooled ? -Math.cos(v.srot) : fy;
        const ox = v.phase === 1 ? v.sx : ship.x, oy = v.phase === 1 ? v.sy : ship.y;
        this.spawn('depart', ox - dx * ship.stern, oy - dy * ship.stern, dx, dy, ship.stern, ship.isLocal);
      }
      if (phase === 0 && v.phase === 2) { this.spawn('arrive', ship.x - fx * ship.stern, ship.y - fy * ship.stern, fx, fy, ship.stern); v.arrivedDrawn = true; }
      v.phase = phase;
    }
    // Another pilot just dropped out here (snapshot 3): draw the arrival once.
    if (raw === 3 && !v.arrivedDrawn) { this.spawn('arrive', ship.x - fx * ship.stern, ship.y - fy * ship.stern, fx, fy, ship.stern); v.arrivedDrawn = true; }
    if (raw !== 3 && phase !== 0) v.arrivedDrawn = false;
    const px = this.px;
    if (phase === 1) {
      v.sx = ship.x; v.sy = ship.y; v.srot = ship.rotation; v.stern = ship.stern;
      this.spooling++;
    }
    if (phase === 2 && ship.isLocal) {
      // A hull streak trailing the pilot's own ship while it runs (others'
      // ships are out of the world on the run).
      const len = ship.isLocal ? 600 * px : 900 * px;
      line(v.streak, ship.x - fx * ship.stern * 0.5, ship.y - fy * ship.stern * 0.5, Math.atan2(-fy, -fx), len, Math.max(ship.stern * 0.6, px * 3), 0.22);
      if (ship.isLocal) { this.lineFx = fx; this.lineFy = fy; }
    } else {
      v.streak.visible = false;
    }
    if (ship.isLocal) {
      // Speed lines ease in with the run (0.4 s) and out after it (0.35 s),
      // so the drop never cuts them off in one frame.
      const dt = Math.min(0.1, Math.max(0, this.now - this.lineLastT));
      this.lineLastT = this.now;
      this.lineFade = phase === 2 ? Math.min(1, this.lineFade + dt / 0.4) : Math.max(0, this.lineFade - dt / 0.35);
      if (this.lineFade > 0) this.drawSpeedLines(ship.x, ship.y, this.lineFx, this.lineFy);
      else for (const l of this.lines) l.visible = false;
    }
  }

  endFrame(): void {
    for (const [id, v] of this.ships) {
      if (v.gen === this.gen) continue;
      // Gone mid-spool: it left for another sector. Draw its departure along
      // the spool heading, where it stood.
      if (v.phase === 1) {
        const dx = Math.sin(v.srot), dy = -Math.cos(v.srot);
        this.spawn('depart', v.sx - dx * v.stern, v.sy - dy * v.stern, dx, dy, v.stern);
      }
      v.streak.destroy();
      this.ships.delete(id);
    }
    let live = 0;
    for (const b of this.bursts) {
      if (!b.live) continue;
      if (this.stepBurst(b)) live++;
    }
    this.activeBursts = live;
  }

  /** Live departure/arrival effects (diagnostic / E2E). */
  burstCount(): number { return this.activeBursts; }
  /** Longest departure trail reach this frame (diagnostic / tests). */
  departReach(): number { return this.lastDepartReach; }
  private lastDepartReach = 0;
  /** The pilot's own ship position this frame (Pixi space). */
  private localX = 0;
  private localY = 0;
  /** Direction of the last burst spawned (diagnostic / tests). */
  lastBurstDir(): { x: number; y: number } { return this.lastDir; }
  private readonly lastDir = { x: 0, y: 0 };
  /** Ships spooling this frame (diagnostic / E2E). */
  spoolCount(): number { return this.spooling; }

  private newView(): ShipWarpView {
    const streak = bar(STREAK);
    streak.visible = false;
    this.layer.addChild(streak);
    return { phase: 0, arrivedDrawn: false, spoolStart: 0, sx: 0, sy: 0, srot: 0, stern: 0, gen: 0, streak };
  }

  private spawn(kind: 'depart' | 'arrive', x: number, y: number, dx: number, dy: number, stern: number, follow = false): void {
    let b: Burst | undefined;
    for (const q of this.bursts) if (!q.live) { b = q; break; }
    if (!b) {
      const root = new Container();
      const core: Sprite[] = [], out: Sprite[] = [];
      for (let i = 0; i < 2 * SEGS; i++) { out.push(bar(FIRE_OUT)); core.push(bar(FIRE_CORE)); }
      const streak = bar(STREAK), flash = glowGfx(0xfff4dc);
      root.addChild(...out, ...core, streak, flash);
      this.layer.addChild(root);
      b = { kind, t0: 0, x: 0, y: 0, dx: 0, dy: 0, stern: 0, root, core, out, streak, flash, live: false, follow: false };
      this.bursts.push(b);
    }
    this.lastDir.x = dx; this.lastDir.y = dy;
    b.follow = follow;
    b.kind = kind; b.t0 = this.now; b.x = x; b.y = y; b.dx = dx; b.dy = dy; b.stern = Math.max(4, stern); b.live = true;
    b.root.visible = true;
    this.stepBurst(b);
  }

  /** Advance one burst; false once it has burnt out (pooled again). */
  private stepBurst(b: Burst): boolean {
    const t = this.now - b.t0;
    const depart = b.kind === 'depart';
    const life = depart ? TRAIL_LIFE_S : ARRIVE_LIFE_S;
    if (t >= life) { b.live = false; b.root.visible = false; return false; }
    const px = this.px;
    const ang = Math.atan2(b.dy, b.dx);
    const sz = warpFxSizes(b.stern);
    const gap = Math.max(b.stern * sz.gapK, px * 4);
    const nx = -b.dy * gap, ny = b.dx * gap;
    const fade = 1 - t / life;
    // Trails reach out fast (the acceleration), then hold and burn down.
    let reach = depart ? sz.trailLen * Math.min(1, t / sz.growS) : sz.arriveLen;
    // The pilot's own ship accelerates away: its trails stop at its stern.
    const flown = depart && b.follow ? Math.max(0, (this.localX - b.x) * b.dx + (this.localY - b.y) * b.dy) : Infinity;
    if (reach > flown) reach = flown;
    if (depart) this.lastDepartReach = reach;
    // Arrival trails lie BEHIND the ship (it came from there).
    const sx = depart ? b.x : b.x - b.dx * reach, sy = depart ? b.y : b.y - b.dy * reach;
    const coreW = Math.max(b.stern * sz.coreK, px * 1.2);
    const outW = Math.max(b.stern * sz.outK, px * 3.5);
    const seg = reach / SEGS;
    for (let side = 0; side < 2; side++) {
      const ox = side === 0 ? nx : -nx, oy = side === 0 ? ny : -ny;
      for (let k = 0; k < SEGS; k++) {
        // Departure: hottest at the start (where it lit), fading along the run.
        // Arrival: hottest at the ship, fading behind it.
        const along = depart ? k / SEGS : 1 - (k + 1) / SEGS;
        const heat = 1 - 0.75 * along;
        const x0 = sx + b.dx * seg * k + ox, y0 = sy + b.dy * seg * k + oy;
        const f = flick(t, side * 7 + k);
        const i = side * SEGS + k;
        const soft = depart ? 1 : 0.6; // arrival trails: a softer touch
        line(b.out[i]!, x0, y0, ang, seg, outW, 0.22 * soft * heat * fade * fade * f);
        line(b.core[i]!, x0, y0, ang, seg, coreW, 0.6 * soft * heat * fade * f);
      }
    }
    // The blur streak: shoots out along the run and fades fast.
    const st = Math.min(1, t / STREAK_LIFE_S);
    const sw = Math.max(b.stern * sz.streakK, px * 4);
    if (depart) line(b.streak, b.x, b.y, ang, Math.min(flown, sz.streakLen * (0.3 + 0.7 * st)), sw, 0.4 * (1 - st));
    else {
      const l = Math.max(ARRIVE_STREAK_LEN, sz.arriveLen) * (1 - st);
      line(b.streak, b.x - b.dx * l, b.y - b.dy * l, ang, l, sw * 0.7, 0.22 * (1 - st));
    }
    const ft = Math.min(1, t / FLASH_LIFE_S);
    // The arrival flash is the only sign of a ship dropping in: a touch bigger and brighter.
    // (Not bigger for a capital: its arrival flash spilled across the frame.)
    const fa = depart ? 0.6 : 0.9, fr = depart || sz.flashK < 0.9 ? 1 : 1.4;
    place(b.flash, b.x, b.y, Math.max(b.stern * sz.flashK * (1 + 2 * ft), px * (6 + 12 * ft)) * fr, fa * (1 - ft));
    return true;
  }

  private drawSpeedLines(x: number, y: number, fx: number, fy: number): void {
    const span = 1100 * this.px;
    const ang = Math.atan2(-fy, -fx);
    for (let i = 0; i < SPEED_LINES; i++) {
      // Each line runs from ahead of the ship to behind it, then wraps.
      // Each pass takes a new lane, so the view never repeats (phone report
      // 2026-11-07: "the same star kept flying past ... in the same spot").
      const t = this.linePhase[i]! + this.now * 2.2;
      const p = t - Math.floor(t);
      const lane = speedLineLane(i, Math.floor(t));
      const along = span * (1 - 2 * p);
      const lat = lane.lat * span * 0.9;
      line(this.lines[i]!, x + fx * along - fy * lat, y + fy * along + fx * lat, ang, span * lane.len, 1.6 * this.px, 0.35 * Math.sin(p * Math.PI) * this.lineFade);
    }
  }
}

const laneScratch = { lat: 0, len: 0 };
/**
 * Speed line `i`'s lane on pass `pass`: lateral offset (-1..1 of the view)
 * and length (fraction of the span). Hashed, so each pass is new but every run
 * looks the same. Returns a reused object (read it before the next call).
 */
export function speedLineLane(i: number, pass: number): { lat: number; len: number } {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(pass + 7, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  const u = (h >>> 0) / 0x100000000;
  const v = (Math.imul(h, 0x165667b1) >>> 0) / 0x100000000;
  laneScratch.lat = u * 2 - 1;
  laneScratch.len = 0.25 + v * 0.55;
  return laneScratch;
}

/** Fire flicker, 0.64..1. */
function flick(t: number, k: number): number { return 0.82 + 0.18 * Math.sin(t * 37 + k) * Math.sin(t * 23 + k * 2.3); }
function place(g: Container, x: number, y: number, r: number, alpha: number): void {
  g.visible = alpha > 0.01;
  g.x = x; g.y = y;
  g.scale.set(r / GLOW_R);
  g.alpha = alpha;
}
function line(s: Sprite, x: number, y: number, rot: number, len: number, width: number, alpha: number): void {
  s.visible = alpha > 0.01 && len > 0.5;
  s.x = x; s.y = y;
  s.rotation = rot;
  s.scale.set(len, width);
  s.alpha = alpha;
}

import { Container, Graphics, Text } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';
import { ACQUIRE_COLOUR, FAILSAFE_COLOUR, THREAT_COLOUR, groupColour } from '../hud/groupColours';

/**
 * Experimental HUD (exp/hud-mobile-first) world-space aim feedback. Drawn only
 * when the client publishes `mirror.hudVariant` (any `?ui=a|b|c`); the legacy
 * HUD never sets it, so this renderer stays hidden and costs one branch.
 *
 *  - AUTO   : cyan corner-bracket lock on the drone the turrets auto-picked
 *             (`mirror.localAutoLockId`, `swarm-<entityId>`), while engaging.
 *  - MANUAL : amber dashed aim line from the ship along `localManualAim` to the
 *             weapon's reach, with a small crosshair at its end.
 *  - Variant B: thin shield / hull / energy arcs around the local ship, fading
 *             to ~15 % alpha when everything is full.
 *
 * Game space is Y-up, the Pixi world Y-down: every point is drawn at
 * `(x, -y)`. Poses are read from the RESOLVED mirror entries (drones: the one
 * per-frame interpolated pose — never re-interpolated here). One pooled
 * Graphics per layer, cleared + redrawn per frame; no allocation (#14).
 */
export const AUTO_COLOR = 0x33ddff;
export const MANUAL_COLOR = 0xffb020;
const SHIELD_COLOR = 0x36c8ff;
const ENERGY_COLOR = 0xffc23d;
const LOCK_PAD = 10;
const LOCK_MIN_HALF = 16;
const CORNER_FRAC = 0.35;
const DASH_ON = 14;
const DASH_OFF = 10;
const CROSS_R = 9;
/** Arc ring radius as a multiple of the ship's collision radius. */
const ARC_RING_MUL = 1.9;
const ARC_GAP = 4;

/** Hull colour band — same thresholds as ShieldHullBar (green > 50 > amber > 25 > red). */
export function hullArcColor(frac: number): number {
  if (frac > 0.5) return 0x4cff7a;
  if (frac > 0.25) return 0xffb020;
  return 0xff4040;
}

/** Variant-B arc alpha: dim when every pool is full, bright otherwise. */
export function statusArcAlpha(shield: number, hull: number, energy: number): number {
  return shield >= 0.999 && hull >= 0.999 && energy >= 0.999 ? 0.15 : 0.85;
}

export class AimFeedbackRenderer {
  private readonly lock = new Graphics();
  private readonly aim = new Graphics();
  private readonly arcs = new Graphics();
  /** Fire control (variant d): lock rings, group brackets, firing lines, guide. */
  private readonly fc = new Graphics();
  /** Parsed lock keys → swarm entityId (or -1 + player id), so per-frame draws never slice. */
  private readonly keyCache = new Map<string, { swarm: number; player: string | null }>();
  private readonly tp = { x: 0, y: 0, r: 16 };
  /** "LOCKING 62%" tags over targets being locked (pooled; text set only on change). */
  private readonly tags: Text[] = [];
  /** Last label code per tag (stage * 1000 + percent): text is rebuilt only when it changes. */
  private readonly tagCode: number[] = [];
  private readonly tagLayer = new Container();
  /** Test hooks: locks drawn last frame, and NPC locks on the local ship. */
  lastFcLocks = 0;
  lastThreats = 0;
  /** Test hooks: what was drawn last frame. */
  lastLockId: string | null = null;
  lastAimDrawn = false;
  lastArcsDrawn = false;

  constructor(parent: Container) {
    this.lock.visible = false;
    this.aim.visible = false;
    this.arcs.visible = false;
    this.fc.visible = false;
      this.tagLayer.visible = false;
    parent.addChild(this.fc);
    parent.addChild(this.tagLayer);
    parent.addChild(this.arcs);
    parent.addChild(this.aim);
    parent.addChild(this.lock);
  }

  update(mirror: RenderMirror, zoom: number): void {
    const variant = mirror.hudVariant;
    const localId = mirror.localPlayerId;
    const ship = variant && localId ? mirror.ships.get(localId) : undefined;
    if (!variant || !ship) {
      this.lock.visible = false;
      this.aim.visible = false;
      this.arcs.visible = false;
      this.fc.visible = false;
      this.tagLayer.visible = false;
      this.lastFcLocks = 0;
      this.lastLockId = null;
      this.lastAimDrawn = false;
      this.lastArcsDrawn = false;
      return;
    }
    // Keep strokes a steady on-screen width across zoom.
    const px = 1 / Math.max(0.05, zoom);
    if (variant === 'd') {
      this.lock.visible = false;
      this.aim.visible = false;
      this.arcs.visible = false;
      this.drawFireControl(mirror, ship.x, ship.y, px);
      return;
    }
    this.fc.visible = false;
      this.tagLayer.visible = false;
    this.drawLock(mirror, px);
    this.drawAim(mirror, ship.x, ship.y, px);
    if (variant === 'b') this.drawArcs(mirror, ship.x, ship.y, getShipKind(ship.kind ?? null).radius ?? 20, px);
    else { this.arcs.visible = false; this.lastArcsDrawn = false; }
  }

  private key(k: string): { swarm: number; player: string | null } {
    let v = this.keyCache.get(k);
    if (!v) {
      v = k.startsWith('s:') ? { swarm: Number(k.slice(2)), player: null } : { swarm: -1, player: k.slice(2) };
      if (this.keyCache.size > 512) this.keyCache.clear();
      this.keyCache.set(k, v);
    }
    return v;
  }

  /** Resolve a lock target to its drawn pose + radius (false = not visible). */
  private targetPose(mirror: RenderMirror, k: string): boolean {
    const v = this.key(k);
    if (v.player !== null) {
      const s = mirror.ships.get(v.player);
      if (!s) return false;
      this.tp.x = s.x; this.tp.y = s.y; this.tp.r = getShipKind(s.kind ?? null).radius;
      return true;
    }
    const e = mirror.swarm?.get(v.swarm);
    if (!e) return false;
    this.tp.x = e.x; this.tp.y = e.y; this.tp.r = e.radius ?? 16;
    return true;
  }

  /** Show tag `i` ("LOCKING 62%") at (x, y) in `colour`, counter-scaled to screen size. */
  private tag(i: number, x: number, y: number, stage: number, pct: number, colour: number, px: number): void {
    let t = this.tags[i];
    if (!t) {
      t = new Text({ text: '', style: { fontFamily: 'Chakra Petch, system-ui, sans-serif', fontSize: 22, fontWeight: '700', letterSpacing: 2, fill: 0xffffff, stroke: { color: 0x000000, width: 4 } } });
      t.anchor.set(0.5, 1);
      this.tags[i] = t;
      this.tagCode[i] = -1;
      this.tagLayer.addChild(t);
    }
    const code = stage * 1000 + pct;
    if (this.tagCode[i] !== code) {
      t.text = (stage === 3 ? 'LOSING LOCK ' : stage === 0 ? 'FAILSAFE ' : 'LOCKING ') + pct + '%';
      this.tagCode[i] = code;
    }
    t.tint = colour;
    t.position.set(x, y);
    t.scale.set(px * 0.5);
    t.visible = true;
  }

  /**
   * Fire control (variant d). Own locks, per weapon group:
   *  - LOCKING (red) / FAILSAFE (yellow): a heavy closing ring with progress,
   *    four ticks that tighten in as it builds, a dashed link from the ship and
   *    a "LOCKING 62%" tag;
   *  - LOCKED: corner brackets in the group's colour (nested when several groups
   *    share a target) and a faint firing line.
   * Locks ON the local ship (`localLockedBy`): a red arc on a ring round the
   * ship facing each NPC, narrowing as its lock builds; once locked, a solid
   * caret pointing at it and a pulsing diamond on the NPC.
   * Then the smart-aim guide.
   */
  private drawFireControl(mirror: RenderMirror, sx: number, sy: number, px: number): void {
    const g = this.fc;
    g.clear();
    const now = performance.now();
    let drawn = 0;
    let tags = 0;
    const groups = mirror.localGroups;
    if (groups) {
      for (let gi = 0; gi < groups.length; gi++) {
        const grp = groups[gi]!;
        for (const l of grp.l) {
          if (!this.targetPose(mirror, l.t)) continue;
          const x = this.tp.x, y = -this.tp.y;
          const base = Math.max(LOCK_MIN_HALF, this.tp.r + LOCK_PAD);
          drawn++;
          if (l.s === 2) {
            const half = base + gi * 5 * px;
            const arm = half * CORNER_FRAC;
            const col = groupColour(gi);
            for (let i = 0; i < 4; i++) {
              const kx = i & 1 ? 1 : -1;
              const ky = i & 2 ? 1 : -1;
              const cx = x + kx * half, cy = y + ky * half;
              g.moveTo(cx - kx * arm, cy).lineTo(cx, cy).lineTo(cx, cy - ky * arm);
            }
            g.stroke({ width: 2.5 * px, color: col, alpha: 0.95 });
            g.moveTo(sx, -sy).lineTo(x, y).stroke({ width: 1 * px, color: col, alpha: 0.3 });
          } else {
            const col = l.s === 0 ? FAILSAFE_COLOUR : ACQUIRE_COLOUR;
            const frac = Math.max(0, Math.min(1, l.p / 100));
            const losing = l.r === 1; // let go: draining back to 0
            const dim = losing ? 0.45 : 1;
            const r = base * 1.35;
            // Dashed link: which of your targets is being locked.
            const dx = x - sx, dy = y + sy;
            const len = Math.hypot(dx, dy);
            if (len > r + 4 * px) {
              const ux = dx / len, uy = dy / len;
              const on = 6 * px, off = 7 * px;
              const stop = len - r;
              for (let d = 18 * px; d < stop; d += on + off) {
                const e = Math.min(stop, d + on);
                g.moveTo(sx + ux * d, -sy + uy * d).lineTo(sx + ux * e, -sy + uy * e);
              }
              g.stroke({ width: 1.5 * px, color: col, alpha: 0.55 * dim });
            }
            // Track + heavy progress arc.
            g.circle(x, y, r).stroke({ width: 2 * px, color: col, alpha: 0.3 });
            if (frac > 0.001) {
              const a0 = -Math.PI / 2;
              g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
              g.arc(x, y, r, a0, a0 + Math.PI * 2 * frac).stroke({ width: 4.5 * px, color: col, alpha: dim });
            }
            // Four ticks closing in from 2x to the ring as the lock builds
            // (they open back out as a let-go lock drains).
            const rt = r * (2 - frac);
            const spin = now * 0.0025;
            const tick = 9 * px;
            for (let k = 0; k < 4; k++) {
              const a = spin + (k * Math.PI) / 2;
              const c = Math.cos(a), sn = Math.sin(a);
              g.moveTo(x + c * rt, y + sn * rt).lineTo(x + c * (rt - tick), y + sn * (rt - tick));
            }
            g.stroke({ width: 3 * px, color: col, alpha: 0.9 * dim });
            this.tag(tags++, x, y - r * (2 - frac) - 6 * px, losing ? 3 : l.s, l.p, col, px);
          }
        }
      }
    }
    for (let i = tags; i < this.tags.length; i++) this.tags[i]!.visible = false;

    // Locks on the local ship.
    let threats = 0;
    const lockedBy = mirror.localLockedBy;
    if (lockedBy && lockedBy.length > 0) {
      const localKind = mirror.localPlayerId ? mirror.ships.get(mirror.localPlayerId)?.kind : undefined;
      const R = getShipKind(localKind ?? null).radius * 1.9 + 10 * px;
      const pulse = 0.55 + 0.45 * Math.sin(now * 0.012);
      for (const l of lockedBy) {
        if (!this.targetPose(mirror, l.t)) continue;
        threats++;
        const nx = this.tp.x, ny = -this.tp.y;
        const th = Math.atan2(ny + sy, nx - sx);
        const cx = sx, cy = -sy;
        if (l.s === 2) {
          // Solid caret on the ring pointing at the NPC.
          const tipR = R + 14 * px;
          const w = 0.16;
          g.moveTo(cx + Math.cos(th) * tipR, cy + Math.sin(th) * tipR)
            .lineTo(cx + Math.cos(th - w) * R, cy + Math.sin(th - w) * R)
            .lineTo(cx + Math.cos(th + w) * R, cy + Math.sin(th + w) * R)
            .closePath()
            .fill({ color: THREAT_COLOUR, alpha: 0.95 });
          g.moveTo(cx + Math.cos(th - 0.5) * R, cy + Math.sin(th - 0.5) * R);
          g.arc(cx, cy, R, th - 0.5, th + 0.5).stroke({ width: 3 * px, color: THREAT_COLOUR, alpha: 0.9 });
          // Pulsing diamond on the NPC.
          const dr = Math.max(LOCK_MIN_HALF, this.tp.r + LOCK_PAD) * 1.2;
          g.moveTo(nx, ny - dr).lineTo(nx + dr, ny).lineTo(nx, ny + dr).lineTo(nx - dr, ny).closePath()
            .stroke({ width: 2.5 * px, color: THREAT_COLOUR, alpha: pulse });
        } else {
          // Acquiring: an arc facing the NPC that narrows as its lock builds.
          const frac = Math.max(0, Math.min(1, l.p / 100));
          const half = 0.15 + 0.85 * (1 - frac);
          g.moveTo(cx + Math.cos(th - half) * R, cy + Math.sin(th - half) * R);
          g.arc(cx, cy, R, th - half, th + half).stroke({ width: 3 * px, color: THREAT_COLOUR, alpha: 0.35 + 0.5 * pulse });
          // Small notch at the exact bearing.
          g.moveTo(cx + Math.cos(th) * (R - 5 * px), cy + Math.sin(th) * (R - 5 * px))
            .lineTo(cx + Math.cos(th) * (R + 7 * px), cy + Math.sin(th) * (R + 7 * px))
            .stroke({ width: 2.5 * px, color: THREAT_COLOUR, alpha: 0.9 });
        }
      }
    }
    this.lastThreats = threats;

    // Smart-aim guideline + candidate.
    const b = mirror.localLockGuide;
    if (b !== undefined && !Number.isNaN(b)) {
      const reach = mirror.localAimReach ?? 600;
      const dx = -Math.sin(b), dy = Math.cos(b);
      const on = DASH_ON * px, off = DASH_OFF * px;
      for (let d = 0; d < reach; d += on + off) {
        const e = Math.min(reach, d + on);
        g.moveTo(sx + dx * d, -(sy + dy * d)).lineTo(sx + dx * e, -(sy + dy * e));
      }
      g.stroke({ width: 1.5 * px, color: 0xffffff, alpha: 0.7 });
      const cand = mirror.localLockCandidate;
      if (cand && this.targetPose(mirror, cand)) {
        const r = Math.max(LOCK_MIN_HALF, this.tp.r + LOCK_PAD) * 1.5;
        g.circle(this.tp.x, -this.tp.y, r).stroke({ width: 2 * px, color: 0xffffff, alpha: 0.9 });
      }
    }
    g.visible = true;
    this.tagLayer.visible = true;
    this.lastFcLocks = drawn;
  }

  private drawLock(mirror: RenderMirror, px: number): void {
    const id = mirror.localAutoLockId ?? null;
    const g = this.lock;
    if (!id || !id.startsWith('swarm-') || !mirror.swarm) {
      g.visible = false;
      this.lastLockId = null;
      return;
    }
    const entityId = Number(id.slice(6));
    const sw = mirror.swarm.get(entityId);
    if (!sw) {
      g.visible = false;
      this.lastLockId = null;
      return;
    }
    const half = Math.max(LOCK_MIN_HALF, (sw.radius ?? 16) + LOCK_PAD);
    const arm = half * CORNER_FRAC;
    const x = sw.x, y = -sw.y;
    g.clear();
    for (let i = 0; i < 4; i++) {
      const sx = i & 1 ? 1 : -1;
      const sy = i & 2 ? 1 : -1;
      const cx = x + sx * half, cy = y + sy * half;
      g.moveTo(cx - sx * arm, cy).lineTo(cx, cy).lineTo(cx, cy - sy * arm);
    }
    g.stroke({ width: 2 * px, color: AUTO_COLOR, alpha: 0.95 });
    g.visible = true;
    this.lastLockId = id;
  }

  private drawAim(mirror: RenderMirror, sx: number, sy: number, px: number): void {
    const b = mirror.localManualAim;
    const g = this.aim;
    if (b === undefined || Number.isNaN(b)) {
      g.visible = false;
      this.lastAimDrawn = false;
      return;
    }
    const reach = mirror.localAimReach ?? 250;
    // Ship-angle convention: forward = (-sin b, cos b) in game space.
    const dx = -Math.sin(b), dy = Math.cos(b);
    g.clear();
    const on = DASH_ON * px, off = DASH_OFF * px;
    for (let d = 0; d < reach; d += on + off) {
      const e = Math.min(reach, d + on);
      g.moveTo(sx + dx * d, -(sy + dy * d)).lineTo(sx + dx * e, -(sy + dy * e));
    }
    const ex = sx + dx * reach, ey = -(sy + dy * reach);
    const r = CROSS_R * px;
    g.moveTo(ex - r, ey).lineTo(ex + r, ey).moveTo(ex, ey - r).lineTo(ex, ey + r);
    g.stroke({ width: 1.5 * px, color: MANUAL_COLOR, alpha: 0.85 });
    g.circle(ex, ey, r * 0.7).stroke({ width: 1.5 * px, color: MANUAL_COLOR, alpha: 0.85 });
    g.visible = true;
    this.lastAimDrawn = true;
  }

  private drawArcs(mirror: RenderMirror, sx: number, sy: number, radius: number, px: number): void {
    const st = mirror.localStatus;
    const g = this.arcs;
    if (!st) {
      g.visible = false;
      this.lastArcsDrawn = false;
      return;
    }
    const r = radius * ARC_RING_MUL;
    const x = sx, y = -sy;
    const alpha = statusArcAlpha(st.shield, st.hull, st.energy);
    g.clear();
    // Three 110° arcs on the left, right and bottom of the ship (screen
    // space — the ring doesn't rotate with the hull), each a dim track plus a
    // bright fill proportional to its pool.
    this.arc(g, x, y, r, Math.PI * (215 / 180), st.shield, SHIELD_COLOR, alpha, px);
    this.arc(g, x, y, r, Math.PI * (-35 / 180), st.hull, hullArcColor(st.hull), alpha, px);
    this.arc(g, x, y, r + ARC_GAP * px * 3, Math.PI * (35 / 180) + Math.PI / 2, st.energy, ENERGY_COLOR, alpha, px);
    g.visible = true;
    this.lastArcsDrawn = true;
  }

  /** One gauge arc centred on `mid` (radians, Pixi screen frame), 110° wide. */
  private arc(g: Graphics, x: number, y: number, r: number, mid: number, frac: number, color: number, alpha: number, px: number): void {
    const span = Math.PI * (110 / 180);
    const start = mid - span / 2;
    g.arc(x, y, r, start, start + span).stroke({ width: 2 * px, color, alpha: alpha * 0.25 });
    if (frac > 0.001) {
      g.moveTo(x + Math.cos(start) * r, y + Math.sin(start) * r);
      g.arc(x, y, r, start, start + span * Math.min(1, frac)).stroke({ width: 3 * px, color, alpha });
    }
  }
}

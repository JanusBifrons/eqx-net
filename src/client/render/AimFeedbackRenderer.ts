import { Container, Graphics, Text } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';
import { ACQUIRE_COLOUR, FAILSAFE_COLOUR, THREAT_COLOUR, groupColour } from '../hud/groupColours';
import { lockMarkFrame, threatRingRadius, type LockMarkFrame } from './lockMarkFrame';

/**
 * Fire-control world-space feedback for the local pilot: lock rings and
 * group-coloured brackets on its own locks, threat arcs for NPC locks on the
 * local ship, and the smart-aim guideline + candidate while dragging.
 *
 * Game space is Y-up, the Pixi world Y-down: every point is drawn at
 * `(x, -y)`. Poses are read from the RESOLVED mirror entries (drones: the one
 * per-frame interpolated pose — never re-interpolated here). One pooled
 * Graphics, cleared + redrawn per frame; no allocation (#14).
 *
 * Every mark on a target is placed and sized by `lockMarkFrame`: hull-sized
 * round a fighter, capped on screen and moved onto the visible keel of a
 * capital (a hull-sized mark on a battleship was two stray lines across the
 * screen, showcase `capital-guns-fighter` 2026-11-10).
 */
const CORNER_FRAC = 0.35;
const DASH_ON = 14;
const DASH_OFF = 10;
/** The faint full threat ring drawn while anything locks you (owner's choice 2026-11-10). */
const THREAT_RING_FAINT_WIDTH = 1.5;
const THREAT_RING_FAINT_ALPHA = 0.22;

export class AimFeedbackRenderer {
  /** Lock rings, group brackets, firing lines, threats, guide. */
  private readonly fc = new Graphics();
  /** Parsed lock keys → swarm entityId (or -1 + player id), so per-frame draws never slice. */
  private readonly keyCache = new Map<string, { swarm: number; player: string | null }>();
  private readonly tp = { x: 0, y: 0, a: 0, r: 16 };
  /** Where + how big the current mark is (reused, #14). */
  private readonly mf: LockMarkFrame = { x: 0, y: 0, half: 0, capped: false };
  /** "LOCKING 62%" tags over targets being locked (pooled; text set only on change). */
  private readonly tags: Text[] = [];
  /** Last label code per tag (stage * 1000 + percent): text is rebuilt only when it changes. */
  private readonly tagCode: number[] = [];
  private readonly tagLayer = new Container();
  /** Faint full threat-ring stroke (reused; width set per frame, #14). */
  private readonly ringStroke = { width: THREAT_RING_FAINT_WIDTH, color: THREAT_COLOUR, alpha: THREAT_RING_FAINT_ALPHA };
  /** Test hooks: locks drawn last frame, and NPC locks on the local ship. */
  lastFcLocks = 0;
  lastThreats = 0;

  constructor(parent: Container) {
    this.fc.visible = false;
    this.tagLayer.visible = false;
    parent.addChild(this.fc);
    parent.addChild(this.tagLayer);
  }

  update(mirror: RenderMirror, zoom: number): void {
    const localId = mirror.localPlayerId;
    const ship = localId ? mirror.ships.get(localId) : undefined;
    if (!ship) {
      this.fc.visible = false;
      this.tagLayer.visible = false;
      this.lastFcLocks = 0;
      return;
    }
    // Keep strokes a steady on-screen width across zoom.
    const px = 1 / Math.max(0.05, zoom);
    this.drawFireControl(mirror, ship.x, ship.y, px);
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
      this.tp.x = s.x; this.tp.y = s.y; this.tp.a = s.angle; this.tp.r = getShipKind(s.kind ?? null).radius;
      return true;
    }
    const e = mirror.swarm?.get(v.swarm);
    if (!e) return false;
    this.tp.x = e.x; this.tp.y = e.y; this.tp.a = e.angle; this.tp.r = e.radius ?? 16;
    return true;
  }

  /** Frame (centre + half-size) for a mark on the last resolved target, seen from (sx, sy). */
  private markFrame(sx: number, sy: number, px: number): LockMarkFrame {
    const t = this.tp;
    return lockMarkFrame(t.x, t.y, t.a, t.r, sx, sy, px, this.mf);
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
   * Own locks, per weapon group:
   *  - LOCKING (red) / FAILSAFE (yellow): a heavy closing ring with progress,
   *    four ticks that tighten in as it builds, a dashed link from the ship and
   *    a "LOCKING 62%" tag;
   *  - LOCKED: corner brackets in the group's colour (nested when several groups
   *    share a target) and a faint firing line.
   * Locks ON the local ship (`localLockedBy`): the whole ring round the ship
   * drawn faintly, and on it a red arc facing each NPC, narrowing as its lock builds; once locked, a solid
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
          const mf = this.markFrame(sx, sy, px);
          const x = mf.x, y = -mf.y;
          const base = mf.half;
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
      const R = threatRingRadius(getShipKind(localKind ?? null).radius, px);
      const pulse = 0.55 + 0.45 * Math.sin(now * 0.012);
      // The whole ring, faint, under the arcs: so they read as pointers on a
      // ring centred on the ship, not a reticle floating beside it.
      this.ringStroke.width = THREAT_RING_FAINT_WIDTH * px;
      g.circle(sx, -sy, R).stroke(this.ringStroke);
      for (const l of lockedBy) {
        if (!this.targetPose(mirror, l.t)) continue;
        threats++;
        const mf = this.markFrame(sx, sy, px);
        const nx = mf.x, ny = -mf.y;
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
          const dr = mf.half * 1.2;
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
        const mf = this.markFrame(sx, sy, px);
        g.circle(mf.x, -mf.y, mf.half * 1.5).stroke({ width: 2 * px, color: 0xffffff, alpha: 0.9 });
      }
    }
    g.visible = true;
    this.tagLayer.visible = true;
    this.lastFcLocks = drawn;
  }
}

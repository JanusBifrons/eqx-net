import { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation';

const BAR_WIDTH = 40;
const BAR_HEIGHT = 4;
const SHIELD_GAP = 1; // px between shield (above) and hull (below)
const BAR_OFFSET_Y = 20; // pixels above entity in Pixi coords
const FADE_AFTER_MS = 2000;
const FADE_DURATION_MS = 500;
const SHIELD_COLOR = 0x44ccff;

interface HealthBarEntry {
  gfx: Graphics;
  healthPct: number;
  /** Optional — when set (and > 0 or shieldEverNonZero), renders a
   *  thin shield bar ABOVE the hull bar so shield-only damage on
   *  drones is visible (the bug class: "missile hits scout, shield
   *  absorbs, hull bar shows 100%, user sees zero damage"). */
  shieldPct: number;
  /** Sticky bit — once we see a non-zero shieldPct for this entry we
   *  keep rendering the shield segment until the bar fades, so a hit
   *  that reduces shield from non-zero to zero still SHOWS the
   *  reduction-to-zero visually (vs. a kind with no shield at all,
   *  where we never set this true and skip the shield bar entirely). */
  shieldEverNonZero: boolean;
  lastHitTime: number;
  /** Plan: combat-fx-hunt (2026-05-31) — last-drawn cache for the
   *  dirty-flag optimisation. Per-frame geometry rebuild via
   *  `clear() + rect() + fill()` was the rank-1 allocator under
   *  hostile combat: 25 active bars × 6 ops × 60 Hz = ~9k Pixi
   *  geometry ops/sec, each allocating ShapePath / _Circle /
   *  GpuGraphicsContext / _Bounds in Pixi v8. Caching the last-drawn
   *  state lets `update()` skip the rebuild when health / shield /
   *  hasShield have not changed (the common case for an in-fade bar).
   *  Sentinels (-1, false) force a rebuild on first paint. */
  drawnHealthPct: number;
  drawnShieldPct: number;
  drawnHasShield: boolean;
}

function healthColor(pct: number): number {
  if (pct > 0.5) return 0x44ff44;
  if (pct > 0.25) return 0xffcc00;
  return 0xff3333;
}

// Per-frame Pixi fill-style scratches. Each active bar fires two
// `gfx.fill({ ... })` calls per frame; without these the literal
// objects were allocated 2× per bar per frame. Mutate the colour /
// alpha fields in place and reuse the same object identity — Pixi v8's
// `fill` consumes the style synchronously and does not retain the
// reference. Module-level (not instance) because the manager is a
// singleton per renderer.
const _bgFillStyle: { color: number; alpha: number } = { color: 0x222222, alpha: 0.7 };
const _fgFillStyle: { color: number; alpha: number } = { color: 0x44ff44, alpha: 1 };

export class HealthBarManager {
  /** 2026-05-31 diagnostic + pool counters. Exposed via window for the
   *  heap-leak probe. */
  static debugCounters = { gfxCreate: 0, gfxReuse: 0, gfxRelease: 0 };
  static {
    if (typeof window !== 'undefined') {
      (window as unknown as { __healthBarsDebug?: typeof HealthBarManager.debugCounters })
        .__healthBarsDebug = HealthBarManager.debugCounters;
    }
  }

  private readonly container: Container;
  private readonly bars = new Map<string, HealthBarEntry>();
  /** Free-list of Graphics instances released by faded/removed bars.
   *  Reused when a new entity gets hit — avoids the
   *  destroy-then-allocate cycle that drove _Graphics +212 / 60 s in
   *  the active-combat heap-snapshot diff. */
  private readonly freeGfx: Graphics[] = [];
  private readonly swarmPoseScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };

  constructor(parent: Container) {
    this.container = new Container();
    parent.addChild(this.container);
  }

  onHit(entityId: string, healthPct: number, shieldPct: number = 0): void {
    let entry = this.bars.get(entityId);
    if (!entry) {
      let gfx = this.freeGfx.pop();
      if (!gfx) {
        HealthBarManager.debugCounters.gfxCreate++;
        gfx = new Graphics();
      } else {
        HealthBarManager.debugCounters.gfxReuse++;
        gfx.clear();
      }
      this.container.addChild(gfx);
      entry = {
        gfx,
        healthPct,
        shieldPct,
        shieldEverNonZero: shieldPct > 0,
        lastHitTime: performance.now(),
        // -1/-1/false sentinels force the first update() call to
        // rebuild geometry (the natural cache-miss path).
        drawnHealthPct: -1,
        drawnShieldPct: -1,
        drawnHasShield: false,
      };
      this.bars.set(entityId, entry);
    }
    entry.healthPct = healthPct;
    entry.shieldPct = shieldPct;
    if (shieldPct > 0) entry.shieldEverNonZero = true;
    entry.lastHitTime = performance.now();
    entry.gfx.alpha = 1;
  }

  update(mirror: RenderMirror): void {
    const now = performance.now();

    for (const [entityId, entry] of this.bars) {
      // Find entity position.
      let ex: number | undefined;
      let ey: number | undefined;

      const ship = mirror.ships.get(entityId);
      if (ship) {
        ex = ship.x;
        ey = ship.y;
      } else if (entityId.startsWith('swarm-') && mirror.swarm) {
        const swarmId = parseInt(entityId.slice('swarm-'.length), 10);
        if (!Number.isNaN(swarmId)) {
          const sw = mirror.swarm.get(swarmId);
          if (sw) {
            // Track the same pose the drone sprite is drawn at: post Phase
            // 3 reset (2026-05-09), drones (kind=1) render from
            // `entry.x/y/angle` directly. Asteroids keep the lerp path.
            if (sw.kind === 1) {
              ex = sw.x;
              ey = sw.y;
            } else {
              const lerped = interpolateSwarmPose(sw, now, this.swarmPoseScratch);
              ex = lerped.x;
              ey = lerped.y;
            }
          }
        }
      }

      if (ex === undefined || ey === undefined) {
        // Entity gone — return Graphics to pool instead of destroying.
        // The Graphics carries no per-entity state (geometry is rebuilt
        // on next onHit via the dirty-flag cache).
        HealthBarManager.debugCounters.gfxRelease++;
        this.container.removeChild(entry.gfx);
        this.freeGfx.push(entry.gfx);
        this.bars.delete(entityId);
        continue;
      }

      // Fade logic.
      const timeSinceHit = now - entry.lastHitTime;
      if (timeSinceHit > FADE_AFTER_MS + FADE_DURATION_MS) {
        HealthBarManager.debugCounters.gfxRelease++;
        this.container.removeChild(entry.gfx);
        this.freeGfx.push(entry.gfx);
        this.bars.delete(entityId);
        continue;
      }
      if (timeSinceHit > FADE_AFTER_MS) {
        entry.gfx.alpha = 1 - (timeSinceHit - FADE_AFTER_MS) / FADE_DURATION_MS;
      } else {
        entry.gfx.alpha = 1;
      }

      // Plan: combat-fx-hunt (2026-05-31) — position the Graphics via
      // its transform every frame (cheap matrix update), and only
      // REBUILD the geometry when the bar's state has actually
      // changed. Pre-fix, `gfx.clear() + rect() + fill()` ran every
      // frame on every active bar, allocating Pixi v8 internal
      // ShapePath / _Circle / GpuGraphicsContext / _Bounds per call.
      // With 25 hostile drones each frame rebuilt 25 bars × 6 ops ×
      // 60 Hz ≈ 9k geometry ops/sec — the rank-1 GC-pressure source
      // surfaced by the snapshot-diff + the user's 2 MB/s heap
      // climb during combat.
      entry.gfx.x = ex;
      entry.gfx.y = -ey - BAR_OFFSET_Y;

      const hasShield = entry.shieldEverNonZero;
      const stateChanged =
        entry.healthPct !== entry.drawnHealthPct
        || entry.shieldPct !== entry.drawnShieldPct
        || hasShield !== entry.drawnHasShield;
      if (!stateChanged) continue;

      // Geometry built in LOCAL coords (origin at the bar position).
      // The Graphics container's x/y above translates to world space.
      // Shield bar sits ABOVE the hull bar when hasShield (matches
      // the pre-fix world-coord layout).
      const localBarX = -BAR_WIDTH / 2;
      const hullLocalY = 0;
      const shieldLocalY = hasShield ? -BAR_HEIGHT - SHIELD_GAP : 0;

      entry.gfx.clear();

      // Shield background + foreground.
      if (hasShield) {
        entry.gfx.rect(localBarX, shieldLocalY, BAR_WIDTH, BAR_HEIGHT);
        entry.gfx.fill(_bgFillStyle);
        const shieldFg = BAR_WIDTH * Math.max(0, Math.min(1, entry.shieldPct));
        if (shieldFg > 0) {
          entry.gfx.rect(localBarX, shieldLocalY, shieldFg, BAR_HEIGHT);
          _fgFillStyle.color = SHIELD_COLOR;
          entry.gfx.fill(_fgFillStyle);
        }
      }

      // Hull background + foreground.
      entry.gfx.rect(localBarX, hullLocalY, BAR_WIDTH, BAR_HEIGHT);
      entry.gfx.fill(_bgFillStyle);
      const fgWidth = BAR_WIDTH * Math.max(0, Math.min(1, entry.healthPct));
      if (fgWidth > 0) {
        entry.gfx.rect(localBarX, hullLocalY, fgWidth, BAR_HEIGHT);
        _fgFillStyle.color = healthColor(entry.healthPct);
        entry.gfx.fill(_fgFillStyle);
      }

      // Cache the drawn state so subsequent frames skip the rebuild.
      entry.drawnHealthPct = entry.healthPct;
      entry.drawnShieldPct = entry.shieldPct;
      entry.drawnHasShield = hasShield;
    }
  }

  destroy(): void {
    for (const entry of this.bars.values()) {
      entry.gfx.destroy();
    }
    this.bars.clear();
    // Pooled free-list Graphics still need full disposal on teardown.
    for (const gfx of this.freeGfx) gfx.destroy();
    this.freeGfx.length = 0;
    this.container.destroy({ children: true });
  }
}

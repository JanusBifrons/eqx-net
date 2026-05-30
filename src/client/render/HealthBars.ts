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
  private readonly container: Container;
  private readonly bars = new Map<string, HealthBarEntry>();
  private readonly swarmPoseScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };

  constructor(parent: Container) {
    this.container = new Container();
    parent.addChild(this.container);
  }

  onHit(entityId: string, healthPct: number, shieldPct: number = 0): void {
    let entry = this.bars.get(entityId);
    if (!entry) {
      const gfx = new Graphics();
      this.container.addChild(gfx);
      entry = {
        gfx,
        healthPct,
        shieldPct,
        shieldEverNonZero: shieldPct > 0,
        lastHitTime: performance.now(),
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
        // Entity gone — remove bar.
        this.container.removeChild(entry.gfx);
        entry.gfx.destroy();
        this.bars.delete(entityId);
        continue;
      }

      // Fade logic.
      const timeSinceHit = now - entry.lastHitTime;
      if (timeSinceHit > FADE_AFTER_MS + FADE_DURATION_MS) {
        this.container.removeChild(entry.gfx);
        entry.gfx.destroy();
        this.bars.delete(entityId);
        continue;
      }
      if (timeSinceHit > FADE_AFTER_MS) {
        entry.gfx.alpha = 1 - (timeSinceHit - FADE_AFTER_MS) / FADE_DURATION_MS;
      } else {
        entry.gfx.alpha = 1;
      }

      // Position and draw.
      entry.gfx.clear();
      const barX = ex - BAR_WIDTH / 2;
      const hullBarY = -ey - BAR_OFFSET_Y; // Y-flip + offset upward
      const hasShield = entry.shieldEverNonZero;
      // When the entity has a shield, stack the shield segment ABOVE
      // the hull segment so shield damage is visible AT ALL (drones
      // don't have a HUD ShieldHullBar; the on-hit bar is their only
      // shield-feedback surface). When there's no shield (legacy /
      // shield-less kinds) we keep the single-bar layout exactly as
      // before — no regression to existing behaviour.
      const shieldBarY = hasShield ? hullBarY - BAR_HEIGHT - SHIELD_GAP : hullBarY;

      // Shield background + foreground.
      if (hasShield) {
        entry.gfx.rect(barX, shieldBarY, BAR_WIDTH, BAR_HEIGHT);
        entry.gfx.fill(_bgFillStyle);
        const shieldFg = BAR_WIDTH * Math.max(0, Math.min(1, entry.shieldPct));
        if (shieldFg > 0) {
          entry.gfx.rect(barX, shieldBarY, shieldFg, BAR_HEIGHT);
          _fgFillStyle.color = SHIELD_COLOR;
          entry.gfx.fill(_fgFillStyle);
        }
      }

      // Hull background + foreground.
      entry.gfx.rect(barX, hullBarY, BAR_WIDTH, BAR_HEIGHT);
      entry.gfx.fill(_bgFillStyle);
      const fgWidth = BAR_WIDTH * Math.max(0, Math.min(1, entry.healthPct));
      if (fgWidth > 0) {
        entry.gfx.rect(barX, hullBarY, fgWidth, BAR_HEIGHT);
        _fgFillStyle.color = healthColor(entry.healthPct);
        entry.gfx.fill(_fgFillStyle);
      }
    }
  }

  destroy(): void {
    for (const entry of this.bars.values()) {
      entry.gfx.destroy();
    }
    this.bars.clear();
    this.container.destroy({ children: true });
  }
}

import { Container, Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { interpolateSwarmPose, type InterpolatedPose } from '../net/swarmInterpolation';

const BAR_WIDTH = 40;
const BAR_HEIGHT = 4;
const BAR_OFFSET_Y = 20; // pixels above entity in Pixi coords
const FADE_AFTER_MS = 2000;
const FADE_DURATION_MS = 500;

interface HealthBarEntry {
  gfx: Graphics;
  healthPct: number;
  lastHitTime: number;
}

function healthColor(pct: number): number {
  if (pct > 0.5) return 0x44ff44;
  if (pct > 0.25) return 0xffcc00;
  return 0xff3333;
}

export class HealthBarManager {
  private readonly container: Container;
  private readonly bars = new Map<string, HealthBarEntry>();
  private readonly swarmPoseScratch: InterpolatedPose = { x: 0, y: 0, angle: 0 };

  constructor(parent: Container) {
    this.container = new Container();
    parent.addChild(this.container);
  }

  onHit(entityId: string, healthPct: number): void {
    let entry = this.bars.get(entityId);
    if (!entry) {
      const gfx = new Graphics();
      this.container.addChild(gfx);
      entry = { gfx, healthPct, lastHitTime: performance.now() };
      this.bars.set(entityId, entry);
    }
    entry.healthPct = healthPct;
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
      const barY = -ey - BAR_OFFSET_Y; // Y-flip + offset upward

      // Background.
      entry.gfx.rect(barX, barY, BAR_WIDTH, BAR_HEIGHT);
      entry.gfx.fill({ color: 0x222222, alpha: 0.7 });

      // Foreground.
      const fgWidth = BAR_WIDTH * Math.max(0, Math.min(1, entry.healthPct));
      if (fgWidth > 0) {
        entry.gfx.rect(barX, barY, fgWidth, BAR_HEIGHT);
        entry.gfx.fill({ color: healthColor(entry.healthPct) });
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

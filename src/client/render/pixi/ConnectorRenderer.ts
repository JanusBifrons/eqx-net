/**
 * Draws the grid connector web (speed-dial-resource-structures plan, Phase 3).
 * One `Graphics` cleared + redrawn each frame. Reads `mirror.structures` (the
 * web edges + build state) and joins to `mirror.swarm` for endpoint positions
 * (structures are static, so the resolved `entry.x/y` is stable — re-read it,
 * never re-interpolate, per the one-pose-per-frame rule).
 *
 * Each edge is drawn ONCE (from the lower entityId side) so reciprocal `connTo`
 * lists don't double-draw. A blueprint also gets a small construction
 * fill-bar above it. Allocation-free per frame: the flash key is packed
 * numerically (no string keys), and no per-frame collections are created.
 */
import { Graphics } from 'pixi.js';
import type { RenderMirror } from '../../../core/contracts/IRenderer.js';
import { connectorVisualParams } from './connectorVisual.js';

export class ConnectorRenderer {
  readonly gfx = new Graphics();

  /** Redraw the web for this frame. `scale` is the viewport zoom. */
  update(mirror: RenderMirror, scale: number, nowMs: number): void {
    const g = this.gfx;
    g.clear();
    const structures = mirror.structures;
    const swarm = mirror.swarm;
    if (!structures || !swarm || structures.size === 0) return;
    const flashes = mirror.gridFlashes;

    for (const [id, st] of structures) {
      const a = swarm.get(id);
      if (!a) continue;
      // Pixi screen space is Y-down; world is Y-up — negate y (same as sprites).
      const ax = a.x;
      const ay = -a.y;

      for (const otherId of st.connTo) {
        // Draw each undirected edge once, from the lower-id endpoint.
        if (id > otherId) continue;
        const b = swarm.get(otherId);
        if (!b) continue;
        const lo = id < otherId ? id : otherId;
        const hi = id < otherId ? otherId : id;
        const flashUntil = flashes ? (flashes.get(lo * 65536 + hi) ?? 0) : 0;
        const v = connectorVisualParams(flashUntil, nowMs, scale);
        const bx = b.x;
        const by = -b.y;
        // Glow underlay first (so the core line sits on top).
        if (v.glowAlpha > 0) {
          g.moveTo(ax, ay);
          g.lineTo(bx, by);
          g.stroke({ color: v.color, alpha: v.glowAlpha, width: v.glowWidth });
        }
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke({ color: v.color, alpha: v.alpha, width: v.width });
      }

      // Phase 4 — mining beam from a miner to its target asteroid (positions
      // joined from the swarm mirror by entityId).
      if (st.miningTargetId !== undefined) {
        const target = swarm.get(st.miningTargetId);
        if (target) {
          const tx = target.x;
          const ty = -target.y;
          g.moveTo(ax, ay);
          g.lineTo(tx, ty);
          g.stroke({ color: 0xee8844, alpha: 0.85, width: Math.max(1 / scale, 2) });
        }
      }

      // Construction fill-bar for blueprints (above the structure body).
      if (!st.built) {
        const r = a.radius;
        const barW = r * 2;
        const barH = Math.max(3, r * 0.18);
        const bx0 = ax - r;
        const by0 = ay - r - barH - 4;
        g.rect(bx0, by0, barW, barH);
        g.fill({ color: 0x000000, alpha: 0.5 });
        g.rect(bx0, by0, barW * Math.min(1, Math.max(0, st.buildPct)), barH);
        g.fill({ color: 0x66ccff, alpha: 0.9 });
      } else if (st.deconstructPct > 0) {
        // Red emptying bar while reclaiming.
        const r = a.radius;
        const barW = r * 2;
        const barH = Math.max(3, r * 0.18);
        const bx0 = ax - r;
        const by0 = ay - r - barH - 4;
        g.rect(bx0, by0, barW, barH);
        g.fill({ color: 0x000000, alpha: 0.5 });
        g.rect(bx0, by0, barW * Math.min(1, Math.max(0, 1 - st.deconstructPct)), barH);
        g.fill({ color: 0xff5555, alpha: 0.9 });
      }
    }
  }

  destroy(): void {
    this.gfx.destroy();
  }
}

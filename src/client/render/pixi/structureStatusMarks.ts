/**
 * Immediate-mode status marks on the connector web's per-frame layer, moved
 * verbatim out of `ConnectorRenderer` (god-file ratchet): the bar above a
 * structure (build fill, reclaim, battery charge), the out-of-power bolt,
 * and the Mine Layer's mines. Zero-alloc apart from the style literals the
 * original code already passed (Pixi copies them).
 */
import type { Graphics } from 'pixi.js';
import type { RenderMirror } from '../../../core/contracts/IRenderer.js';
import { MINE_TRIGGER_RANGE } from '../../../shared-types/mines.js';

/** A bar above a structure of radius `r` at (`ax`, `ay`) (Pixi space),
 *  filled to `frac` (clamped to [0, 1]) in `color` over a dark track. */
export function drawStatusBar(g: Graphics, ax: number, ay: number, r: number, frac: number, color: number): void {
  const barW = r * 2;
  const barH = Math.max(3, r * 0.18);
  const bx0 = ax - r;
  const by0 = ay - r - barH - 4;
  g.rect(bx0, by0, barW, barH);
  g.fill({ color: 0x000000, alpha: 0.5 });
  g.rect(bx0, by0, barW * Math.min(1, Math.max(0, frac)), barH);
  g.fill({ color, alpha: 0.9 });
}

/** The out-of-power glyph above a structure: a red lightning bolt with a
 *  slash through it ("no power"). */
export function drawNoPowerBolt(g: Graphics, ax: number, ay: number, r: number, scale: number): void {
  const cx = ax;
  const cy = ay - r - 12;
  const h = Math.max(5, r * 0.28); // bolt half-height
  const w = Math.max(1.5 / scale, 2);
  // Lightning bolt: a zigzag from top to bottom (energy/power glyph).
  g.moveTo(cx + h * 0.25, cy - h);
  g.lineTo(cx - h * 0.3, cy + h * 0.1);
  g.lineTo(cx + h * 0.1, cy + h * 0.1);
  g.lineTo(cx - h * 0.25, cy + h);
  g.stroke({ color: 0xff4444, width: w, alpha: 0.95 });
  // Slash through it = negation ("no power").
  const d = h * 0.85;
  g.moveTo(cx - d, cy - d);
  g.lineTo(cx + d, cy + d);
  g.stroke({ color: 0xff4444, width: w, alpha: 0.95 });
}

/** Mine Layer — each mine: a faint trigger ring (a warning to anyone) and a
 *  small canister with a blinking light (cyan = yours, red = anyone else's). */
export function drawMines(g: Graphics, mines: NonNullable<RenderMirror['mines']>, scale: number, nowMs: number): void {
  const w = Math.max(1 / scale, 1);
  for (const m of mines.values()) {
    const x = m.x;
    const y = -m.y;
    const color = m.own ? 0x66ddff : 0xff5544;
    g.circle(x, y, MINE_TRIGGER_RANGE);
    g.stroke({ color, alpha: 0.12, width: w });
    g.circle(x, y, 16);
    g.fill({ color: 0x1b1f27, alpha: 0.95 });
    g.stroke({ color, alpha: 0.6, width: Math.max(1.5 / scale, 1.5) });
    const on = Math.sin(nowMs * 0.006 + x * 0.01) > 0;
    g.circle(x, y, 6);
    g.fill({ color, alpha: on ? 0.95 : 0.3 });
  }
}

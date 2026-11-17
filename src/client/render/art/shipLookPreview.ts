/**
 * The ship-look picker's pictures (galaxy map 0c), drawn on the main thread
 * with the same forge the renderer bakes: the player's own hull in a chosen
 * (colour, sigil) pair, and one sigil tile per choice. Loaded on demand by
 * the picker (dynamic import), so the forge stays out of the first bundle.
 *
 * Cost (desktop, vitest): a sub-cap hull at ~100 texels forges in 3-15 ms; a
 * capital at the same length in 3-18 ms. It runs once per pick, never per frame.
 */
import { forgeShip, shipExtent } from './fields.js';
import { turretCoverOf } from './bake.js';
import { DEFAULT_RIG, litFrame } from './shade.js';
import { sigilCoverage, sigilDesign } from './sigil.js';
import { DEFAULT_LIVERY, readLivery } from './artMode.js';
import { lookLivery } from '../../../shared-types/factions.js';

/** Draw `kindId` in the pair onto `canvas`, nose to the right, fitted. */
export function drawShipLook(canvas: HTMLCanvasElement, kindId: string, colorSlot: number, sigil: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const lv = lookLivery(colorSlot, sigil);
  const treatment = (typeof location !== 'undefined' ? readLivery(location.search) : undefined) ?? DEFAULT_LIVERY;
  // Nose to the right: the hull's length runs along the canvas width.
  const ppu = (W * 0.92) / (shipExtent(kindId) * 2);
  const f = forgeShip(kindId, { ppu, livery: { treatment, team: lv.team, sigil: lv.sigil, edge: lv.edge }, turretCover: turretCoverOf(kindId) });
  const fr = litFrame(f, DEFAULT_RIG, DEFAULT_RIG.sunAz);
  const img = new ImageData(new Uint8ClampedArray(fr.data), fr.w, fr.h);
  const tmp = document.createElement('canvas');
  tmp.width = fr.w;
  tmp.height = fr.h;
  tmp.getContext('2d')?.putImageData(img, 0, 0);
  const s = Math.min(W / fr.h, H / fr.w);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(Math.PI / 2);
  ctx.scale(s, s);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, -fr.w / 2, -fr.h / 2);
  ctx.restore();
}

/** Draw one sigil (16-bit seed) in `color` filling a square `canvas`. */
export function drawSigilTile(canvas: HTMLCanvasElement, packed: number, color: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const n = canvas.width;
  const d = sigilDesign(packed);
  const img = ctx.createImageData(n, n);
  const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
  const px = 2 / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const c = sigilCoverage(d, ((x + 0.5) / n) * 2 - 1, 1 - ((y + 0.5) / n) * 2, px);
      if (c <= 0) continue;
      const o = (y * n + x) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = Math.round(c * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
}

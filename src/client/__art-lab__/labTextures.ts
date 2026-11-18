/**
 * Art lab textures (split out of `main.ts`): the canvas-painted glow,
 * streak and shockwave sprites, the star tile and nebula backdrop, and the
 * game's fx images as textures. All baked once at load, never per frame.
 */
import { CanvasSource, Texture } from 'pixi.js';
import type { Img } from '../render/art/fx/fxTextures.js';
import { hash01, valueNoise } from '../render/art/fields.js';

function canvasTex(size: number, paint: (ctx: CanvasRenderingContext2D, s: number) => void, nearest = false): Texture {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  paint(c.getContext('2d')!, size);
  const t = Texture.from(c);
  t.source.scaleMode = nearest ? 'nearest' : 'linear';
  return t;
}

/** Soft additive glow: a gaussian-ish radial falloff, white (tinted per use). */
export const GLOW = canvasTex(64, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
});

/** A horizontal streak: bright middle, soft ends and edges (bolts, beams). */
export const STREAK = canvasTex(64, (ctx, s) => {
  const g = ctx.createLinearGradient(0, 0, s, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.25, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  const v = ctx.createLinearGradient(0, 0, 0, s);
  v.addColorStop(0, 'rgba(0,0,0,1)'); v.addColorStop(0.5, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = v; ctx.fillRect(0, 0, s, s);
});

/** Shockwave ring. */
export const RING = canvasTex(128, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
});

/** A tile of stars (baked once). Pixel style keeps them hard single texels. */
export function starTile(pixel: boolean): Texture {
  return canvasTex(512, (ctx, s) => {
    for (let i = 0; i < 260; i++) {
      const x = Math.floor(hash01(i, 11) * s), y = Math.floor(hash01(i, 23) * s);
      const b = hash01(i, 37);
      const warm = hash01(i, 41) > 0.7;
      const a = 0.25 + 0.75 * b * b;
      ctx.fillStyle = warm ? `rgba(255,214,170,${a})` : `rgba(190,210,255,${a})`;
      const r = b > 0.93 ? 2 : 1;
      if (pixel) ctx.fillRect(x, y, r, r);
      else { ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, r * 0.6, 0, Math.PI * 2); ctx.fill(); }
    }
  }, pixel);
}

/** A faint nebula (fbm value noise), baked once, stretched over the view. */
export function nebulaTex(pixel: boolean): Texture {
  return canvasTex(256, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        let n = 0, amp = 0.5, f = 3 / s;
        for (let o = 0; o < 5; o++) { n += amp * valueNoise(x * f, y * f, 0x5eed + o); amp *= 0.5; f *= 2; }
        const m = Math.max(0, n - 0.42) * 2.2;
        const p = (y * s + x) * 4;
        const w = valueNoise(x * 2 / s, y * 2 / s, 99);
        img.data[p] = 40 + 60 * w; img.data[p + 1] = 30 + 25 * (1 - w); img.data[p + 2] = 90 + 60 * (1 - w);
        img.data[p + 3] = Math.min(255, m * m * 120);
      }
    }
    ctx.putImageData(img, 0, 0);
  }, pixel);
}

/** An effects image as a texture (the lab bakes the game's fx images itself). */
export function imgTexture(i: Img): Texture {
  const c = document.createElement('canvas');
  c.width = i.w; c.height = i.h;
  c.getContext('2d')!.putImageData(new ImageData(i.data as Uint8ClampedArray<ArrayBuffer>, i.w, i.h), 0, 0);
  return new Texture({ source: new CanvasSource({ resource: c, scaleMode: 'linear' }) });
}

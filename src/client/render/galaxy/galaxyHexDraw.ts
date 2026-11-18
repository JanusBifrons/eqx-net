import { BufferImageSource, Sprite, Texture, type Graphics, type Text } from 'pixi.js';
import { teamSigilOf } from '../../../shared-types/factions.js';
import { sigilRgba } from '../art/sigil.js';
import { labelFit } from './galaxyLayerDecisions';
import { clipPolyAtX } from './galaxyMapMotion';
import { NEUTRAL_OWNER } from './sectorOwnership';
import { GALAXY_SECTORS, axialToPixel, getSector, type SectorFeature } from '@core/galaxy/galaxy';
import { galaxyNebula, NEBULA_SECTOR_SPACING } from '@core/galaxy/nebulaField';
import type { SectorControl } from '../../../shared-types/galaxySnapshot.js';
import {
  boundaryEdges,
  frontEdges,
  factionBorderColor,
  splitChallenger,
  threatBracketStyle,
  THREAT_BRACKET_COLOR,
} from './galaxyTerritories';
import {
  GALAXY_STAR_LAYERS,
  starHash,
  starLayerAlphaAt,
  starRadiusAt,
  starTileHalfRange,
} from './galaxyStarfield';

/**
 * Pixi draw helpers for {@link import('./GalaxyMapLayer').GalaxyMapLayer} (the
 * territory-hex look). The decisions (colours, split, threat, flip timing) are
 * pure and unit-tested in `galaxyTerritories.ts`; these only turn them into
 * Graphics paths. Every helper runs at build or feed cadence, except
 * {@link drawGalaxyStarfield} (per frame, allocation-free).
 */

/** Pointy-top hex corners at angles 30°, 90°, …, 330° (vertex `i` → edge `i`
 *  runs to vertex `i+1`; locked against `HEX_EDGE_NEIGHBOUR_DIRS`). */
export function hexVertices(size: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + (i * Math.PI) / 3;
    out.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return out;
}

type Verts = ReadonlyArray<{ x: number; y: number }>;

/**
 * A territory's perimeter in its owner's border colour, from inset corners
 * `v`: map-edge sides thin, fronts (another owner across the side) bold. The
 * neighbour draws its own inset line, so a front is a two-colour seam.
 * Positions are relative to the territory container at (cx, cy).
 */
export function drawTerritoryBorder(
  g: Graphics, v: Verts, sectorKeys: readonly string[], ownerId: string, hexSize: number,
  cx: number, cy: number, ownerAt: (q: number, r: number) => string | null, fronts: number[],
): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const key of sectorKeys) {
      const sec = getSector(key);
      if (!sec) continue;
      const pos = axialToPixel(sec.hex, hexSize);
      const owned = { hex: sec.hex, region: ownerId };
      frontEdges(owned, ownerAt, fronts);
      for (const ei of boundaryEdges(owned, ownerAt)) {
        if (fronts.includes(ei) !== (pass === 1)) continue;
        const a = v[ei]!;
        const b = v[(ei + 1) % 6]!;
        g.moveTo(pos.x - cx + a.x, pos.y - cy + a.y);
        g.lineTo(pos.x - cx + b.x, pos.y - cy + b.y);
      }
    }
    g.stroke({ color: factionBorderColor(ownerId), width: pass === 1 ? 4 : 2.5, alpha: 1, cap: 'round' });
  }
}

/** Flat `x,y,…` corners of a pointy-top hex (same order as {@link hexVertices}). */
export function hexFlat(size: number): number[] {
  const out: number[] = [];
  for (const p of hexVertices(size)) out.push(p.x, p.y);
  return out;
}

/** Reused seam style (Pixi copies a style on stroke). */
const SEAM = { color: 0, width: 1.5, alpha: 0.8 };

/**
 * A hex fill (`flat` corners), or (with a right fill) a hex cut by a vertical
 * line at `frac` of its width: left side `fill`, right side `rightFill`, with
 * a seam: thin and dark normally, bold in `seam` colour while a flip wipes
 * across. `left` / `right` are the hex's own reused point buffers: Pixi keeps
 * a reference to a polygon's points until it renders, so each hex needs its
 * own. Allocation-free on our side (per-frame safe).
 */
export function drawHexFill(
  g: Graphics, flat: number[], fill: number, rightFill: number | null, frac: number,
  seam: number, bold: boolean, left: number[], right: number[],
): void {
  if (rightFill === null || frac >= 1) {
    g.poly(flat).fill(fill);
    return;
  }
  let minX = Infinity, maxX = -Infinity;
  for (let k = 0; k < flat.length; k += 2) {
    if (flat[k]! < minX) minX = flat[k]!;
    if (flat[k]! > maxX) maxX = flat[k]!;
  }
  const cut = minX + (maxX - minX) * Math.max(0, frac);
  clipPolyAtX(flat, cut, left, right);
  if (left.length >= 6) g.poly(left).fill(fill);
  if (right.length >= 6) g.poly(right).fill(rightFill);
  let top = Infinity, bottom = -Infinity;
  for (let k = 0; k < left.length; k += 2) {
    if (left[k] !== cut) continue;
    if (left[k + 1]! < top) top = left[k + 1]!;
    if (left[k + 1]! > bottom) bottom = left[k + 1]!;
  }
  if (top >= bottom) return;
  SEAM.color = seam;
  SEAM.width = bold ? 3 : 1.5;
  SEAM.alpha = bold ? 1 : 0.8;
  g.moveTo(cut, top).lineTo(cut, bottom).stroke(SEAM);
}

/** Diagonal hatch over a hex fill (drone ground), clipped to the inscribed
 *  disc so it stays inside the hex. */
export function drawHatch(g: Graphics, size: number, color: number): void {
  const r = size * 0.8;
  const spacing = 9;
  const inv = Math.SQRT1_2;
  for (let d = -r + spacing / 2; d < r; d += spacing) {
    const half = Math.sqrt(r * r - d * d);
    // Points p = d*n + t*u, with n = (1,-1)/sqrt2 and u = (1,1)/sqrt2.
    const nx = d * inv, ny = -d * inv;
    g.moveTo(nx - half * inv, ny - half * inv);
    g.lineTo(nx + half * inv, ny + half * inv);
  }
  g.stroke({ color, width: 2, alpha: 0.55 });
}

/**
 * One sector's control marks at (ox, oy): amber threat brackets inside the
 * corners (more corners, longer arms as threat rises), a lock glyph top-right
 * when locked, and a trend arrow top-left on a contested (split) sector: up in
 * the holder's colour when it gains, down in the challenger's when it loses.
 */
export function drawSectorControl(g: Graphics, v: Verts, size: number, ox: number, oy: number, c: SectorControl, ownerId: string): void {
  const st = threatBracketStyle(c.threat);
  if (st.corners.length > 0) {
    const k = 0.86;
    for (const ci of st.corners) {
      const at = v[ci]!;
      const prev = v[(ci + 5) % 6]!;
      const next = v[(ci + 1) % 6]!;
      const cx = ox + at.x * k;
      const cy = oy + at.y * k;
      g.moveTo(cx + (prev.x - at.x) * k * st.arm, cy + (prev.y - at.y) * k * st.arm);
      g.lineTo(cx, cy);
      g.lineTo(cx + (next.x - at.x) * k * st.arm, cy + (next.y - at.y) * k * st.arm);
    }
    g.stroke({ color: THREAT_BRACKET_COLOR, width: st.width, alpha: 1, join: 'miter', cap: 'square' });
  }
  if (c.locked) {
    const lx = ox + size * 0.42;
    const ly = oy - size * 0.4;
    g.moveTo(lx - 3, ly - 1);
    g.arc(lx, ly - 1, 3, Math.PI, 0);
    g.stroke({ color: 0xe8eef8, width: 1.6, alpha: 1 });
    g.roundRect(lx - 4.5, ly - 1, 9, 7, 1.5).fill({ color: 0xe8eef8, alpha: 1 });
  }
  const challenger = splitChallenger(c, ownerId);
  if (challenger !== null && c.trend !== 0) {
    const tx = ox - size * 0.42;
    const ty = oy - size * 0.4;
    if (c.trend > 0) {
      g.poly([tx, ty - 5, tx + 4.5, ty + 3, tx - 4.5, ty + 3]).fill({ color: factionBorderColor(ownerId), alpha: 1 });
    } else {
      g.poly([tx, ty + 5, tx + 4.5, ty - 3, tx - 4.5, ty - 3]).fill({ color: factionBorderColor(challenger), alpha: 1 });
    }
  }
}

/** A dashed ring round a just-flipped sector at (ox, oy). */
export function drawFlipRing(g: Graphics, ox: number, oy: number, r: number, color: number): void {
  const dashes = 18;
  const step = (Math.PI * 2) / dashes;
  for (let i = 0; i < dashes; i++) {
    const a0 = i * step;
    g.moveTo(ox + r * Math.cos(a0), oy + r * Math.sin(a0));
    g.arc(ox, oy, r, a0, a0 + step * 0.55);
  }
  g.stroke({ color, width: 2.5, alpha: 1 });
}

/** The baked nebula backdrop: a coarse alpha grid in map pixels. */
export interface NebulaBake {
  /** Grid size in texels. */
  readonly w: number;
  readonly h: number;
  /** Map-pixel position of texel (0, 0)'s top-left corner. */
  readonly x0: number;
  readonly y0: number;
  /** Map pixels per texel. */
  readonly texel: number;
  /** Row-major alpha, 0-255. */
  readonly alpha: Uint8ClampedArray;
}

/** Map pixels per nebula texel: coarse on purpose, the GPU's linear filter
 *  stretches it into soft cloud. */
export const NEBULA_TEXEL = 8;
/** Peak cloud opacity (deepest nebula). */
export const NEBULA_MAX_ALPHA = 0.34;

/**
 * Sample the shared `nebulaField` once round the cluster (map pixels at
 * `hexSize`) into a soft alpha grid: density through a smoothstep, a box blur
 * so no edge is hard, and a fade to zero at the grid's border so the backdrop
 * never shows a rectangle. Built once; the layer shows it as one sprite.
 */
export function bakeNebulaAlpha(hexSize: number): NebulaBake {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of GALAXY_SECTORS) {
    const p = axialToPixel(s.hex, hexSize);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const pad = hexSize * 3;
  const texel = NEBULA_TEXEL;
  const x0 = minX - pad, y0 = minY - pad;
  const w = Math.ceil((maxX - minX + 2 * pad) / texel);
  const h = Math.ceil((maxY - minY + 2 * pad) / texel);
  // Map pixels -> nebula galaxy space (game axes, Y up).
  const k = NEBULA_SECTOR_SPACING / Math.sqrt(3) / hexSize;
  const fadeTexels = (hexSize * 1.5) / texel;
  let a: Float32Array = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const d = galaxyNebula((x0 + (i + 0.5) * texel) * k, -(y0 + (j + 0.5) * texel) * k);
      const t = Math.min(1, Math.max(0, (d - 0.05) / 0.8));
      const edge = Math.min(1, Math.min(i, j, w - 1 - i, h - 1 - j) / fadeTexels);
      a[j * w + i] = t * t * (3 - 2 * t) * edge;
    }
  }
  // Two separable box-blur passes (radius 2 texels) soften any lump.
  for (let pass = 0; pass < 2; pass++) a = boxBlur(a, w, h, 2);
  const alpha = new Uint8ClampedArray(w * h);
  for (let n = 0; n < alpha.length; n++) alpha[n] = Math.round(a[n]! * NEBULA_MAX_ALPHA * 255);
  return { w, h, x0, y0, texel, alpha };
}

/** The baked nebula as one soft sprite in map pixels (built once; one draw). */
export function makeNebulaSprite(hexSize: number, color: number): Sprite {
  const neb = bakeNebulaAlpha(hexSize);
  const rgba = new Uint8ClampedArray(neb.w * neb.h * 4);
  for (let n = 0; n < neb.alpha.length; n++) {
    rgba[n * 4] = (color >> 16) & 255; rgba[n * 4 + 1] = (color >> 8) & 255;
    rgba[n * 4 + 2] = color & 255; rgba[n * 4 + 3] = neb.alpha[n]!;
  }
  const sprite = new Sprite(new Texture({ source: new BufferImageSource({
    resource: rgba, width: neb.w, height: neb.h, alphaMode: 'no-premultiply-alpha', scaleMode: 'linear',
  }) }));
  sprite.position.set(neb.x0, neb.y0);
  sprite.scale.set(neb.texel);
  return sprite;
}

/** Held-sector owner sigil: texels baked per owner, and drawn size (map px). */
const SIGIL_TEXELS = 48;
const SIGIL_SIZE = 18;

/** An owner's sigil texture: the SAME emblem its ships wear (`teamSigilOf`),
 *  in the owner's border colour. Bake once per owner and share it. */
function makeSigilTexture(owner: string): Texture {
  return new Texture({ source: new BufferImageSource({
    resource: sigilRgba(teamSigilOf(owner), factionBorderColor(owner), SIGIL_TEXELS),
    width: SIGIL_TEXELS, height: SIGIL_TEXELS,
    alphaMode: 'no-premultiply-alpha', scaleMode: 'linear', autoGenerateMipmaps: true,
  }) });
}

/** A held sector's owner sigil centred at (x, y), its texture baked once per
 *  owner into `cache`; null on neutral ground (no sigil). */
export function ownerSigilSprite(cache: Map<string, Texture>, owner: string, x: number, y: number): Sprite | null {
  if (owner === NEUTRAL_OWNER || owner === '') return null;
  let tex = cache.get(owner);
  if (!tex) cache.set(owner, (tex = makeSigilTexture(owner)));
  const s = new Sprite(tex);
  s.anchor.set(0.5);
  s.width = SIGIL_SIZE;
  s.height = SIGIL_SIZE;
  s.position.set(x, y);
  return s;
}

/** Fit a sector name inside its hex (`labelFit`): shrink a little, else wrap
 *  to two centred lines and shrink those if still too wide. */
export function fitSectorLabel(label: Text, maxWidth: number): void {
  if (labelFit(label.width, maxWidth).wrap) {
    label.style.wordWrap = true;
    label.style.wordWrapWidth = maxWidth;
    label.style.align = 'center';
    label.style.lineHeight = 13;
  }
  label.scale.set(labelFit(label.width, maxWidth).scale);
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let sum = 0, n = 0;
      for (let o = -r; o <= r; o++) { const x = i + o; if (x >= 0 && x < w) { sum += src[j * w + x]!; n++; } }
      tmp[j * w + i] = sum / n;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let sum = 0, n = 0;
      for (let o = -r; o <= r; o++) { const y = j + o; if (y >= 0 && y < h) { sum += tmp[y * w + i]!; n++; } }
      out[j * w + i] = sum / n;
    }
  }
  return out;
}

/**
 * The zoom-aware LOD parallax starfield, screen-space: each star goes through
 * the same world→screen map as the cluster (`screen = root.xy + world * scale`),
 * with the visible LOD layers picked by `scale`, so density stays about
 * constant at any zoom. Per frame; allocates nothing. The layer/fade/placement
 * math is in `galaxyStarfield.ts`.
 */
export function drawGalaxyStarfield(g: Graphics, screenW: number, screenH: number, rootX: number, rootY: number, scale: number): void {
  const scx = screenW / 2;
  const scy = screenH / 2;
  // The world point under the screen centre (inverse cluster map).
  const camX = (scx - rootX) / scale;
  const camY = (scy - rootY) / scale;
  const hw = screenW / (2 * scale); // half-viewport in world units
  const hh = screenH / (2 * scale);
  for (const layer of GALAXY_STAR_LAYERS) {
    const alpha = starLayerAlphaAt(layer, scale);
    if (alpha <= 0) continue;
    const T = layer.tileSize;
    const p = layer.parallax;
    const bgCx = camX * p;
    const bgCy = camY * p;
    const cTX = Math.round(bgCx / T);
    const cTY = Math.round(bgCy / T);
    const halfX = starTileHalfRange(hw, T);
    const halfY = starTileHalfRange(hh, T);
    // One fill per layer; radii vary (mostly fine dust, a few brighter).
    for (let atx = cTX - halfX; atx <= cTX + halfX; atx++) {
      for (let aty = cTY - halfY; aty <= cTY + halfY; aty++) {
        for (let i = 0; i < layer.starsPerTile; i++) {
          const sx = (atx + starHash(atx, aty, layer.seed, i * 2)) * T;
          const sy = (aty + starHash(atx, aty, layer.seed, i * 2 + 1)) * T;
          const r = starRadiusAt(layer, starHash(atx, aty, layer.seed + 101, i + 1));
          g.circle(scx + (sx - bgCx) * scale, scy + (sy - bgCy) * scale, r);
        }
      }
    }
    g.fill({ color: layer.color, alpha });
  }
}

/** A sector's asteroid-field glyph(s) in a small centred row at (cx, cy). Only
 *  asteroid features draw (the map shows buildings, ships and asteroids). */
export function drawFeatureGlyphs(g: Graphics, features: readonly SectorFeature[], cx: number, cy: number): void {
  let n = 0;
  for (const f of features) if (f === 'asteroid') n++;
  if (n === 0) return;
  const spacing = 13;
  const r = 5;
  const startX = cx - ((n - 1) * spacing) / 2;
  for (let i = 0; i < n; i++) {
    g.ellipse(startX + i * spacing, cy, r * 1.1, r * 0.8).fill({ color: 0xaa9977 });
  }
}

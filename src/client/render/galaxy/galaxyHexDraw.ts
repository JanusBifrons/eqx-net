import type { Graphics } from 'pixi.js';
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

/** A hex fill, or (with a challenger fill) a hex split down the middle:
 *  holder on the left, challenger on the right, with a thin dark seam. */
export function drawHexFill(g: Graphics, v: Verts, fill: number, challengerFill: number | null, seam: number): void {
  if (challengerFill === null) {
    g.poly(v as Array<{ x: number; y: number }>).fill({ color: fill, alpha: 1 });
    return;
  }
  g.poly([v[1]!.x, v[1]!.y, v[2]!.x, v[2]!.y, v[3]!.x, v[3]!.y, v[4]!.x, v[4]!.y]).fill({ color: fill, alpha: 1 });
  g.poly([v[4]!.x, v[4]!.y, v[5]!.x, v[5]!.y, v[0]!.x, v[0]!.y, v[1]!.x, v[1]!.y]).fill({ color: challengerFill, alpha: 1 });
  g.moveTo(v[4]!.x, v[4]!.y).lineTo(v[1]!.x, v[1]!.y).stroke({ color: seam, width: 1.5, alpha: 0.8 });
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

/** Nebula density band floors for the backdrop clouds. */
const NEBULA_BANDS: readonly number[] = [0.08, 0.3, 0.55, 0.8];

/** Static nebula clouds round the cluster (map pixels at `hexSize`), sampled
 *  once from the shared `nebulaField`: layered low-alpha discs in four density
 *  bands, four fills in one Graphics. */
export function drawNebulaClouds(g: Graphics, hexSize: number, color: number): void {
  g.clear();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of GALAXY_SECTORS) {
    const p = axialToPixel(s.hex, hexSize);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const pad = hexSize * 2;
  // Map pixels -> nebula galaxy space (game axes, Y up).
  const k = NEBULA_SECTOR_SPACING / Math.sqrt(3) / hexSize;
  const step = 26;
  const radius = 22;
  for (let band = 0; band < NEBULA_BANDS.length; band++) {
    const lo = NEBULA_BANDS[band]!;
    const hi = NEBULA_BANDS[band + 1] ?? 2;
    let any = false;
    for (let y = minY - pad; y <= maxY + pad; y += step) {
      for (let x = minX - pad; x <= maxX + pad; x += step) {
        const d = galaxyNebula(x * k, -y * k);
        if (d < lo || d >= hi) continue;
        g.circle(x, y, radius);
        any = true;
      }
    }
    if (any) g.fill({ color, alpha: 0.06 + 0.05 * band });
  }
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

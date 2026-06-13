#!/usr/bin/env node
/**
 * Render an EXPLODED preview of HAVOK breaking into scrap (scrap-on-death
 * Phase 2c). Each `shipScrapGroups('havok')` component is drawn (its recentred
 * sub-shapes, scaled) at its ship-layout position PLUS a small outward drift —
 * simulating the moment the ship comes apart. Pixi-up (nose up), Y not flipped.
 * Writes diag/scrap-preview.svg.
 *
 * Run: `pnpm tsx scripts/render-scrap-preview.mjs`
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shipScrapGroups } from '../src/core/geometry/shipScrapGroups.ts';
import { shipShapeScale } from '../src/core/geometry/shipHullOutline.ts';
import { getShipKind } from '../src/shared-types/shipKinds.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

const KIND = 'havok';
const DRIFT = 7; // outward explosion distance (post-scale units)
const groups = shipScrapGroups(KIND);
const scale = shipShapeScale(getShipKind(KIND));

let maxExtent = 0;
const polys = [];
for (const g of groups) {
  const cx = g.centroid[0] * scale;
  const cy = g.centroid[1] * scale;
  const len = Math.hypot(cx, cy) || 1;
  const ox = cx + (cx / len) * DRIFT; // piece origin = centroid + outward drift
  const oy = cy + (cy / len) * DRIFT;
  for (const part of g.parts) {
    const pts = part.points
      .map(([px, py]) => {
        const x = px * scale + ox;
        const y = py * scale + oy;
        maxExtent = Math.max(maxExtent, Math.abs(x), Math.abs(y));
        return `${x},${y}`;
      })
      .join(' ');
    const strokeAttrs =
      part.stroke != null
        ? ` stroke="${hex(part.stroke)}" stroke-width="${part.strokeWidth ?? 1}"`
        : '';
    polys.push(`  <polygon points="${pts}" fill="${hex(part.color)}"${strokeAttrs} />`);
  }
}

const half = (maxExtent > 0 ? maxExtent : 20) * 1.15;
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="-${half} -${half} ${half * 2} ${half * 2}">
  <rect x="-${half}" y="-${half}" width="${half * 2}" height="${half * 2}" fill="#0a0e1a" />
${polys.join('\n')}
</svg>
`;

const outDir = resolve(repoRoot, 'diag');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'scrap-preview.svg');
writeFileSync(outPath, svg, 'utf8');
console.log(`scrap preview written: ${outPath} (${groups.length} pieces, scale ${scale})`);

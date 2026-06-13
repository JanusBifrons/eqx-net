#!/usr/bin/env node
/**
 * Render the HAVOK composite ship kind to a standalone SVG preview
 * (composite-ships Phase 1, Step E). Imports the catalogue HAVOK kind, draws
 * each part as a coloured <polygon> (Pixi-up local space; Y flipped for the
 * screen so the nose points UP), with the gross collision hull as a thin
 * dashed outline. Writes diag/havok-preview.svg.
 *
 * Run: `pnpm tsx scripts/render-havok-preview.mjs`
 * (tsx is needed because the kind is authored in TypeScript with `.js`
 * ESM-extension imports + zod.)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAVOK } from '../src/shared-types/shipKinds/composite/havok.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

const shape = HAVOK.shape;
if (shape.kind !== 'composite') {
  throw new Error('expected HAVOK to be a composite shape');
}
const scale = shape.scale;

// Fit the viewBox to the hull extent (scaled), Y flipped for screen.
let maxExtent = 0;
for (const [x, y] of shape.hull) {
  maxExtent = Math.max(maxExtent, Math.abs(x) * scale, Math.abs(y) * scale);
}
const half = (maxExtent > 0 ? maxExtent : 20) * 1.15;

// Catalogue local space is Pixi-up (nose at -y). An SVG's +y is DOWN, so a
// catalogue -y point lands at the SVG TOP — i.e. drawing the catalogue points
// DIRECTLY (no extra negation) renders the nose pointing UP on screen, which
// is what this preview wants. (The in-game picker SVG additionally negates Y
// for its own top-down convention; this preview deliberately shows nose-up.)
const partPolys = shape.parts
  .map((part) => {
    const pts = part.points
      .map(([px, py]) => `${(px + part.offsetX) * scale},${(py + part.offsetY) * scale}`)
      .join(' ');
    const strokeAttrs =
      part.stroke != null
        ? ` stroke="${hex(part.stroke)}" stroke-width="${part.strokeWidth ?? 1}"`
        : '';
    return `  <polygon points="${pts}" fill="${hex(part.color)}"${strokeAttrs} />`;
  })
  .join('\n');

const hullPts = shape.hull
  .map(([x, y]) => `${x * scale},${y * scale}`)
  .join(' ');
const hullPoly = `  <polygon points="${hullPts}" fill="none" stroke="#ffffff" stroke-width="0.5" stroke-dasharray="2 2" opacity="0.5" />`;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="-${half} -${half} ${half * 2} ${half * 2}">
  <rect x="-${half}" y="-${half}" width="${half * 2}" height="${half * 2}" fill="#0a0e1a" />
${partPolys}
${hullPoly}
</svg>
`;

const outDir = resolve(repoRoot, 'diag');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'havok-preview.svg');
writeFileSync(outPath, svg, 'utf8');

console.log(`HAVOK preview written: ${outPath}`);
console.log(`  shape.scale = ${scale}`);
console.log(`  radius      = ${HAVOK.radius}`);
console.log(`  parts       = ${shape.parts.length}`);
console.log(`  hull pts    = ${shape.hull.length}`);

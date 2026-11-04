/**
 * Quick forge preview: bakes a few kinds and writes PNG sheets.
 *   pnpm tsx scripts/art-lab/preview.ts [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { forgeShip, forgeStructure } from '../../src/client/render/art/fields.js';
import { DEFAULT_RIG, litFrame } from '../../src/client/render/art/shade.js';
import { pixelFrame } from '../../src/client/__art-lab__/pixel.js';
import { encodePng, sheet } from './png.js';

const out = process.argv[2] ?? 'diag/art-lab/preview';
mkdirSync(out, { recursive: true });
const ships = ['fighter', 'heavy', 'missile-frigate', 'trader-hauler', 'havok', 'robot-hexagon'];
const t0 = performance.now();
const machined = ships.map((id) => litFrame(forgeShip(id, { ppu: 4 }), DEFAULT_RIG, DEFAULT_RIG.sunAz + Math.PI / 2));
writeFileSync(`${out}/ships-machined.png`, encodePng(...Object.values(sheet(machined, 2)) as [number, number, Uint8ClampedArray]));
const pix = ships.map((id) => pixelFrame(forgeShip(id, { ppu: 4 }), DEFAULT_RIG, { pd: 1, steps: 4, dither: 0.2, rotation: 0.3, outline: true }));
writeFileSync(`${out}/ships-pixel.png`, encodePng(...Object.values(sheet(pix, 6)) as [number, number, Uint8ClampedArray]));
const structs = ['capital', 'solar', 'turret', 'teleporter'];
const sm = structs.map((id) => litFrame(forgeStructure(id, { ppu: 0.6 }), DEFAULT_RIG, DEFAULT_RIG.sunAz));
writeFileSync(`${out}/structures-machined.png`, encodePng(...Object.values(sheet(sm, 1)) as [number, number, Uint8ClampedArray]));
console.log(`baked in ${(performance.now() - t0).toFixed(0)} ms -> ${out}`);

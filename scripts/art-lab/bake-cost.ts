/**
 * Bake cost per structure / ship kind: forge (fields), light (normals, cavity,
 * shadows, shading), size. `pnpm tsx scripts/art-lab/bake-cost.ts [ppu]`
 */
import { STRUCTURE_KINDS_LIST } from '../../src/shared-types/structureKinds.js';
import { forgeStructure } from '../../src/client/__art-lab__/forge/fields.js';
import { DEFAULT_RIG, litFrame } from '../../src/client/__art-lab__/forge/shade.js';

const ppu = Number(process.argv[2] ?? 1.5);
let tot = 0, bytes = 0;
for (const k of STRUCTURE_KINDS_LIST) {
  const t0 = performance.now();
  const f = forgeStructure(k.id, { ppu, maxSide: Number(process.argv[3] ?? 0) || undefined });
  const t1 = performance.now();
  litFrame(f, DEFAULT_RIG, DEFAULT_RIG.sunAz, true);
  const t2 = performance.now();
  const b = f.g.w * f.g.h * 4;
  tot += t2 - t0; bytes += b;
  console.log(`${k.id.padEnd(16)} ${String(f.g.w).padStart(5)}x${String(f.g.h).padEnd(5)} forge ${(t1 - t0).toFixed(0).padStart(5)} ms  light ${(t2 - t1).toFixed(0).padStart(5)} ms  ${(b / 1e6).toFixed(1)} MB`);
}
console.log(`TOTAL ${tot.toFixed(0)} ms, ${(bytes / 1e6).toFixed(1)} MB (one lit frame per kind)`);

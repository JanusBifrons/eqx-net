/**
 * Per-feature showcase clip for procedural bases (plan soft-leaping-truffle,
 * "a small showcase per feature").
 *
 * Renders a base with the SAME draw plan the in-game BaseRenderer uses
 * (`buildChunkVisual` — identical rects, colours, lights, pixi Y-flip) into a
 * plain canvas page and records an eased camera sweep with Playwright's
 * recordVideo. No game server needed (cheap on memory); in-game clips come
 * from the showcase rooms.
 *
 *   pnpm tsx scripts/showcase/base-cinematic.ts --seed 42 --size 8000 --out diag/showcase/warehouse
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { generateBase } from '../../src/core/procgen/generateBase.js';
import { BASE_GENERATOR_VERSION } from '../../src/core/procgen/baseLayout.js';
import { chunkCount } from '../../src/core/procgen/baseChunkMesh.js';
import { buildChunkVisual } from '../../src/client/render/pixi/baseVisuals.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1]! : def;
}
const seed = Number(arg('seed', '42'));
const size = Number(arg('size', '8000'));
const out = arg('out', 'diag/showcase/warehouse');
mkdirSync(out, { recursive: true });

const l = generateBase({ ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed, x: 0, y: 0, size });
const rects: number[] = []; // x, y, w, h, color, alpha*1000
const lights: number[] = []; // x, y, r, color
for (let c = 0; c < chunkCount(l); c++) {
  const v = buildChunkVisual(l, c);
  for (const r of v.rects) rects.push(r.x, r.y, r.w, r.h, r.color, Math.round(r.alpha * 1000));
  for (const lt of v.lights) lights.push(lt.x, lt.y, lt.r, lt.color);
}

// Pick a rack for the aisle glide: the longest rack piece.
let best = 0, bi = -1;
for (let i = 0; i < l.count; i++) if (l.kind[i] === 1 && Math.max(l.w[i]!, l.h[i]!) > best) { best = Math.max(l.w[i]!, l.h[i]!); bi = i; }
const rx = l.x[bi]!, ry = -(l.y[bi]! + l.h[bi]!), rw = l.w[bi]!, rh = l.h[bi]!;
const along = rw >= rh;
// Camera keyframes in pixi space: [t(ms), cx, cy, zoom].
const H = l.half;
// Glide ALONG the rack's centre line at a zoom that shows neighbouring rows.
const midX = rx + rw / 2, midY = ry + rh / 2;
const shots: number[][] = [
  [0, along ? rx + 300 : midX, along ? midY : ry + 300, 0.5],
  [4500, along ? rx + rw - 300 : midX, along ? midY : ry + rh - 300, 0.5],
  [8500, 0, 0, 0.11],
  [12500, H * 0.35, -H * 0.2, 0.18],
  [14500, H * 0.35, -H * 0.2, 0.18],
];

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#04060c;overflow:hidden}canvas{display:block}
#t{position:fixed;left:28px;bottom:22px;font:600 22px system-ui;color:#e8edf6;letter-spacing:.08em;text-shadow:0 2px 12px #000}
#s{position:fixed;left:28px;bottom:54px;font:500 13px system-ui;color:#8fa0bb;letter-spacing:.2em}
</style></head><body><canvas id="c" width="1280" height="720"></canvas>
<div id="s">PROCEDURAL BASES · INDUSTRY</div><div id="t">Warehouse — seed ${seed}, ${size} u</div>
<script>
const R=${JSON.stringify(rects)}, L=${JSON.stringify(lights)}, S=${JSON.stringify(shots)};
const c=document.getElementById('c'),g=c.getContext('2d');
const stars=[];for(let i=0;i<500;i++)stars.push([Math.random()*1280,Math.random()*720,Math.random()*1.4+.2,Math.random()]);
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
function cam(ms){for(let i=0;i<S.length-1;i++){const a=S[i],b=S[i+1];if(ms<=b[0]){const k=ease((ms-a[0])/(b[0]-a[0]));
 const z=Math.exp(Math.log(a[3])+(Math.log(b[3])-Math.log(a[3]))*k);return [a[1]+(b[1]-a[1])*k,a[2]+(b[2]-a[2])*k,z];}}const z=S[S.length-1];return [z[1],z[2],z[3]];}
const hex=n=>'#'+n.toString(16).padStart(6,'0');
let t0=null;function frame(ts){if(t0===null)t0=ts;const ms=ts-t0;const [cx,cy,z]=cam(ms);
 g.setTransform(1,0,0,1,0,0);g.fillStyle='#04060c';g.fillRect(0,0,1280,720);
 for(const s of stars){g.globalAlpha=.35+.5*s[3];g.fillStyle='#cfd8ff';g.fillRect((s[0]-cx*0.02*z)%1280,(s[1]-cy*0.02*z)%720,s[2],s[2]);}
 g.globalAlpha=1;g.setTransform(z,0,0,z,640-cx*z,360-cy*z);
 for(let i=0;i<R.length;i+=6){g.globalAlpha=R[i+5]/1000;g.fillStyle=hex(R[i+4]);g.fillRect(R[i],R[i+1],R[i+2],R[i+3]);}
 const p=.55+.45*Math.sin(ms*.004);for(let i=0;i<L.length;i+=4){g.fillStyle=hex(L[i+3]);g.globalAlpha=.18*p;g.beginPath();g.arc(L[i],L[i+1],L[i+2]*2.4,0,7);g.fill();g.globalAlpha=.95*p;g.beginPath();g.arc(L[i],L[i+1],L[i+2],0,7);g.fill();}
 g.globalAlpha=1;if(ms<${shots[shots.length - 1]![0]! + 300})requestAnimationFrame(frame);else document.title='done';}
requestAnimationFrame(frame);
</script></body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
await page.setContent(html);
await page.waitForFunction(() => document.title === 'done', undefined, { timeout: 60_000 });
await page.screenshot({ path: join(out, 'overview.png') });
await ctx.close();
await browser.close();
// Name the recorded clip deterministically.
const vid = readdirSync(out).find((f) => f.endsWith('.webm') && f !== 'cinematic.webm');
if (vid) renameSync(join(out, vid), join(out, 'cinematic.webm'));
console.log(`pieces ${l.count}, rects ${rects.length / 6}, lights ${lights.length / 4} → ${out}/cinematic.webm`);

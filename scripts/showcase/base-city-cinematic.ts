/**
 * Showcase clip for the CITY archetype (plan soft-leaping-truffle, PR-K2;
 * "a small showcase per feature" + "a variety of ships flying around").
 *
 * Same honest render path as the other base clips (the in-game draw plan,
 * `buildChunkVisual`), plus two-way traffic of every flyable ship kind down
 * the city's avenues — lanes computed from the layout, so every ship really
 * flies through open space.
 *
 *   pnpm tsx scripts/showcase/base-city-cinematic.ts --seed 7 --out diag/showcase/city
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { generateBase } from '../../src/core/procgen/generateBase.js';
import { BASE_GENERATOR_VERSION } from '../../src/core/procgen/baseLayout.js';
import { chunkCount } from '../../src/core/procgen/baseChunkMesh.js';
import { basePieceIndex, basePieceKindAt } from '../../src/shared-types/basePieceKinds.js';
import { buildChunkVisual } from '../../src/client/render/pixi/baseVisuals.js';
import { GAMEPLAY_SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';
import { shipHullOutline, shipPrimaryColor } from '../../src/core/geometry/shipHullOutline.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1]! : def;
}
const out = arg('out', 'diag/showcase/city');
const seed = Number(arg('seed', '7'));
const size = Number(arg('size', '8000'));
mkdirSync(out, { recursive: true });

const l = generateBase({ ver: BASE_GENERATOR_VERSION, archetype: 'city', seed, x: 0, y: 0, size });
const rects: number[] = [];
const lights: number[] = [];
for (let c = 0; c < chunkCount(l); c++) {
  const v = buildChunkVisual(l, c);
  for (const r of v.rects) rects.push(r.x, r.y, r.w, r.h, r.color, Math.round(r.alpha * 1000));
  for (const lt of v.lights) lights.push(lt.x, lt.y, lt.r, lt.color);
}
const TOWER = basePieceIndex('tower');
const SPIRE = basePieceIndex('spire');
let towers = 0;
let spire = { x: 0, y: 0 };
for (let i = 0; i < l.count; i++) {
  if (l.kind[i] === TOWER) towers++;
  if (l.kind[i] === SPIRE) spire = { x: l.x[i]! + l.w[i]! / 2, y: -(l.y[i]! + l.h[i]! / 2) };
}

// ── Lanes (game space): long straight runs clear of every solid piece. ──
const R = 110; // lane clearance
function blocked(x: number, y: number): boolean {
  for (let i = 0; i < l.count; i++) {
    if (!basePieceKindAt(l.kind[i]!).solid) continue;
    if (x > l.x[i]! - R && x < l.x[i]! + l.w[i]! + R && y > l.y[i]! - R && y < l.y[i]! + l.h[i]! + R) return true;
  }
  return false;
}
type Lane = { x0: number; y0: number; x1: number; y1: number; cross: number; vert: boolean };
const lanes: Lane[] = [];
const span = l.half - 120;
for (const vert of [false, true]) {
  for (let c = -span; c <= span; c += 40) {
    let runStart = NaN, bestLen = 0, best: [number, number] = [0, 0];
    for (let t = -span; t <= span + 30; t += 30) {
      const free = t <= span && !(vert ? blocked(c, t) : blocked(t, c));
      if (free && Number.isNaN(runStart)) runStart = t;
      if (!free && !Number.isNaN(runStart)) {
        if (t - runStart > bestLen) { bestLen = t - runStart; best = [runStart, t - 30]; }
        runStart = NaN;
      }
    }
    if (bestLen >= 2400) lanes.push(vert ? { x0: c, y0: best[0], x1: c, y1: best[1], cross: c, vert } : { x0: best[0], y0: c, x1: best[1], y1: c, cross: c, vert });
  }
}
// Spread: keep parallel lanes ≥ 500 u apart; longest first.
const picked: Lane[] = [];
for (const ln of lanes.sort((a, b) => Math.hypot(b.x1 - b.x0, b.y1 - b.y0) - Math.hypot(a.x1 - a.x0, a.y1 - a.y0))) {
  if (picked.every((p) => p.vert !== ln.vert || Math.abs(p.cross - ln.cross) > 500)) picked.push(ln);
  if (picked.length >= 9) break;
}
// The chase lane: the most central avenue (it runs past the tower core).
const chase = [...picked].sort((a, b) => Math.abs(a.cross) - Math.abs(b.cross))[0]!;
picked.splice(picked.indexOf(chase), 1);
picked.unshift(chase);

// ── Fleet: two-way traffic, every flyable kind. ──
const kinds = GAMEPLAY_SHIP_KINDS_LIST;
const fleet: Array<Record<string, unknown>> = [];
let k = 0;
for (const ln of picked) {
  // The chase avenue carries four ships (two each way) so the shot reads as traffic.
  for (const side of ln === chase ? [-1, 1, -1, 1] : [-1, 1]) {
    const kind = kinds[k % kinds.length]!;
    const ox = ln.vert ? side * 45 : 0, oy = ln.vert ? 0 : side * 45;
    // side −1 runs forward, +1 runs back (phase offset half a loop).
    fleet.push({
      x0: ln.x0 + ox, y0: -(ln.y0 + oy), x1: ln.x1 + ox, y1: -(ln.y1 + oy),
      speed: 300 + ((k * 97) % 240),
      phase: side < 0 ? (k * 0.23) % 0.5 : 0.5 + ((k * 0.23) % 0.5),
      color: shipPrimaryColor(kind),
      pts: shipHullOutline(kind).flat(),
    });
    k++;
  }
}
const kindsShown = new Set(fleet.map((_, i) => kinds[i % kinds.length]!.id));

// Camera keyframes: [t, x | 'chase', y, zoom, caption].
const H = l.half;
const T_END = 21000;
const shots = [
  [0, 0, 0, 0.1, 'A city, grown from one seed'],
  [3200, 0, 0, 0.12, ''],
  [6200, spire.x, spire.y, 0.55, 'The plaza: a spire landmark at the true centre'],
  [8400, spire.x, spire.y, 0.6, ''],
  [10400, 'chase', 0, 0.5, 'Avenues wide enough to fly — two-way traffic'],
  [13600, 'chase', 0, 0.55, ''],
  [16200, H * 0.15, -H * 0.1, 0.3, 'Tower core · habitat ring · outskirts'],
  [18600, 0, 0, 0.1, `seed ${seed} · ${size} u · ${l.count} pieces · ~60 bytes on the wire`],
  [T_END, 0, 0, 0.1, ''],
];

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#04060c;overflow:hidden}canvas{display:block}
#t{position:fixed;left:28px;bottom:22px;font:600 22px system-ui;color:#e8edf6;letter-spacing:.06em;text-shadow:0 2px 12px #000;transition:opacity .5s}
#s{position:fixed;left:28px;bottom:54px;font:500 13px system-ui;color:#8fa0bb;letter-spacing:.2em}
</style></head><body><canvas id="c" width="1280" height="720"></canvas>
<div id="s">PROCEDURAL BASES · CITIES</div><div id="t"></div>
<script>
const RS=${JSON.stringify(rects)},L=${JSON.stringify(lights)},F=${JSON.stringify(fleet)},S=${JSON.stringify(shots)},TE=${T_END};
const c=document.getElementById('c'),g=c.getContext('2d'),cap=document.getElementById('t');
const stars=[];for(let i=0;i<600;i++)stars.push([Math.random()*1280,Math.random()*720,Math.random()*1.4+.2,Math.random()]);
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
const hex=n=>'#'+n.toString(16).padStart(6,'0');
function shipPos(s,ms){const len=Math.hypot(s.x1-s.x0,s.y1-s.y0);const per=2*len/s.speed*1000;let u=((ms/per)+s.phase)%1;const fwd=u<.5;const k=fwd?u*2:2-u*2;
 return [s.x0+(s.x1-s.x0)*k,s.y0+(s.y1-s.y0)*k,fwd?Math.atan2(s.x1-s.x0,-(s.y1-s.y0)):Math.atan2(s.x0-s.x1,-(s.y0-s.y1))];}
function drawShip(x,y,rot,pts,color,scale){g.save();g.translate(x,y);g.rotate(rot);g.scale(scale,scale);
 g.fillStyle=hex(color);g.beginPath();for(let i=0;i<pts.length;i+=2){i?g.lineTo(pts[i],pts[i+1]):g.moveTo(pts[i],pts[i+1]);}g.closePath();g.fill();
 g.globalAlpha=.55;g.fillStyle='#ffd27a';g.beginPath();g.arc(0,12,5,0,7);g.fill();g.globalAlpha=1;g.restore();}
// A keyframe's point at time ms ('chase' follows ship 0 live, so blends in and out of the chase are smooth).
function pt(K,ms){if(K[1]==='chase'){const p=shipPos(F[0],ms);return [p[0],p[1]];}return [K[1],K[2]];}
let lastCap=null;
function cam(ms){for(let i=0;i<S.length-1;i++){const a=S[i],b=S[i+1];if(ms<=b[0]){const k=ease((ms-a[0])/(b[0]-a[0]));
 const pa=pt(a,ms),pb=pt(b,ms);const z=Math.exp(Math.log(a[3])+(Math.log(b[3])-Math.log(a[3]))*k);
 let ci=i;while(ci>0&&!S[ci][4])ci--;const txt=S[ci][4];if(txt!==lastCap){lastCap=txt;cap.textContent=txt;}
 return [pa[0]+(pb[0]-pa[0])*k,pa[1]+(pb[1]-pa[1])*k,z];}}const z=S[S.length-1];return [z[1],z[2],z[3]];}
function draw(ms){const [cx,cy,z]=cam(ms);
 g.setTransform(1,0,0,1,0,0);g.fillStyle='#04060c';g.fillRect(0,0,1280,720);
 for(const s of stars){g.globalAlpha=.35+.5*s[3];g.fillStyle='#cfd8ff';g.fillRect(((s[0]-cx*0.02*z)%1280+1280)%1280,((s[1]-cy*0.02*z)%720+720)%720,s[2],s[2]);}
 g.globalAlpha=1;g.setTransform(z,0,0,z,640-cx*z,360-cy*z);
 // View cull + screen-size LOD (sub-pixel detail like windows is skipped when far out).
 const vx0=cx-640/z,vx1=cx+640/z,vy0=cy-360/z,vy1=cy+360/z,minS=0.7/z;
 for(let i=0;i<RS.length;i+=6){const x=RS[i],y=RS[i+1],w=RS[i+2],h=RS[i+3];if(x>vx1||y>vy1||x+w<vx0||y+h<vy0)continue;if(w<minS&&h<minS)continue;
  g.globalAlpha=RS[i+5]/1000;g.fillStyle=hex(RS[i+4]);g.fillRect(x,y,w,h);}
 const p=.55+.45*Math.sin(ms*.004);for(let i=0;i<L.length;i+=4){g.fillStyle=hex(L[i+3]);g.globalAlpha=.18*p;g.beginPath();g.arc(L[i],L[i+1],L[i+2]*2.4,0,7);g.fill();g.globalAlpha=.95*p;g.beginPath();g.arc(L[i],L[i+1],L[i+2],0,7);g.fill();}
 g.globalAlpha=1;
 const shipScale=Math.max(1,0.5/Math.max(z,.0001));
 for(const s of F){for(let k=6;k>=1;k--){const q=shipPos(s,ms-k*40);g.globalAlpha=.08*(7-k);g.fillStyle=hex(s.color);g.beginPath();g.arc(q[0],q[1],6*shipScale,0,7);g.fill();}
  g.globalAlpha=1;const q=shipPos(s,ms);drawShip(q[0],q[1],q[2],s.pts,s.color,shipScale);}
 g.globalAlpha=1;
 // Dip to black at the end.
 if(ms>TE-900){g.setTransform(1,0,0,1,0,0);g.globalAlpha=Math.min(1,(ms-(TE-900))/900);g.fillStyle='#000';g.fillRect(0,0,1280,720);g.globalAlpha=1;}
 }
let t0=null;function frame(ts){if(t0===null)t0=ts;const ms=ts-t0;draw(ms);if(ms<TE)requestAnimationFrame(frame);else document.title='done';}
window.drawAt=draw;if(!location.hash.includes('still'))requestAnimationFrame(frame);
</script></body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
await page.setContent(html);
await page.waitForFunction(() => document.title === 'done', undefined, { timeout: 90_000 });
await ctx.close();
await browser.close();
// Stills at fixed moments (same draw function, no video).
const still = await (await chromium.launch()).newPage({ viewport: { width: 1280, height: 720 } });
await still.goto('about:blank#still');
await still.setContent(html.replace("location.hash.includes('still')", 'true'));
for (const [name, ms] of [['still-skyline', 2600], ['still-plaza', 8000], ['still-avenue', 12500]] as const) {
  await still.evaluate((t) => (window as unknown as { drawAt: (ms: number) => void }).drawAt(t), ms);
  await still.screenshot({ path: join(out, name + '.png') });
}
await still.context().browser()!.close();
const vid = readdirSync(out).find((f) => f.endsWith('.webm') && f !== 'cinematic.webm');
if (vid) renameSync(join(out, vid), join(out, 'cinematic.webm'));
console.log(`city seed ${seed} ${size} u: ${l.count} pieces, ${towers} tower pieces, ${rects.length / 6} rects, lanes ${picked.length}, fleet ${fleet.length} (${[...kindsShown].join(', ')}) → ${out}/cinematic.webm`);

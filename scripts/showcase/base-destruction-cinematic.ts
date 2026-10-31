/**
 * Showcase clip for DESTRUCTIBLE base pieces (plan soft-leaping-truffle, PR-D;
 * "a small showcase per feature" + user: "would have been nice to see a
 * variety of ships flying around").
 *
 * Same honest render path as base-cinematic.ts (the in-game draw plan), plus:
 *  - a mixed fleet of real catalogue ships (hull outline + colour) flying the
 *    open lanes of the yard, computed from the layout;
 *  - a gunship beaming a rack until it breaks — the destroyed GROUP comes from
 *    the server's own `groupSplitPieces`, the debris from the renderer's
 *    `spawnDebris`, the rebuilt look from `buildChunkVisual(…, dead)`.
 *
 *   pnpm tsx scripts/showcase/base-destruction-cinematic.ts --out diag/showcase/destruction
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { generateBase } from '../../src/core/procgen/generateBase.js';
import { BASE_GENERATOR_VERSION } from '../../src/core/procgen/baseLayout.js';
import { chunkCount } from '../../src/core/procgen/baseChunkMesh.js';
import { basePieceIndex, basePieceKindAt } from '../../src/shared-types/basePieceKinds.js';
import { buildChunkVisual, spawnDebris, DEBRIS_STRIDE } from '../../src/client/render/pixi/baseVisuals.js';
import { groupSplitPieces } from '../../src/server/bases/BaseSubsystem.js';
import { GAMEPLAY_SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';
import { shipHullOutline, shipPrimaryColor } from '../../src/core/geometry/shipHullOutline.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1]! : def;
}
const out = arg('out', 'diag/showcase/destruction');
const seed = Number(arg('seed', '42'));
mkdirSync(out, { recursive: true });

const l = generateBase({ ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed, x: 0, y: 0, size: 8000 });
const RACK = basePieceIndex('rack_row');

// ── The target rack: the westmost VERTICAL rack (open floor west of it). ──
let target = -1;
for (let i = 0; i < l.count; i++) {
  if (l.kind[i] !== RACK || l.h[i]! < l.w[i]!) continue;
  if (target < 0 || l.x[i]! < l.x[target]!) target = i;
}
const { group } = groupSplitPieces(l);
const dead = new Uint32Array(Math.ceil(l.count / 32));
const destroyed: number[] = [];
for (let i = 0; i < l.count; i++) if (group[i] === group[target]) { dead[i >>> 5]! |= 1 << (i & 31); destroyed.push(i); }

function rectsFor(mask: Uint32Array | null): number[] {
  const r: number[] = [];
  for (let c = 0; c < chunkCount(l); c++) for (const o of buildChunkVisual(l, c, mask).rects) r.push(o.x, o.y, o.w, o.h, o.color, Math.round(o.alpha * 1000));
  return r;
}
const before = rectsFor(null);
const after = rectsFor(dead);
const lights: number[] = [];
for (let c = 0; c < chunkCount(l); c++) for (const lt of buildChunkVisual(l, c, dead).lights) lights.push(lt.x, lt.y, lt.r, lt.color);
const debrisBuf = new Float32Array(400 * DEBRIS_STRIDE);
const debrisN = spawnDebris(l, destroyed, debrisBuf, 0);
const debris = Array.from(debrisBuf.slice(0, debrisN * DEBRIS_STRIDE));

// ── Open lanes (game space) for the fleet: long straight runs clear of solids. ──
const R = 70; // lane clearance
function blocked(x: number, y: number): boolean {
  for (let i = 0; i < l.count; i++) {
    if (!basePieceKindAt(l.kind[i]!).solid) continue;
    if (x > l.x[i]! - R && x < l.x[i]! + l.w[i]! + R && y > l.y[i]! - R && y < l.y[i]! + l.h[i]! + R) return true;
  }
  return false;
}
type Lane = { x0: number; y0: number; x1: number; y1: number };
const lanes: Lane[] = [];
const inner = l.half - 160;
for (const vertical of [false, true]) {
  for (let c = -inner; c <= inner; c += 60) {
    let runStart = NaN, bestLen = 0, best: [number, number] = [0, 0];
    for (let t = -inner; t <= inner + 1; t += 30) {
      const free = t <= inner && !(vertical ? blocked(c, t) : blocked(t, c));
      if (free && Number.isNaN(runStart)) runStart = t;
      if (!free && !Number.isNaN(runStart)) {
        if (t - runStart > bestLen) { bestLen = t - runStart; best = [runStart, t - 30]; }
        runStart = NaN;
      }
    }
    if (bestLen >= 1800) lanes.push(vertical ? { x0: c, y0: best[0], x1: c, y1: best[1] } : { x0: best[0], y0: c, x1: best[1], y1: c });
  }
}
// Spread: keep lanes at least 400 u apart on their cross axis.
const picked: Lane[] = [];
for (const ln of lanes.sort((a, b) => Math.hypot(b.x1 - b.x0, b.y1 - b.y0) - Math.hypot(a.x1 - a.x0, a.y1 - a.y0))) {
  const vert = ln.x0 === ln.x1;
  if (picked.every((p) => (p.x0 === p.x1) !== vert || Math.abs(vert ? p.x0 - ln.x0 : p.y0 - ln.y0) > 400)) picked.push(ln);
  if (picked.length >= 10) break;
}

// The chase ship flies an AISLE: a lane flanked by solids on both sides at its
// midpoint (not an open bay floor). Put that lane first.
function rackAt(x: number, y: number): boolean {
  for (let i = 0; i < l.count; i++) {
    if (l.kind[i] !== RACK) continue;
    if (x > l.x[i]! && x < l.x[i]! + l.w[i]! && y > l.y[i]! && y < l.y[i]! + l.h[i]!) return true;
  }
  return false;
}
// Racks on BOTH sides along at least 70 % of the lane (a real rack aisle).
const flanked = (ln: Lane): boolean => {
  let ok = 0, n = 0;
  for (let k = 0.05; k <= 0.95; k += 0.05, n++) {
    const mx = ln.x0 + (ln.x1 - ln.x0) * k, my = ln.y0 + (ln.y1 - ln.y0) * k;
    const both = ln.x0 === ln.x1 ? rackAt(mx - 260, my) && rackAt(mx + 260, my) : rackAt(mx, my - 260) && rackAt(mx, my + 260);
    if (both) ok++;
  }
  return ok / n >= 0.7;
};
const chase = lanes.find(flanked);
if (chase) {
  const at = picked.indexOf(chase);
  if (at >= 0) picked.splice(at, 1);
  picked.unshift(chase);
  if (picked.length > 10) picked.pop();
}

// ── Fleet: one ship per lane, cycling through every flyable kind. ──
const kinds = GAMEPLAY_SHIP_KINDS_LIST;
const fleet = picked.map((ln, k) => {
  const kind = kinds[k % kinds.length]!;
  return {
    // Pixi space (y flipped).
    x0: ln.x0, y0: -ln.y0, x1: ln.x1, y1: -ln.y1,
    speed: 280 + ((k * 97) % 260),
    phase: (k * 0.37) % 1,
    color: shipPrimaryColor(kind),
    pts: shipHullOutline(kind).flat(),
  };
});
// The attacker: a gunship parked west of the target rack, nose +x.
const gun = GAMEPLAY_SHIP_KINDS_LIST.find((k) => k.id === 'gunship') ?? kinds[0]!;
const ty = -(l.y[target]! + l.h[target]! / 2);
// After the blast it flies through the gap and stops short of the NEXT solid
// (scanning +x through the post-destruction layout), then turns up that aisle.
const gameY = l.y[target]! + l.h[target]! / 2;
let stopX = l.x[target]! + l.w[target]!;
for (let x = l.x[target]! + l.w[target]!; x < l.half; x += 10) {
  let hit = false;
  for (let i = 0; i < l.count; i++) {
    if (!basePieceKindAt(l.kind[i]!).solid || (dead[i >>> 5]! & (1 << (i & 31))) !== 0) continue;
    if (x + 60 > l.x[i]! && x - 60 < l.x[i]! + l.w[i]! && gameY + 60 > l.y[i]! && gameY - 60 < l.y[i]! + l.h[i]!) { hit = true; break; }
  }
  if (hit) break;
  stopX = x;
}
const attacker = { x: l.x[target]! - 160, y: ty, faceX: l.x[target]!, stopX, color: shipPrimaryColor(gun), pts: shipHullOutline(gun).flat() };

const T_BEAM = 5600, T_BOOM = 8200, T_END = 15500;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#04060c;overflow:hidden}canvas{display:block}
#t{position:fixed;left:28px;bottom:22px;font:600 22px system-ui;color:#e8edf6;letter-spacing:.08em;text-shadow:0 2px 12px #000}
#s{position:fixed;left:28px;bottom:54px;font:500 13px system-ui;color:#8fa0bb;letter-spacing:.2em}
</style></head><body><canvas id="c" width="1280" height="720"></canvas>
<div id="s">PROCEDURAL BASES · DESTRUCTION</div><div id="t">Shoot a rack out, fly through the hole</div>
<script>
const RB=${JSON.stringify(before)},RA=${JSON.stringify(after)},L=${JSON.stringify(lights)},D=${JSON.stringify(debris)},F=${JSON.stringify(fleet)},A=${JSON.stringify(attacker)};
const ST=${DEBRIS_STRIDE},TB=${T_BEAM},TX=${T_BOOM},TE=${T_END};
const c=document.getElementById('c'),g=c.getContext('2d');
const stars=[];for(let i=0;i<500;i++)stars.push([Math.random()*1280,Math.random()*720,Math.random()*1.4+.2,Math.random()]);
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
const hex=n=>'#'+n.toString(16).padStart(6,'0');
function shipPos(s,ms){const len=Math.hypot(s.x1-s.x0,s.y1-s.y0);const per=2*len/s.speed*1000;let u=((ms/per)+s.phase)%1;const fwd=u<.5;const k=fwd?u*2:2-u*2;
 return [s.x0+(s.x1-s.x0)*k,s.y0+(s.y1-s.y0)*k,fwd?Math.atan2(s.x1-s.x0,-(s.y1-s.y0)):Math.atan2(s.x0-s.x1,-(s.y0-s.y1))];}
function drawShip(x,y,rot,pts,color,scale){g.save();g.translate(x,y);g.rotate(rot);g.scale(scale,scale);
 g.fillStyle=hex(color);g.beginPath();for(let i=0;i<pts.length;i+=2){i?g.lineTo(pts[i],pts[i+1]):g.moveTo(pts[i],pts[i+1]);}g.closePath();g.fill();
 g.globalAlpha=.55;g.fillStyle='#ffd27a';g.beginPath();g.arc(0,12,5,0,7);g.fill();g.globalAlpha=1;g.restore();}
// Camera keyframes: chase ship 0, glide to attacker, hold, pull back.
function cam(ms){const s0=shipPos(F[0],ms);
 const K=[[0,s0[0],s0[1],1.25],[4200,null,null,1.25],[5400,A.x+260,A.y,0.95],[8900,A.x+260,A.y,0.95],[11000,A.x+900,A.y,0.8],[13400,0,0,0.12],[TE,0,0,0.12]];
 for(let i=0;i<K.length-1;i++){const a=K[i],b=K[i+1];if(ms<=b[0]){let ax=a[1],ay=a[2],bx=b[1],by=b[2];
  if(ax===null||i===0){const p=shipPos(F[0],ms);ax=p[0];ay=p[1];}if(bx===null){const p=shipPos(F[0],ms);bx=p[0];by=p[1];}
  if(i===0&&b[1]===null)return [ax,ay,a[3]];
  const k=ease((ms-a[0])/(b[0]-a[0]));const z=Math.exp(Math.log(a[3])+(Math.log(b[3])-Math.log(a[3]))*k);
  if(i===1){const p=shipPos(F[0],a[0]+ (ms-a[0])*0);}
  return [ax+(bx-ax)*k,ay+(by-ay)*k,z];}}return [0,0,0.12];}
let t0=null;function frame(ts){if(t0===null)t0=ts;const ms=ts-t0;const [cx,cy,z]=cam(ms);
 g.setTransform(1,0,0,1,0,0);g.fillStyle='#04060c';g.fillRect(0,0,1280,720);
 for(const s of stars){g.globalAlpha=.35+.5*s[3];g.fillStyle='#cfd8ff';g.fillRect(((s[0]-cx*0.02*z)%1280+1280)%1280,((s[1]-cy*0.02*z)%720+720)%720,s[2],s[2]);}
 g.globalAlpha=1;g.setTransform(z,0,0,z,640-cx*z,360-cy*z);
 const R=ms<TX?RB:RA;for(let i=0;i<R.length;i+=6){g.globalAlpha=R[i+5]/1000;g.fillStyle=hex(R[i+4]);g.fillRect(R[i],R[i+1],R[i+2],R[i+3]);}
 const p=.55+.45*Math.sin(ms*.004);for(let i=0;i<L.length;i+=4){g.fillStyle=hex(L[i+3]);g.globalAlpha=.18*p;g.beginPath();g.arc(L[i],L[i+1],L[i+2]*2.4,0,7);g.fill();g.globalAlpha=.95*p;g.beginPath();g.arc(L[i],L[i+1],L[i+2],0,7);g.fill();}
 g.globalAlpha=1;
 // Fleet (+ engine trails).
 const shipScale=Math.max(1,0.5/Math.max(z,.0001)); // true size up close; enlarged markers when zoomed far out
 for(const s of F){for(let k=6;k>=1;k--){const q=shipPos(s,ms-k*40);g.globalAlpha=.08*(7-k);g.fillStyle=hex(s.color);g.beginPath();g.arc(q[0],q[1],6*shipScale,0,7);g.fill();}
  g.globalAlpha=1;const q=shipPos(s,ms);drawShip(q[0],q[1],q[2],s.pts,s.color,shipScale);}
 // Attacker + beam.
 // After the blast: fly through the hole to stopX, then turn and run up the aisle.
 const run=ms<TX+700?0:(ms-TX-700)*0.42, leg1=A.stopX-A.x;
 const ax=run<leg1?A.x+run:A.stopX, ay=run<leg1?A.y:A.y-(run-leg1), arot=run<leg1?Math.PI/2:0;
 for(let k=6;k>=1&&ms>TX+700;k--){g.globalAlpha=.08*(7-k);g.fillStyle=hex(A.color);g.beginPath();g.arc(run<leg1?ax-k*14:ax,run<leg1?ay:ay+k*14,6*shipScale,0,7);g.fill();}
 g.globalAlpha=1;drawShip(ax,ay,arot,A.pts,A.color,shipScale);
 if(ms>=TB&&ms<TX+250){const flick=.6+.4*Math.sin(ms*.09);const endX=ms<TX?A.faceX:A.x+700;g.globalAlpha=.35*flick;g.strokeStyle='#ff9a3c';g.lineWidth=14;g.beginPath();g.moveTo(A.x+18,A.y);g.lineTo(endX,A.y);g.stroke();
  g.globalAlpha=.95;g.strokeStyle='#fff1c8';g.lineWidth=4;g.beginPath();g.moveTo(A.x+18,A.y);g.lineTo(endX,A.y);g.stroke();
  if(ms<TX){g.globalAlpha=.8*flick;g.fillStyle='#ffd27a';g.beginPath();g.arc(A.faceX,A.y,18+10*flick,0,7);g.fill();}}
 // Explosion flash + debris.
 if(ms>=TX){const dt=ms-TX;if(dt<500){g.globalAlpha=1-dt/500;g.fillStyle='#fff3d0';g.beginPath();g.arc(A.faceX+150,A.y,120+dt*0.8,0,7);g.fill();}
  for(let n=0;n<D.length;n+=ST){const life=D[n+6]-dt;if(life<=0)continue;const a=life/D[n+6];const tt=dt/1000;const dr=(1-Math.pow(.985,dt/16.7))/(1-.985)*16.7/1000;
   const x=D[n]+D[n+2]*dr,y=D[n+1]+D[n+3]*dr,sz=D[n+4];g.globalAlpha=a;g.save();g.translate(x,y);g.rotate(D[n+7]*tt);g.fillStyle=hex(D[n+5]);g.fillRect(-sz/2,-sz*.3,sz,sz*.6);g.restore();}}
 g.globalAlpha=1;if(ms<TE)requestAnimationFrame(frame);else document.title='done';}
requestAnimationFrame(frame);
</script></body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
await page.setContent(html);
await page.waitForFunction(() => document.title === 'done', undefined, { timeout: 60_000 });
await ctx.close();
await browser.close();
const vid = readdirSync(out).find((f) => f.endsWith('.webm') && f !== 'cinematic.webm');
if (vid) renameSync(join(out, vid), join(out, 'cinematic.webm'));
console.log(`chase-in-aisle ${chase ? 'yes' : 'NO'}, lanes ${picked.length}, fleet ${fleet.length} (${[...new Set(fleet.map((_, k) => kinds[k % kinds.length]!.id))].join(', ')}), destroyed ${destroyed.length} pieces, debris ${debrisN} → ${out}/cinematic.webm`);

/**
 * Design sheet for the structure redesign (plan soft-leaping-truffle v2,
 * phase V). Renders, with the SAME draw plans the game will use
 * (`structureVisuals.ts`):
 *  1. every structure kind, old regular-polygon silhouette vs the new
 *     architectural footprint, with a fighter drawn at true scale;
 *  2. the gate structures: Shield Gate (closed / open) and Shield Airlock
 *     (closed / end A open / end B open — never both);
 *  3. a small outpost whose fence is a rectangle hugging the base's extent
 *     (not a circle), with a Shield Gate on one side and an Airlock on another.
 *
 *   pnpm tsx scripts/showcase/structure-design-sheet.ts [outDir]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { STRUCTURE_KINDS_LIST, getStructureKind } from '../../src/shared-types/structureKinds.js';
import { buildStructureVisual, PROPOSED_FOOTPRINTS, type GateState } from '../../src/client/render/pixi/structureVisuals.js';
import { shipHullOutline, shipPrimaryColor } from '../../src/core/geometry/shipHullOutline.js';
import { GAMEPLAY_SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';

const out = process.argv[2] ?? 'diag/showcase/structure-redesign';
mkdirSync(out, { recursive: true });

const GATE_ACCENT = 0x66ccaa; // the shield-pylon tint (gates are pylon variants)
const NAMES: Record<string, string> = { shield_gate: 'Shield Gate', shield_airlock: 'Shield Airlock' };
function accentOf(kind: string): number {
  return kind === 'shield_gate' || kind === 'shield_airlock' ? GATE_ACCENT : getStructureKind(kind).color;
}
function plan(kind: string, seed: number, gate?: GateState) {
  const v = buildStructureVisual(kind, { accent: accentOf(kind), seed, gate });
  return {
    rects: v.rects.map((r) => [r.x, r.y, r.w, r.h, r.color, Math.round(r.alpha * 1000)]),
    lights: v.lights.map((l) => [l.x, l.y, l.r, l.color]),
    fp: v.footprint,
  };
}

// Sheet 1: every existing kind, old vs new.
const kinds = STRUCTURE_KINDS_LIST.map((k) => k.id).filter((id) => PROPOSED_FOOTPRINTS[id]);
const sheet = kinds.map((id, i) => ({ id, name: getStructureKind(id).displayName ?? id, oldR: getStructureKind(id).radius, ...plan(id, i + 1) }));
const fk = GAMEPLAY_SHIP_KINDS_LIST.find((k) => k.id === 'fighter')!;
const fighter = { pts: shipHullOutline(fk).flat(), color: shipPrimaryColor(fk) };

// Sheet 2: gates in each state.
const gates = [
  { label: 'Shield Gate — closed', ...plan('shield_gate', 1, 'closed') },
  { label: 'Shield Gate — open (a ship is approaching)', ...plan('shield_gate', 1, 'open') },
  { label: 'Airlock — both ends closed', ...plan('shield_airlock', 1, 'closed') },
  { label: 'Airlock — end A open', ...plan('shield_airlock', 1, 'openA') },
  { label: 'Airlock — end B open', ...plan('shield_airlock', 1, 'openB') },
];

// Sheet 3: the outpost with a rectangular fence that hugs the base.
type Item = { kind: string; x: number; y: number; rot?: 0 | 90; gate?: GateState };
const core: Item[] = [
  { kind: 'capital', x: 0, y: 0 },
  { kind: 'connector', x: 420, y: 0 }, { kind: 'connector', x: -420, y: 0 },
  { kind: 'connector', x: 0, y: 420 }, { kind: 'connector', x: 0, y: -420 },
  { kind: 'cargo_bay', x: 700, y: 140 }, { kind: 'cargo_bay', x: 700, y: -140 }, { kind: 'cargo_bay', x: 1060, y: 140 }, { kind: 'cargo_bay', x: 1060, y: -140 },
  { kind: 'connector', x: 880, y: 0 },
  { kind: 'solar', x: -700, y: 120 }, { kind: 'solar', x: -700, y: -120 }, { kind: 'solar', x: -1100, y: 120 }, { kind: 'solar', x: -1100, y: -120 },
  { kind: 'connector', x: -900, y: 0 },
  { kind: 'battery', x: -160, y: 640 }, { kind: 'battery', x: 160, y: 640 },
  { kind: 'turret', x: 0, y: -720 }, { kind: 'missile_turret', x: 300, y: -640 }, { kind: 'laser_bolt_turret', x: -300, y: -640 },
];
// Fence rectangle = the base's footprint extent + a margin (contour-hugging),
// pylons at ≤ 400 u spacing, corners included; a Shield Gate replaces the
// east-middle span and an Airlock the west-middle span.
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const it of core) {
  const f = PROPOSED_FOOTPRINTS[it.kind]!;
  minX = Math.min(minX, it.x - f.w / 2); maxX = Math.max(maxX, it.x + f.w / 2);
  minY = Math.min(minY, it.y - f.h / 2); maxY = Math.max(maxY, it.y + f.h / 2);
}
const M = 220;
const fx0 = Math.floor(minX - M), fx1 = Math.ceil(maxX + M), fy0 = Math.floor(minY - M), fy1 = Math.ceil(maxY + M);
// Each fence side is built as SEGMENTS ending exactly at the gate posts, so
// the shield is continuous right up to the Shield Gate / Airlock.
const gateHalf = PROPOSED_FOOTPRINTS.shield_gate!.w / 2 - PROPOSED_FOOTPRINTS.shield_gate!.h / 2; // post centre
const lockHalf = PROPOSED_FOOTPRINTS.shield_airlock!.h / 2 - 32; // airlock outer post centre (rotated 90)
const segs: Array<[number, number, number, number]> = [
  [fx0, fy0, fx1, fy0],
  [fx1, fy0, fx1, -gateHalf], [fx1, gateHalf, fx1, fy1],
  [fx1, fy1, fx0, fy1],
  [fx0, fy1, fx0, lockHalf], [fx0, -lockHalf, fx0, fy0],
];
const pylons = new Map<string, [number, number]>();
const spans: number[][] = [];
for (const [ax, ay, bx, by] of segs) {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 400));
  let px = ax, py = ay;
  for (let i = 1; i <= n; i++) {
    const x = Math.round(ax + ((bx - ax) * i) / n), y = Math.round(ay + ((by - ay) * i) / n);
    spans.push([px, py, x, y]);
    px = x; py = y;
  }
  for (let i = 0; i <= n; i++) {
    const x = Math.round(ax + ((bx - ax) * i) / n), y = Math.round(ay + ((by - ay) * i) / n);
    // Segment ends that touch a gate are the gate's own posts — no pylon there.
    const atGate = (x === fx1 && Math.abs(y) === gateHalf) || (x === fx0 && Math.abs(y) === lockHalf);
    if (!atGate) pylons.set(x + ',' + y, [x, y]);
  }
}
const gateE = { kind: 'shield_gate', x: fx1, y: 0, rot: 90 as const, gate: 'open' as GateState };
const lockW = { kind: 'shield_airlock', x: fx0, y: 0, rot: 90 as const, gate: 'openA' as GateState };
const fence: Item[] = [...pylons.values()].map(([x, y]) => ({ kind: 'shield_pylon', x, y }));
const items: Item[] = [...core, ...fence, gateE, lockW];
const itemPlans = items.map((it, i) => ({ ...it, ...plan(it.kind, i + 7, it.gate) }));
const links: number[][] = [];
const conn = (a: number, b: number): void => { links.push([core[a]!.x, core[a]!.y, core[b]!.x, core[b]!.y]); };
for (const k of [1, 2, 3, 4]) conn(0, k);
for (const k of [5, 6, 7, 8]) conn(9, k);
conn(1, 9);
for (const k of [10, 11, 12, 13]) conn(14, k);
conn(2, 14);
conn(3, 15); conn(3, 16); conn(4, 17); conn(4, 18); conn(4, 19);
links.push([880, 0, fx1 - 40, 0]); // tap the east gate
links.push([-900, 0, fx0 + 40, 0]); // tap the west airlock

const html = `<!doctype html><body style="margin:0;background:#04060c"><canvas id=a width=1600 height=560></canvas><canvas id=g width=1600 height=330></canvas><canvas id=b width=1600 height=1100></canvas><script>
const S=${JSON.stringify(sheet)},F=${JSON.stringify(fighter)},G=${JSON.stringify(gates)},O=${JSON.stringify(itemPlans)},LK=${JSON.stringify(links)},SP=${JSON.stringify(spans)};
const hex=n=>'#'+n.toString(16).padStart(6,'0');
function drawPlan(g,p,x,y,rot){g.save();g.translate(x,y);if(rot)g.rotate(-rot*Math.PI/180);for(const r of p.rects){g.globalAlpha=r[5]/1000;g.fillStyle=hex(r[4]);g.fillRect(r[0],r[1],r[2],r[3]);}
 for(const l of p.lights){g.fillStyle=hex(l[3]);g.globalAlpha=.25;g.beginPath();g.arc(l[0],l[1],l[2]*2.2,0,7);g.fill();g.globalAlpha=.95;g.beginPath();g.arc(l[0],l[1],l[2],0,7);g.fill();}g.restore();g.globalAlpha=1;}
function ship(g,x,y,s,rot){g.save();g.translate(x,y);if(rot)g.rotate(rot);g.scale(s,s);g.fillStyle=hex(F.color);g.beginPath();for(let i=0;i<F.pts.length;i+=2){i?g.lineTo(F.pts[i],-F.pts[i+1]):g.moveTo(F.pts[i],-F.pts[i+1]);}g.closePath();g.fill();g.restore();}
function poly(g,x,y,r,n,c){g.save();g.translate(x,y);g.fillStyle=hex(c);g.globalAlpha=.9;g.beginPath();for(let i=0;i<n;i++){const a=i/n*Math.PI*2-Math.PI/2;i?g.lineTo(Math.cos(a)*r,Math.sin(a)*r):g.moveTo(Math.cos(a)*r,Math.sin(a)*r);}g.closePath();g.fill();g.restore();g.globalAlpha=1;}
// Sheet 1.
const a=document.getElementById('a').getContext('2d');const z=0.42;
a.fillStyle='#cfd8ff';a.font='600 20px system-ui';a.fillText('Old (left, true size) vs redesigned (right) · fighter for scale',24,34);
let cx=40,cy=80,rowH=0;
for(const it of S){const w=it.fp.w*z,h=it.fp.h*z;if(cx+w+90>1580){cx=40;cy+=rowH+70;rowH=0;}
 poly(a,cx+20,cy+h/2,it.oldR*z,6,0x8899aa);
 a.save();a.translate(cx+50+w/2,cy+h/2);a.scale(z,z);drawPlan(a,it,0,0);a.restore();
 ship(a,cx+50+w+24,cy+h/2,z);
 a.fillStyle='#8fa0bb';a.font='13px system-ui';a.fillText(it.name+'  '+it.fp.w+'×'+it.fp.h+' u',cx,cy+h+22);
 cx+=w+150;rowH=Math.max(rowH,h);}
// Sheet 2: gates.
const gg=document.getElementById('g').getContext('2d');const zg=0.6;
gg.fillStyle='#cfd8ff';gg.font='600 20px system-ui';gg.fillText('Gates — a Shield Gate is ONE structure (two posts + a shield); an Airlock never opens both ends',24,34);
let gx=30;
G.forEach((it,i)=>{const w=it.fp.w*zg,h=it.fp.h*zg;gg.save();gg.translate(gx+w/2,180);gg.scale(zg,zg);drawPlan(gg,it,0,0);
 if(i===1)ship(gg,0,-110,1.6,Math.PI);if(i===3)ship(gg,0,-150,1.6,Math.PI);if(i===4)ship(gg,0,150,1.6,Math.PI);gg.restore();
 gg.fillStyle='#8fa0bb';gg.font='13px system-ui';gg.fillText(it.label,gx,300);gx+=w+110;});
// Sheet 3: the outpost.
const b=document.getElementById('b').getContext('2d');const s=0.36;
b.save();b.translate(800,560);b.scale(s,s);
b.strokeStyle='#7cf7ff';b.lineWidth=18;b.globalAlpha=.25;for(const l of SP){b.beginPath();b.moveTo(l[0],-l[1]);b.lineTo(l[2],-l[3]);b.stroke();}
b.lineWidth=6;b.globalAlpha=.85;for(const l of SP){b.beginPath();b.moveTo(l[0],-l[1]);b.lineTo(l[2],-l[3]);b.stroke();}
b.strokeStyle='#6fb6ff';b.globalAlpha=.55;b.lineWidth=6;for(const l of LK){b.beginPath();b.moveTo(l[0],-l[1]);b.lineTo(l[2],-l[3]);b.stroke();}
b.globalAlpha=1;
for(const o of O)drawPlan(b,o,o.x,-o.y,o.rot);
for(let i=0;i<5;i++)ship(b,${fx1}+180+i*70,-10+(i%2)*30,1,-Math.PI/2);
b.restore();
b.fillStyle='#cfd8ff';b.font='600 20px system-ui';b.fillText('Outpost — fence follows the base as a rectangle; Shield Gate (east, open for arriving ships) and Airlock (west)',24,34);
document.title='done';
</script></body>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 2100 } });
await page.setContent(html);
await page.waitForFunction(() => document.title === 'done');
await page.locator('#a').screenshot({ path: `${out}/kinds.png` });
await page.locator('#g').screenshot({ path: `${out}/gates.png` });
await page.locator('#b').screenshot({ path: `${out}/outpost.png` });
await browser.close();
console.log('wrote', out, 'fence', fx0, fx1, fy0, fy1, NAMES.shield_gate);

/**
 * Design sheet for the structure redesign (plan soft-leaping-truffle v2,
 * phase V). Renders, with the SAME draw plans the game will use
 * (`structureVisuals.ts`):
 *  1. every structure kind, old regular-polygon silhouette vs the new
 *     architectural footprint, with a fighter drawn at true scale;
 *  2. a small fenced outpost composed from the new pieces.
 *
 *   pnpm tsx scripts/showcase/structure-design-sheet.ts [outDir]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { STRUCTURE_KINDS_LIST, getStructureKind } from '../../src/shared-types/structureKinds.js';
import { buildStructureVisual, PROPOSED_FOOTPRINTS } from '../../src/client/render/pixi/structureVisuals.js';
import { shipHullOutline, shipPrimaryColor } from '../../src/core/geometry/shipHullOutline.js';
import { GAMEPLAY_SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';

const out = process.argv[2] ?? 'diag/showcase/structure-redesign';
mkdirSync(out, { recursive: true });

type Item = { kind: string; x: number; y: number; rot?: number };
function plan(kind: string, seed: number) {
  const v = buildStructureVisual(kind, { accent: getStructureKind(kind).color, seed });
  return { rects: v.rects.map((r) => [r.x, r.y, r.w, r.h, r.color, Math.round(r.alpha * 1000)]), lights: v.lights.map((l) => [l.x, l.y, l.r, l.color]), fp: v.footprint };
}

// Sheet 1: kinds in a row-wrapped grid.
const kinds = STRUCTURE_KINDS_LIST.map((k) => k.id).filter((id) => PROPOSED_FOOTPRINTS[id]);
const sheet = kinds.map((id, i) => ({ id, name: getStructureKind(id).displayName ?? id, oldR: getStructureKind(id).radius, sides: 0, ...plan(id, i + 1) }));
const fighter = { pts: shipHullOutline(GAMEPLAY_SHIP_KINDS_LIST.find((k) => k.id === 'fighter')!).flat(), color: shipPrimaryColor(GAMEPLAY_SHIP_KINDS_LIST.find((k) => k.id === 'fighter')!) };

// Sheet 2: a small outpost (hand-composed for the review — the generator
// comes in phase D).
const outpost: Item[] = [
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
const R = 1500;
for (let a = 0; a < 360; a += 15) {
  if (a > 80 && a < 100) continue; // a gate on the east side
  outpost.push({ kind: 'shield_pylon', x: Math.round(Math.cos((a * Math.PI) / 180) * R), y: Math.round(Math.sin((a * Math.PI) / 180) * R) });
}
const outpostPlans = outpost.map((it, i) => ({ ...it, ...plan(it.kind, i + 7) }));
const links: number[][] = [];
const conn = (a: number, b: number): void => { links.push([outpost[a]!.x, outpost[a]!.y, outpost[b]!.x, outpost[b]!.y]); };
for (const k of [1, 2, 3, 4]) conn(0, k);
for (const k of [5, 6, 7, 8]) conn(9, k);
conn(1, 9);
for (const k of [10, 11, 12, 13]) conn(14, k);
conn(2, 14);
conn(3, 15); conn(3, 16); conn(4, 17); conn(4, 18); conn(4, 19);
const firstPylon = 20;
for (let p = firstPylon; p < outpost.length - 1; p++) conn(p, p + 1);

const html = `<!doctype html><body style="margin:0;background:#04060c"><canvas id=a width=1600 height=900></canvas><canvas id=b width=1600 height=1100></canvas><script>
const S=${JSON.stringify(sheet)},F=${JSON.stringify(fighter)},O=${JSON.stringify(outpostPlans)},LK=${JSON.stringify(links)};
const hex=n=>'#'+n.toString(16).padStart(6,'0');
function drawPlan(g,p,x,y){g.save();g.translate(x,y);for(const r of p.rects){g.globalAlpha=r[5]/1000;g.fillStyle=hex(r[4]);g.fillRect(r[0],r[1],r[2],r[3]);}
 for(const l of p.lights){g.fillStyle=hex(l[3]);g.globalAlpha=.25;g.beginPath();g.arc(l[0],l[1],l[2]*2.2,0,7);g.fill();g.globalAlpha=.95;g.beginPath();g.arc(l[0],l[1],l[2],0,7);g.fill();}g.restore();g.globalAlpha=1;}
function ship(g,x,y,s){g.save();g.translate(x,y);g.scale(s,s);g.fillStyle=hex(F.color);g.beginPath();for(let i=0;i<F.pts.length;i+=2){i?g.lineTo(F.pts[i],-F.pts[i+1]):g.moveTo(F.pts[i],-F.pts[i+1]);}g.closePath();g.fill();g.restore();}
function poly(g,x,y,r,n,c){g.save();g.translate(x,y);g.fillStyle=hex(c);g.globalAlpha=.9;g.beginPath();for(let i=0;i<n;i++){const a=i/n*Math.PI*2-Math.PI/2;i?g.lineTo(Math.cos(a)*r,Math.sin(a)*r):g.moveTo(Math.cos(a)*r,Math.sin(a)*r);}g.closePath();g.fill();g.restore();g.globalAlpha=1;}
// Sheet 1 — scale 0.42 world→px.
const a=document.getElementById('a').getContext('2d');const z=0.42;
a.fillStyle='#cfd8ff';a.font='600 20px system-ui';a.fillText('Old (left, true size) vs redesigned (right) · fighter for scale',24,34);
let cx=40,cy=80,rowH=0;
for(const it of S){const w=it.fp.w*z,h=it.fp.h*z;if(cx+w+90>1580){cx=40;cy+=rowH+70;rowH=0;}
 a.save();a.scale(1,1);poly(a,cx+20,cy+h/2,it.oldR*z,6,0x8899aa);a.restore();
 a.save();a.translate(cx+50+w/2,cy+h/2);a.scale(z,z);drawPlan(a,it,0,0);a.restore();
 ship(a,cx+50+w+24,cy+h/2,z);
 a.fillStyle='#8fa0bb';a.font='13px system-ui';a.fillText(it.name+'  '+it.fp.w+'×'+it.fp.h+' u',cx,cy+h+22);
 cx+=w+150;rowH=Math.max(rowH,h);}
// Sheet 2 — the outpost at scale 0.3, centred.
const b=document.getElementById('b').getContext('2d');const s=0.33;
b.save();b.translate(800,560);b.scale(s,s);
b.strokeStyle='#6fb6ff';b.globalAlpha=.55;b.lineWidth=6;for(const l of LK){b.beginPath();b.moveTo(l[0],-l[1]);b.lineTo(l[2],-l[3]);b.stroke();}
b.globalAlpha=1;
// Shield fence spans between consecutive pylons.
b.strokeStyle='#7cf7ff';b.lineWidth=18;b.globalAlpha=.25;const pyl=O.filter(o=>o.kind==='shield_pylon');for(let i=0;i<pyl.length-1;i++){b.beginPath();b.moveTo(pyl[i].x,-pyl[i].y);b.lineTo(pyl[i+1].x,-pyl[i+1].y);b.stroke();}b.globalAlpha=1;
for(const o of O)drawPlan(b,o,o.x,-o.y);
for(let i=0;i<6;i++)ship(b,1700+i*60,-60+i*25,1);
b.restore();
b.fillStyle='#cfd8ff';b.font='600 20px system-ui';b.fillText('A small fenced outpost from the new pieces (hand-composed; ships at true scale, entering through the east gate)',24,34);
document.title='done';
</script></body>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 2000 } });
await page.setContent(html);
await page.waitForFunction(() => document.title === 'done');
await page.locator('#a').screenshot({ path: `${out}/kinds.png` });
await page.locator('#b').screenshot({ path: `${out}/outpost.png` });
await browser.close();
console.log('wrote', out);

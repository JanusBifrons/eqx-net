// Frame-to-frame motion of (a) the tracked fighter and (b) the background,
// by SSD block matching with sub-pixel parabola refinement, on raw screencast
// frames in arrival order. Usage: node motion.mjs <clipDir> [start] [count] [out.csv]
// Used by showcase QA (showcase/wobble.ts) to flag jittery takes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const dir = process.argv[2];
const start = +(process.argv[3] ?? 0);
const count = +(process.argv[4] ?? 1e9);
const W = 1280, H = 720, FS = W * H * 3;
const idx = JSON.parse(fs.readFileSync(`${dir}/frames.json`, 'utf8')).frames;
const n = Math.min(count, idx.length - start);
const ff = spawn('ffmpeg', ['-loglevel', 'error', '-start_number', String(start), '-i', `${dir}/frames/%06d.jpg`, '-frames:v', String(n), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
let pend = Buffer.alloc(0);
let fi = 0;
let prevG = null, cur = null;
let ship = null; // [x,y]
let shipV = [0, 0];
const T = 24; // half template ship
// background patches grid
const PB = 24; // half
const patches = [];
for (let gy = 0; gy < 6; gy++) for (let gx = 0; gx < 10; gx++) patches.push({ x: Math.round(80 + gx * (W - 160) / 9), y: Math.round(70 + gy * (H - 140) / 5), v: [0, 0] });
const out = ['f,t,dt,shipX,shipY,sdx,sdy,bgdx,bgdy,bgN,bgSpread,greenN'];

function gray(rgb) { const g = new Float32Array(W * H); for (let i = 0, j = 0; i < W * H; i++, j += 3) g[i] = 0.299 * rgb[j] + 0.587 * rgb[j + 1] + 0.114 * rgb[j + 2]; return g; }
function greenCentroid(rgb, cx, cy, r) {
  let sx = 0, sy = 0, k = 0;
  for (let y = Math.max(0, cy - r); y < Math.min(H, cy + r); y++) for (let x = Math.max(0, cx - r); x < Math.min(W, cx + r); x++) {
    const i = (y * W + x) * 3; const R = rgb[i], G = rgb[i + 1], B = rgb[i + 2];
    if (G > 120 && G > R + 40 && G > B + 10) { sx += x; sy += y; k++; }
  }
  return k > 5 ? [sx / k, sy / k, k] : null;
}
function variance(g, cx, cy, h) { let s = 0, s2 = 0, k = 0; for (let y = cy - h; y < cy + h; y++) for (let x = cx - h; x < cx + h; x++) { const v = g[y * W + x]; s += v; s2 += v * v; k++; } return s2 / k - (s / k) ** 2; }
// match template from a (centered cx,cy half h) in b around (cx+px, cy+py) +-r
function match(a, b, cx, cy, h, px, py, r) {
  const ipx = Math.round(px), ipy = Math.round(py);
  const ssd = new Float64Array((2 * r + 1) ** 2);
  let best = Infinity, bx = 0, by = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const ox = ipx + dx, oy = ipy + dy;
    if (cx - h + ox < 0 || cx + h + ox >= W || cy - h + oy < 0 || cy + h + oy >= H) { ssd[(dy + r) * (2 * r + 1) + dx + r] = Infinity; continue; }
    let s = 0;
    for (let y = -h; y < h; y++) { const ra = (cy + y) * W + cx, rb = (cy + y + oy) * W + cx + ox; for (let x = -h; x < h; x++) { const d = a[ra + x] - b[rb + x]; s += d * d; } }
    ssd[(dy + r) * (2 * r + 1) + dx + r] = s;
    if (s < best) { best = s; bx = dx; by = dy; }
  }
  const at = (dx, dy) => (Math.abs(dx) > r || Math.abs(dy) > r ? NaN : ssd[(dy + r) * (2 * r + 1) + dx + r]);
  const sub = (m, c, p) => { const den = m - 2 * c + p; return Number.isFinite(den) && den > 0 ? 0.5 * (m - p) / den : 0; };
  const fx = sub(at(bx - 1, by), best, at(bx + 1, by)), fy = sub(at(bx, by - 1), best, at(bx, by + 1));
  const edge = Math.abs(bx) === r || Math.abs(by) === r;
  return { dx: ipx + bx + fx, dy: ipy + by + fy, err: best / (4 * h * h), edge };
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
function proc(rgb) {
  const g = gray(rgb);
  const f = start + fi, t = idx[f].t, dt = fi > 0 ? t - idx[f - 1].t : 0;
  let gc = null;
  if (!ship) { gc = greenCentroid(rgb, W / 2, H / 2, 200); ship = gc ? [Math.round(gc[0]), Math.round(gc[1])] : [W / 2, H / 2]; }
  let sdx = NaN, sdy = NaN, bgdx = NaN, bgdy = NaN, bgN = 0, spread = NaN;
  if (prevG) {
    // ship: template around prev ship pos in prev frame
    const cx = Math.round(ship[0]), cy = Math.round(ship[1]);
    if (cx > T + 30 && cx < W - T - 30 && cy > T + 30 && cy < H - T - 30) {
      const m = match(prevG, g, cx, cy, T, shipV[0], shipV[1], 6);
      sdx = m.dx; sdy = m.dy; shipV = [m.dx, m.dy];
      ship = [ship[0] + m.dx, ship[1] + m.dy];
      // re-anchor on green centroid occasionally to avoid drift off the hull
      if (fi % 30 === 0) { const c = greenCentroid(rgb, cx, cy, 60); if (c) ship = [c[0], c[1]]; }
    }
    const dxs = [], dys = [];
    for (const p of patches) {
      if (Math.hypot(p.x - ship[0], p.y - ship[1]) < 90) continue;
      if (variance(prevG, p.x, p.y, PB) < 30) continue;
      const m = match(prevG, g, p.x, p.y, PB, p.v[0], p.v[1], 5);
      if (m.edge) { p.v = [0, 0]; continue; }
      p.v = [m.dx, m.dy];
      dxs.push(m.dx); dys.push(m.dy);
    }
    bgN = dxs.length;
    if (bgN) { bgdx = med(dxs); bgdy = med(dys); spread = med(dxs.map((x, i) => Math.hypot(x - bgdx, dys[i] - bgdy))); }
  }
  out.push([f, t.toFixed(2), dt.toFixed(2), ship[0].toFixed(2), ship[1].toFixed(2), sdx.toFixed(3), sdy.toFixed(3), bgdx.toFixed(3), bgdy.toFixed(3), bgN, spread.toFixed(3), gc ? gc[2] : ''].join(','));
  prevG = g; fi++;
}
ff.stdout.on('data', (d) => {
  pend = Buffer.concat([pend, d]);
  while (pend.length >= FS) { proc(pend.subarray(0, FS)); pend = pend.subarray(FS); }
});
// fd 1 (stdout) works on every OS; '/dev/stdout' does not exist on Windows.
ff.on('close', () => { fs.writeFileSync(process.argv[5] ?? 1, out.join('\n') + '\n'); });

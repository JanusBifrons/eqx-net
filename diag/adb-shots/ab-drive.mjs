// A/B capture driver — drives the PHONE (raw CDP) through a fixed
// mixed-activity schedule (fly / idle / fire) so two runs (main vs branch)
// are workload-matched. Idle gaps are deliberate: Wi-Fi power-save stalls
// hide under constant traffic. Prints the newest capture dir afterward.
//
// Usage: node ab-drive.mjs <label>   (label only used in console output)
import { readdirSync, statSync } from 'node:fs';

const HOST = 'http://localhost:9222';
const CAPROOT = 'C:/Users/alecv/Desktop/eqx-net/eqx-net/diag/captures';
const LABEL = process.argv[2] ?? 'run';
const REPRO_URL =
  'http://192.168.1.96:5173/?room=galaxy-sol-prime&worker=0&autocapture=1&diag=0&shipKind=interceptor';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = new Set(readdirSync(CAPROOT));

const list = await (await fetch(`${HOST}/json/list`)).json();
const tab =
  list.find((p) => p.type === 'page' && p.url.includes('5173/?autocapture=1') && !p.url.includes('room=')) ||
  list.find((p) => p.type === 'page' && p.url.includes('5173'));
if (!tab) { console.log('no EQX tab'); process.exit(1); }
const ORIGINAL = tab.url;

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
let id = 1; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = id++; pend.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;
const VK = { KeyW: 87, KeyA: 65, KeyD: 68, Space: 32 };
const KEYCH = { KeyW: 'w', KeyA: 'a', KeyD: 'd', Space: ' ' };
const held = new Set();
async function setKeys(want) {
  for (const code of held) if (!want.has(code)) { await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: KEYCH[code], windowsVirtualKeyCode: VK[code], nativeVirtualKeyCode: VK[code] }); held.delete(code); }
  for (const code of want) if (!held.has(code)) { await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: KEYCH[code], text: KEYCH[code], windowsVirtualKeyCode: VK[code], nativeVirtualKeyCode: VK[code] }); held.add(code); }
}

await send('Page.enable'); await send('Runtime.enable'); await send('Page.bringToFront');
await send('Page.navigate', { url: REPRO_URL });

// wait for spawn
let ok = false;
for (let i = 0; i < 40; i++) {
  const en = await evaluate(`document.querySelector('[data-energy-pct]')?.getAttribute('data-energy-pct')||null`);
  if (en) { ok = true; console.log(`[${LABEL}] spawned (energy=${en})`); break; }
  await sleep(500);
}
if (!ok) console.log(`[${LABEL}] WARN no spawn detected`);
await sleep(1500);

// Fixed mixed-activity schedule (~75 s). Idle phases (empty set) are where
// Wi-Fi power-save is most likely to stall the downlink.
const MODE = process.argv[3] ?? 'idle';
const STEPS = MODE === 'active'
  ? [ // CONSTANT activity — no idle gaps. Tests whether the stalls are
      // Wi-Fi power-save during lulls (constant traffic keeps the radio awake).
      ['fly+turn+fire', 19000, ['KeyW', 'KeyD', 'Space']],
      ['fly+turn+fire', 19000, ['KeyW', 'KeyA', 'Space']],
      ['fly+turn+fire', 19000, ['KeyW', 'KeyD', 'Space']],
      ['fly+turn+fire', 18000, ['KeyW', 'KeyA', 'Space']],
    ]
  : [
      ['fly+turn', 8000, ['KeyW', 'KeyD']],
      ['idle',     7000, []],
      ['fly+fire', 8000, ['KeyW', 'Space']],
      ['idle',     7000, []],
      ['turn+fire',8000, ['KeyA', 'Space']],
      ['idle',    10000, []],
      ['fly',      6000, ['KeyW']],
      ['idle',     8000, []],
      ['fire',     5000, ['Space']],
      ['idle',     8000, []],
    ];
const t0 = Date.now();
for (const [name, dur, keys] of STEPS) {
  await setKeys(new Set(keys));
  console.log(`[${LABEL}] +${((Date.now() - t0) / 1000).toFixed(0)}s ${name}`);
  await sleep(dur);
}
await setKeys(new Set());
await sleep(1500); // flush

await send('Page.navigate', { url: ORIGINAL }).catch(() => {});
await sleep(400);
ws.close();

// find the newest capture dir created during this run
await sleep(500);
const after = readdirSync(CAPROOT).filter((d) => !before.has(d));
const newest = after.map((d) => ({ d, m: statSync(`${CAPROOT}/${d}`).mtimeMs })).sort((a, b) => b.m - a.m)[0];
console.log(`[${LABEL}] NEW_CAPTURE=${newest ? newest.d : '(none — check existing newest)'}`);
console.log('done');

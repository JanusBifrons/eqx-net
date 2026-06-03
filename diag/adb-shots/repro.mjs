// Raw-CDP on-device repro driver. Talks CDP directly to ONE phone Chrome tab
// over the adb-forwarded endpoint (sidesteps Playwright's 78-tab enumeration
// hang). Spawns an Interceptor (twin beams), thrusts to build a prediction
// reconcile offset, holds fire, and screenshots the beam relative to the hull.
import { writeFileSync } from 'node:fs';

const HOST = 'http://localhost:9222';
const OUT = 'C:/Users/alecv/Desktop/eqx-net/eqx-net/diag/adb-shots';
const REPRO_URL =
  'http://192.168.1.96:5173/?room=galaxy-sol-prime&worker=0&autocapture=1&shipKind=interceptor';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Android Chrome blocks /json/new; reuse the foreground splash tab ---
const list = await (await fetch(`${HOST}/json/list`)).json();
const tab =
  list.find((p) => p.type === 'page' && p.url.includes('5173/?autocapture=1') && !p.url.includes('room=')) ||
  list.find((p) => p.type === 'page' && p.url.includes('5173') && !p.url.includes('room='));
if (!tab) { console.log('no reusable EQX tab found'); process.exit(1); }
const ORIGINAL_URL = tab.url;
console.log('reusing tab id=', tab.id, 'url=', tab.url);

// --- minimal CDP client over the tab's debugger socket ---
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = (e) => rej(new Error('ws open failed: ' + (e.message || e.type)));
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
    .result?.value;

const key = (type, code, vk, k) =>
  send('Input.dispatchKeyEvent', {
    type,
    code,
    key: k,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    ...(type === 'keyDown' && k.length === 1 ? { text: k } : {}),
  });

const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  console.log('shot:', name);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.bringToFront');

// navigate the reused tab to the repro URL
await send('Page.navigate', { url: REPRO_URL });
await sleep(1500);

// --- wait for spawn: data-pred-stats present with a localId / first snapshot ---
let spawned = false;
for (let i = 0; i < 40; i++) {
  const st = await evaluate(`(() => {
    const ps = document.querySelector('[data-pred-stats]')?.getAttribute('data-pred-stats') || null;
    const en = document.querySelector('[data-energy-pct]')?.getAttribute('data-energy-pct') || null;
    const hp = document.querySelector('[data-hull-pct]')?.getAttribute('data-hull-pct') || null;
    return JSON.stringify({ ps: ps ? ps.slice(0,160) : null, en, hp, canvas: !!document.querySelector('canvas'), diag: window.__eqxDiagEnabled ?? null });
  })()`);
  const o = JSON.parse(st || '{}');
  if (o.ps || o.en) { console.log('spawned @', i, st); spawned = true; break; }
  if (i % 5 === 0) console.log('waiting', i, st);
  await sleep(500);
}
if (!spawned) console.log('WARN: never detected spawn — screenshotting anyway');

await sleep(1500);
await shot('repro-0-spawn');

// thrust to build a reconcile offset, then hold fire
await key('keyDown', 'KeyW', 87, 'w');
await sleep(900);
await shot('repro-1-moving');
await key('keyDown', 'Space', 32, ' ');
await sleep(250);
await shot('repro-2-fire-a');
await sleep(250);
await shot('repro-3-fire-b');
// turn while firing to maximise prediction divergence (jitter amplifier)
await key('keyDown', 'KeyA', 65, 'a');
await sleep(250);
await shot('repro-4-fire-turn');
await sleep(250);
await shot('repro-5-fire-turn-b');

const finalState = await evaluate(`(() => {
  const ps = document.querySelector('[data-pred-stats]')?.getAttribute('data-pred-stats') || null;
  const en = document.querySelector('[data-energy-pct]')?.getAttribute('data-energy-pct') || null;
  return JSON.stringify({ ps, en });
})()`);
console.log('FINAL', finalState);

// release keys
await key('keyUp', 'Space', 32, ' ');
await key('keyUp', 'KeyW', 87, 'w');
await key('keyUp', 'KeyA', 65, 'a');

// capture session id if exposed, so we can find the streamed NDJSON
const sid = await evaluate(`(window.__eqxCaptureSessionId || window.__eqxCapture?.sessionId || null)`);
console.log('captureSessionId=', sid);

await sleep(1200); // let the streamed capture flush
// restore the user's original tab URL
await send('Page.navigate', { url: ORIGINAL_URL }).catch(() => {});
await sleep(300);
ws.close();
console.log('done; restored', ORIGINAL_URL);

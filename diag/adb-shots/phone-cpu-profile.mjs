// CPU profile of the 35-drone stall scenario — names the main-thread hot functions.
// Same clean repeatable launch as phone-stall-capture.mjs, but collects a CDP
// sampling CPU profile and ranks self-time by function.
// usage: node phone-cpu-profile.mjs [profileMs]
import { execFileSync } from 'node:child_process';

const DUR = Number(process.argv[2] || 25000);
const LAN = '192.168.1.96:5173';
const devLines = execFileSync('adb', ['devices'], { encoding: 'utf8' }).split('\n').slice(1);
const SERIAL = devLines.map((l) => l.trim()).filter((l) => /\tdevice$/.test(l)).map((l) => l.split('\t')[0])[0];
if (!SERIAL) { console.log('NO ADB DEVICE'); process.exit(1); }
const adb = (...a) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const testId = `cpu-${Date.now()}`;
const URL = `http://${LAN}/?room=phone-stall-test&worker=0&startHostile=1&initialHull=1000000&initialShield=1000000&diag=0&testId=${testId}`;

console.log(`device ${SERIAL} — clean launch into 35-drone room`);
try { adb('shell', 'am force-stop com.android.chrome'); } catch { /* */ }
adb('shell', `am start -a android.intent.action.VIEW -n com.android.chrome/com.google.android.apps.chrome.Main -d '${URL}'`);
let up = false;
for (let i = 0; i < 25; i++) { await sleep(1000); try { if (adb('shell', 'cat /proc/net/unix').includes('@chrome_devtools_remote')) { up = true; break; } } catch { /* */ } }
if (!up) { console.log('no devtools socket'); process.exit(1); }
try { adb('forward', '--remove-all'); } catch { /* */ }
adb('forward', 'tcp:9222', 'localabstract:chrome_devtools_remote');

async function getJson(p) { for (let i = 0; i < 12; i++) { try { return await (await fetch('http://localhost:9222' + p, { headers: { Host: 'localhost' } })).json(); } catch { await sleep(400); } } throw new Error('CDP unreachable'); }
const pages = await getJson('/json');
const page = pages.find((p) => p.type === 'page' && (p.url || '').includes('phone-stall-test') && p.webSocketDebuggerUrl) || pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const x = pending.get(m.id); pending.delete(m.id); m.error ? x.reject(new Error(JSON.stringify(m.error))) : x.resolve(m.result); } });
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const send = (method, params) => new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: id++, method, params })); });
await send('Runtime.enable', {});
let live = false;
for (let i = 0; i < 30; i++) { await sleep(1000); const r = await send('Runtime.evaluate', { expression: `(()=>{const e=document.querySelector('[data-hull-pct]');return e?Number(e.getAttribute('data-hull-pct')):-1})()`, returnByValue: true }); if ((r?.result?.value ?? -1) > 0) { live = true; break; } }
if (!live) { console.log('not live'); process.exit(1); }
const sw = await send('Runtime.evaluate', { expression: `document.querySelector('[data-testid="swarm-count"]')?.textContent`, returnByValue: true });
console.log(`live — ${sw?.result?.value || '?'}; profiling ${DUR}ms...`);

await send('Profiler.enable', {});
await send('Profiler.setSamplingInterval', { interval: 200 }); // 200µs = high-res
await send('Profiler.start', {});
await sleep(DUR);
const { profile } = await send('Profiler.stop', {});
ws.close();

// Aggregate self-time (hitCount) by function, and roll up by url:line and by file.
const byFn = new Map(); const byFile = new Map(); let total = 0;
for (const n of profile.nodes) {
  const hc = n.hitCount || 0; total += hc; if (!hc) continue;
  const cf = n.callFrame || {};
  const fn = cf.functionName || '(anonymous)';
  const url = (cf.url || '').replace(/^https?:\/\/[^/]+\//, '').split('?')[0];
  const line = cf.lineNumber ?? -1;
  const k = `${fn} @ ${url}:${line}`;
  byFn.set(k, (byFn.get(k) || 0) + hc);
  const fileKey = url || '(native/vm)';
  byFile.set(fileKey, (byFile.get(fileKey) || 0) + hc);
}
const pct = (h) => ((h / total) * 100).toFixed(1);
console.log(`\n================ CPU PROFILE (testId=${testId}, samples=${total}) ================`);
console.log(`\nTOP 25 FUNCTIONS by self-time:`);
for (const [k, h] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${pct(h).padStart(5)}%  ${k}`);
console.log(`\nTOP 15 FILES by self-time:`);
for (const [k, h] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${pct(h).padStart(5)}%  ${k}`);
console.log(`\n(self-time = where the main thread actually spent cycles. Idle/(program) = headroom.)`);
process.exit(0);

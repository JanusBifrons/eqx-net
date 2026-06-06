// Clean, repeatable phone capture of the 35-hostile-drone stall scenario.
// EVERY run starts from an identical fresh state:
//   force-stop Chrome -> launch fresh into phone-stall-test -> wait for live ->
//   measure a fixed window from t=0 -> report + leave an autocapture NDJSON dir.
//
// Measures, correlated on one timeline:
//   - Network.webSocketFrameReceived  -> true network arrival at the page (pre-processing)
//   - injected requestAnimationFrame   -> render cadence (main-thread paint)
//   - Performance.getMetrics           -> main-thread busy fraction (Task/Script)
//   - adb CPU cluster freq + thermal   -> device DVFS / throttle state
//
// Verdict: WS gap ~500ms + busy% LOW + freq NOT capped => network/radio held frames.
//          WS steady  + busy% HIGH / rafMax spikes      => main-thread compute.
//
// usage: node phone-stall-capture.mjs [durationMs]
import { execFileSync, spawn } from 'node:child_process';

const DUR = Number(process.argv[2] || 40000);
const LAN = '192.168.1.96:5173';

// ── device ──────────────────────────────────────────────────────────────────
const devLines = execFileSync('adb', ['devices'], { encoding: 'utf8' }).split('\n').slice(1);
const SERIAL = devLines.map((l) => l.trim()).filter((l) => /\tdevice$/.test(l)).map((l) => l.split('\t')[0])[0];
if (!SERIAL) { console.log('NO ADB DEVICE'); process.exit(1); }
const adb = (...a) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
console.log(`device: ${SERIAL}`);

const testId = `stall-${Date.now()}`;
const URL = `http://${LAN}/?room=phone-stall-test&worker=0&startHostile=1&initialHull=1000000&initialShield=1000000&diag=0&autocapture=1&testId=${testId}`;

// ── fresh launch ──────────────────────────────────────────────────────────────
console.log('force-stopping Chrome (clean slate)...');
try { adb('shell', 'am force-stop com.android.chrome'); } catch { /* */ }
console.log('launching fresh into 35-drone room...');
adb('shell', `am start -a android.intent.action.VIEW -n com.android.chrome/com.google.android.apps.chrome.Main -d '${URL}'`);

// wait for devtools socket, forward
let sockUp = false;
for (let i = 0; i < 25; i++) {
  await sleep(1000);
  try { if (adb('shell', 'cat /proc/net/unix').includes('@chrome_devtools_remote')) { sockUp = true; break; } } catch { /* */ }
}
if (!sockUp) { console.log('devtools socket never appeared'); process.exit(1); }
try { adb('forward', '--remove-all'); } catch { /* */ }
adb('forward', 'tcp:9222', 'localabstract:chrome_devtools_remote');

// pick the room page
const pages = await getJson('/json');
const page = pages.find((p) => p.type === 'page' && (p.url || '').includes('phone-stall-test') && p.webSocketDebuggerUrl) || pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
if (!page) { console.log('no room page after launch'); process.exit(1); }
console.log('attached:', (page.url || '').slice(0, 70));
const c = await connect(page.webSocketDebuggerUrl);
await c.send('Runtime.enable', {});

// wait for live hull
let live = false;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const r = await c.send('Runtime.evaluate', { expression: `(()=>{const e=document.querySelector('[data-hull-pct]');return e?Number(e.getAttribute('data-hull-pct')):-1})()`, returnByValue: true });
  if ((r?.result?.value ?? -1) > 0) { live = true; console.log(`game live after ~${i + 1}s`); break; }
}
if (!live) { console.log('game never reached live hull'); process.exit(1); }

// ── measurement window from t0 ───────────────────────────────────────────────
const wsFrames = [];
c.on((m) => { if (m.method === 'Network.webSocketFrameReceived') wsFrames.push({ t: m.params.timestamp, len: m.params?.response?.payloadData?.length ?? 0 }); });
await c.send('Network.enable', {});
await c.send('Performance.enable', { timeDomain: 'timeTicks' });
await c.send('Runtime.evaluate', { expression: `(()=>{window.__lp={iv:[],last:performance.now()};const loop=()=>{const n=performance.now();window.__lp.iv.push(+(n-window.__lp.last).toFixed(1));window.__lp.last=n;requestAnimationFrame(loop)};requestAnimationFrame(loop)})()` });

// parallel CPU/thermal sampler (device-side loop, ~every 0.8s)
const cpuLog = [];
const nSamp = Math.ceil(DUR / 800) + 4;
const cpuChild = spawn('adb', ['-s', SERIAL, 'shell',
  `for n in $(seq 1 ${nSamp}); do echo "$(date +%s%3N) c4=$(cat /sys/devices/system/cpu/cpu4/cpufreq/scaling_cur_freq) c6=$(cat /sys/devices/system/cpu/cpu6/cpufreq/scaling_cur_freq) c7=$(cat /sys/devices/system/cpu/cpu7/cpufreq/scaling_cur_freq) cap6=$(cat /sys/devices/system/cpu/cpu6/cpufreq/scaling_max_freq) tmax=$(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | sort -rn | head -1) tstat=$(dumpsys thermalservice 2>/dev/null | grep -m1 'Thermal Status' | grep -oE '[0-9]+$')"; sleep 0.8; done`]);
cpuChild.stdout.on('data', (d) => { for (const line of String(d).split('\n')) { const mm = line.match(/(\d+) c4=(\d+) c6=(\d+) c7=(\d+) cap6=(\d+) tmax=(\d+) tstat=(\d+)/); if (mm) cpuLog.push({ wall: +mm[1], c4: +mm[2], c6: +mm[3], c7: +mm[4], cap6: +mm[5], tmaxC: +mm[6] / 1000, tstat: +mm[7] }); } });

const samples = [];
let lastScript = null, lastTask = null, lastTs = null;
const t0 = Date.now();
console.log(`\n>>> measuring ${DUR}ms from fresh-live t=0 (35 hostile drones driving load)...`);
while (Date.now() - t0 < DUR) {
  await sleep(1000);
  const pm = await c.send('Performance.getMetrics', {});
  const g = (n) => pm.metrics.find((x) => x.name === n)?.value ?? 0;
  const ts = g('Timestamp'), script = g('ScriptDuration'), task = g('TaskDuration');
  const r = await c.send('Runtime.evaluate', { expression: '(()=>{const a=window.__lp.iv;window.__lp.iv=[];return JSON.stringify(a)})()', returnByValue: true });
  const iv = JSON.parse(r.result.value || '[]');
  if (lastTs != null) {
    const wall = (ts - lastTs) * 1000;
    samples.push({ atS: +((Date.now() - t0) / 1000).toFixed(0), wallMs: +wall.toFixed(0), scriptMs: +((script - lastScript) * 1000).toFixed(0), taskMs: +((task - lastTask) * 1000).toFixed(0), rafN: iv.length, rafMax: iv.length ? Math.max(...iv) : 0 });
  }
  lastTs = ts; lastScript = script; lastTask = task;
}
try { cpuChild.kill(); } catch { /* */ }
await sleep(300);

// ── analysis ─────────────────────────────────────────────────────────────────
const interv = []; for (let i = 1; i < wsFrames.length; i++) interv.push((wsFrames[i].t - wsFrames[i - 1].t) * 1000);
const sorted = [...interv].sort((a, b) => a - b);
const pc = (q) => sorted.length ? +sorted[Math.floor(sorted.length * q)].toFixed(0) : 0;
const gaps = [];
for (let i = 1; i < wsFrames.length; i++) { const dt = (wsFrames[i].t - wsFrames[i - 1].t) * 1000; if (dt > 200) gaps.push({ atRelS: +((wsFrames[i].t - wsFrames[0].t)).toFixed(1), gapMs: +dt.toFixed(0) }); }

console.log(`\n================= RESULT (testId=${testId}) =================`);
console.log(`WS frames: ${wsFrames.length} | inter-arrival p50=${pc(.5)} p90=${pc(.9)} p99=${pc(.99)} max=${sorted.length ? +sorted[sorted.length - 1].toFixed(0) : 0} ms`);
console.log(`WS-arrival gaps > 200ms (NETWORK arrival, pre-processing): ${gaps.length}`);
for (const g of gaps) console.log(`   +${g.atRelS}s  gap=${g.gapMs}ms`);
console.log(`\nper-second main-thread + RAF:`);
console.log(`  atS  wallMs scriptMs taskMs busy%  rafN rafMax`);
for (const m of samples) { const busy = m.wallMs ? Math.round((m.taskMs / m.wallMs) * 100) : 0; const flag = (m.rafMax > 50 || busy > 60) ? '  <-- dip/busy' : ''; console.log(`  ${String(m.atS).padStart(3)} ${String(m.wallMs).padStart(6)} ${String(m.scriptMs).padStart(8)} ${String(m.taskMs).padStart(5)} ${String(busy).padStart(4)}  ${String(m.rafN).padStart(4)} ${String(m.rafMax).padStart(6)}${flag}`); }
if (cpuLog.length) {
  const c6 = cpuLog.map((x) => x.c6), caps = cpuLog.map((x) => x.cap6), temps = cpuLog.map((x) => x.tmaxC), stats = cpuLog.map((x) => x.tstat);
  console.log(`\nCPU/thermal (n=${cpuLog.length}): cpu6 min=${Math.min(...c6)} max=${Math.max(...c6)} kHz | scaling_max(cap) min=${Math.min(...caps)} max=${Math.max(...caps)} | tmax ${Math.min(...temps).toFixed(0)}-${Math.max(...temps).toFixed(0)}°C | thermalStatus max=${Math.max(...stats)}`);
  console.log(`  (cap == hwmax 2802000 => NOT thermally capped; thermalStatus 0 => no OS throttle)`);
}
console.log(`\nVERDICT GUIDE: gaps ~500ms + busy% LOW + cap==hwmax => network/radio.  WS steady + busy% HIGH / rafMax spikes => main-thread compute.`);
console.log(`autocapture NDJSON: diag/captures/<newest with id ${testId}>`);
c.close();
process.exit(0);

// ── helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function getJson(path) { for (let i = 0; i < 12; i++) { try { const r = await fetch('http://localhost:9222' + path, { headers: { Host: 'localhost' } }); return await r.json(); } catch { await sleep(400); } } throw new Error('CDP unreachable'); }
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 1; const pending = new Map(); const listeners = [];
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const x = pending.get(m.id); pending.delete(m.id); m.error ? x.reject(new Error(JSON.stringify(m.error))) : x.resolve(m.result); } else if (m.method) for (const l of listeners) l(m); });
    ws.addEventListener('open', () => resolve({ send: (method, params) => new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: id++, method, params })); }), on: (fn) => listeners.push(fn), close: () => ws.close() }));
    ws.addEventListener('error', reject);
  });
}

/**
 * Art lab phone run: loads each Machined scene in an iframe (same origin, so
 * it can drive `__artlab`), measures frame times and bake cost, then posts
 * the results to the receiver started by `scripts/art-lab/phone-server.ts`
 * (`?report=<url>`). The base loads twice so the between-session cache shows.
 */
interface LabApi {
  ready: boolean;
  bench(ms: number): Promise<{ frames: number; cpuP50: number; cpuP95: number; rafP50: number; rafP95: number }>;
  stats(): { bakeMs?: number; fxBakeMs?: number; artBakeMs?: number; art?: { smoothBytes: number; prebakeMs: number; prebakeWorkers: number; prebakeFromStore: number } };
}

interface Run { label: string; q: string; benchMs: number; page?: string }

const ART_RUNS: Run[] = [
  { label: 'base, first load', q: 'style=machined&scene=base&dpr=1', benchMs: 8000 },
  { label: 'base, cached load', q: 'style=machined&scene=base&dpr=1', benchMs: 4000 },
  { label: 'combat', q: 'style=machined&scene=combat&dpr=1', benchMs: 8000 },
  { label: 'stress (40 ships, 150 structures)', q: 'style=machined&scene=bench&n=40&dpr=1', benchMs: 10000 },
  { label: 'today\'s look, stress', q: 'style=current&scene=bench&n=40&dpr=1', benchMs: 10000 },
];

/** Round 2 (plan iridescent-seeking-rainbow v2): effects + environment, today vs new. `?set=fx`. */
const FX_RUNS: Run[] = [
  { label: 'fx: battle, today', q: 'fx=today&scene=battle&n=12&dpr=1', benchMs: 8000, page: 'fx.html' },
  { label: 'fx: battle, new (first load)', q: 'fx=new&scene=battle&n=12&dpr=1', benchMs: 8000, page: 'fx.html' },
  { label: 'fx: battle, new + shader shields', q: 'fx=new&shield=shader&scene=battle&n=12&dpr=1', benchMs: 8000, page: 'fx.html' },
  { label: 'fx: zoom sweep, today', q: 'fx=today&scene=zoom&dpr=1', benchMs: 8000, page: 'fx.html' },
  { label: 'fx: zoom sweep, new', q: 'fx=new&scene=zoom&dpr=1', benchMs: 8000, page: 'fx.html' },
  { label: 'fx: battle, today (24 a side)', q: 'fx=today&scene=battle&n=24&dpr=1', benchMs: 8000, page: 'fx.html' },
  { label: 'fx: battle, new (24 a side)', q: 'fx=new&scene=battle&n=24&dpr=1', benchMs: 8000, page: 'fx.html' },
];

/** GPU-lit ships (plan prancy-squishing-donut 1b): each lighting feature's cost. `?set=lit`. */
const LIT_RUNS: Run[] = [
  { label: 'lit: 40 ships, baked (today)', q: 'style=machined&scene=bench&n=40&dpr=1', benchMs: 6000 },
  { label: 'lit: 40 ships, lit no shadows', q: 'style=lit&look=f&selfshadow=0&scene=bench&n=40&dpr=1', benchMs: 6000 },
  { label: 'lit: 40 ships, F shadows 16', q: 'style=lit&look=f&selfshadow=16&scene=bench&n=40&dpr=1', benchMs: 6000 },
  { label: 'lit: 40 ships, F shadows 48', q: 'style=lit&look=f&selfshadow=48&scene=bench&n=40&dpr=1', benchMs: 6000 },
  { label: 'lit: 40 ships, F shadows 128', q: 'style=lit&look=f&scene=bench&n=40&dpr=1', benchMs: 6000 },
  { label: 'lit: 40 ships, F + 8 lights + engines', q: 'style=lit&look=f&points=8&engines=1&scene=bench&n=40&dpr=1', benchMs: 6000 },
  { label: 'lit: 40 ships, F + lit structures', q: 'style=lit&look=f&litstruct=1&scene=bench&n=40&dpr=1', benchMs: 6000 },
  { label: 'lit: 40 ships, everything', q: 'style=lit&look=all&scene=bench&n=40&dpr=1', benchMs: 6000 },
  { label: 'lit: capital fleet, F', q: 'style=lit&look=f&scene=capfleet&dpr=1', benchMs: 6000 },
  { label: 'lit: capital fleet, F + capital shadow/occl/bounce', q: 'style=lit&look=f&capshadow=1&capao=1&capbounce=1&scene=capfleet&dpr=1', benchMs: 6000 },
  { label: 'lit: capital fleet, everything', q: 'style=lit&look=all&scene=capfleet&dpr=1', benchMs: 6000 },
  { label: 'lit: capital fleet, realistic', q: 'style=lit&look=real&scene=capfleet&dpr=1', benchMs: 6000 },
];

const qs = new URLSearchParams(location.search);
const RUNS = qs.get('set') === 'fx' ? FX_RUNS : qs.get('set') === 'lit' ? LIT_RUNS : ART_RUNS;
// Default: the receiver on the same machine that served this page.
const REPORT = qs.get('report') ?? `${location.protocol}//${location.hostname}:5375/`;
const frame = document.getElementById('stage') as HTMLIFrameElement;
const statusEl = document.getElementById('status')!;
const out = document.getElementById('out')!;
const go = document.getElementById('go') as HTMLButtonElement;

function load(q: string, page = 'index.html'): Promise<LabApi> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    frame.onload = (): void => {
      const tick = (): void => {
        const w = frame.contentWindow as unknown as { __artlab?: LabApi; __artlabError?: string } | null;
        if (w?.__artlabError) { reject(new Error(w.__artlabError)); return; }
        if (w?.__artlab?.ready) { resolve(w.__artlab); return; }
        if (performance.now() - t0 > 120_000) { reject(new Error('lab did not start within 2 min')); return; }
        setTimeout(tick, 100);
      };
      tick();
    };
    frame.src = `./${page}?${q}&w=${innerWidth}&h=${innerHeight}`;
  });
}

async function run(): Promise<void> {
  go.disabled = true;
  go.hidden = true;
  const results: unknown[] = [];
  const lines: string[] = [];
  for (const r of RUNS) {
    statusEl.innerHTML = `Running <b>${r.label}</b>…`;
    try {
      const t0 = performance.now();
      const lab = await load(r.q, r.page);
      const loadMs = performance.now() - t0;
      const s = lab.stats();
      const bakeMs = s.bakeMs ?? (s.fxBakeMs ?? 0) + (s.artBakeMs ?? 0);
      const b = await lab.bench(r.benchMs);
      results.push({ run: r.label, loadMs: Math.round(loadMs), bakeMs: Math.round(bakeMs), fxBakeMs: s.fxBakeMs, art: s.art, bench: b });
      lines.push(`${r.label}: load ${(loadMs / 1000).toFixed(1)} s, bake ${(bakeMs / 1000).toFixed(2)} s` +
        `${s.art?.prebakeFromStore ? ` (${s.art.prebakeFromStore} cached)` : ''}, frame p50 ${b.cpuP50.toFixed(1)} ms / p95 ${b.cpuP95.toFixed(1)} ms, ` +
        `${(1000 / b.rafP50).toFixed(0)} fps`);
    } catch (e) {
      results.push({ run: r.label, error: String(e) });
      lines.push(`${r.label}: FAILED ${String(e)}`);
    }
    out.textContent = lines.join('\n');
  }
  const report = {
    when: new Date().toISOString(),
    device: {
      ua: navigator.userAgent, cores: navigator.hardwareConcurrency, dpr: devicePixelRatio,
      w: innerWidth, h: innerHeight, mem: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
    },
    results,
  };
  let sent = 'not sent (no report address)';
  if (REPORT) {
    try {
      const res = await fetch(REPORT, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(report) });
      sent = res.ok ? 'sent to the PC' : `send failed (${res.status})`;
    } catch (e) {
      sent = `send failed (${String(e)})`;
    }
  }
  statusEl.innerHTML = `<b>Done.</b> Results ${sent}.`;
}

go.addEventListener('click', () => { void run(); });
// A direct link starts on its own (`?auto=1`): nothing to tap on the phone.
if (qs.get('auto') === '1') void run();
export {};

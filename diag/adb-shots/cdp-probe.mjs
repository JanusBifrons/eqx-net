// Minimal CDP connectivity probe: connect to the phone's Chrome over the
// adb-forwarded devtools endpoint, list EQX pages, screenshot the active one.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctxs = browser.contexts();
let pages = [];
for (const c of ctxs) pages = pages.concat(c.pages());

const eqx = pages.filter((p) => p.url().includes('5173'));
console.log(`contexts=${ctxs.length} totalPages=${pages.length} eqxPages=${eqx.length}`);

// Find the splash (autocapture=1 without a room= deep-link), else first EQX page.
let target =
  eqx.find((p) => p.url().includes('?autocapture=1') && !p.url().includes('room=')) ?? eqx[0];

if (target) {
  console.log('TARGET url=', target.url());
  try {
    const title = await target.title();
    const probe = await target.evaluate(() => ({
      phase: document.querySelector('[data-testid]')?.getAttribute('data-testid') ?? null,
      hasCanvas: !!document.querySelector('canvas'),
      energyPct: document.querySelector('[data-energy-pct]')?.getAttribute('data-energy-pct') ?? null,
      predStats: document.querySelector('[data-pred-stats]')?.getAttribute('data-pred-stats') ?? null,
      diagEnabled: window.__eqxDiagEnabled ?? null,
      vis: document.visibilityState,
    }));
    console.log('title=', title);
    console.log('probe=', JSON.stringify(probe).slice(0, 400));
    await target.screenshot({ path: 'C:/Users/alecv/Desktop/eqx-net/eqx-net/diag/adb-shots/pw-splash.png' });
    console.log('screenshot saved: pw-splash.png');
  } catch (e) {
    console.log('probe error:', e.message);
  }
}

await browser.close();
console.log('done');

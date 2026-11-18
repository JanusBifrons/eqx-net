import { chromium } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl'] });
const cases = JSON.parse(process.argv[2]);
for (const [ax, ay, gx0, gy0] of cases) {
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  const p = new URLSearchParams({ room: 'cut-field-test', testId: randomUUID(), worker: '0', shipKind: 'fighter', spawnX: String(ax), spawnY: String(ay) });
  await page.goto(`http://localhost:5173/?${p}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => (window.__eqxClient?.cutFieldStats?.predBodies ?? 0) > 0, undefined, { timeout: 240000 });
  await page.waitForTimeout(3000);
  const r = await page.evaluate(async ([gx, gy]) => {
    const cl = window.__eqxClient; cl.clearHelm(); cl.setHelmCourse(gx, gy); const t0 = performance.now();
    while (performance.now() - t0 < 5000) { const o = cl.getHelmOrder(); const n = o.route?.n ?? 0;
      if (n >= 2) return { n, d: Math.round(Math.hypot(o.route.pts[(n-1)*2]-gx, o.route.pts[(n-1)*2+1]-gy)), pts: Array.from(o.route.pts.subarray(0, n*2)).map(Math.round) };
      await new Promise(r => setTimeout(r, 50)); }
    const o = cl.getHelmOrder(); return { n: 0, active: o.active };
  }, [gx0, gy0]);
  console.log(ax, ay, '->', gx0, gy0, JSON.stringify(r));
  await page.close();
}
await browser.close();

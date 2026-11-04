/**
 * Checks that baked art survives between sessions: loads the bench base twice
 * in ONE browser profile; the second load should take its art from the store.
 *   pnpm tsx scripts/art-lab/persist-check.ts
 */
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const PORT = 5374;
const vite = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort'], { shell: true, stdio: 'ignore' });
const kill = (): void => {
  if (vite.pid) { try { execFileSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
};

async function main(): Promise<void> {
  const url = `http://localhost:${PORT}/__art-lab__/index.html?style=machined&scene=bench&w=1280&h=720&n=40`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(url)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const rows: unknown[] = [];
  for (const run of ['first load', 'second load']) {
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(() => (window as unknown as { __artlab?: { ready: boolean } }).__artlab?.ready === true, undefined, { timeout: 120_000 });
    const s = await page.evaluate(() => (window as unknown as { __artlab: { stats(): { bakeMs: number; art: { prebakeMs: number; prebakeFromStore: number } } } }).__artlab.stats());
    rows.push({ run, wallBakeMs: Math.round(s.bakeMs), prebakeMs: Math.round(s.art.prebakeMs), fromStore: s.art.prebakeFromStore });
    // Give the background save time to land before the next load.
    await page.waitForTimeout(run === 'first load' ? 2500 : 0);
    await page.close();
  }
  console.log(JSON.stringify(rows));
  await browser.close();
}

void main().then(() => { kill(); process.exit(0); }, (e: unknown) => { console.error(e); kill(); process.exit(1); });

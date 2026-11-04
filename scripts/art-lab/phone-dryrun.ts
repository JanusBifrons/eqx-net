/**
 * Dry run of the phone page on this PC (phone-sized viewport, touch, DPR 3):
 * proves the run finishes and its report reaches the receiver.
 * Needs `scripts/art-lab/phone-server.ts` running.
 *   pnpm tsx scripts/art-lab/phone-dryrun.ts
 */
import { chromium } from '@playwright/test';

async function main(): Promise<void> {
  const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:5374/__art-lab__/phone.html`);
  await page.click('#go');
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Done'), undefined, { timeout: 240_000 });
  console.log(await page.textContent('#status'));
  console.log(await page.textContent('#out'));
  await browser.close();
}

void main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });

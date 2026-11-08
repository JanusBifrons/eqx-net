import { test, expect, type Browser, type Page } from '@playwright/test';

/**
 * exp/hud-mobile-first — the three experimental piloting HUDs (`?ui=a|b|c`).
 *
 * Locks the point of the experiment: on a landscape phone, a portrait phone
 * and a desktop, no two HUD controls overlap (the legacy HUD let the top-left
 * stack run into the joystick and the FIRE row run over it), and the floating
 * stick spawns under the thumb then glides back home.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

type Variant = 'a' | 'b' | 'c';
const VARIANTS: Variant[] = ['a', 'b', 'c'];

const VIEWPORTS = [
  { name: 'phone-landscape', width: 844, height: 390, touch: true },
  { name: 'phone-portrait', width: 390, height: 844, touch: true },
  { name: 'desktop', width: 1280, height: 720, touch: false },
] as const;

/** HUD elements whose VISUAL boxes must never overlap each other. */
const IDS = [
  'hud-status',
  'hud-sector',
  'wallet-chip',
  'speed-dial-fab',
  'drawer-toggle',
  'hud-move-home',
  'hud-aim-home',
  'hud-attack-home',
  'hud-fire',
  'hud-boost',
  'hud-slot',
  'hud-auto-toggle-visual',
];

async function boot(browser: Browser, v: Variant, vp: (typeof VIEWPORTS)[number]): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: vp.touch,
    isMobile: vp.touch,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/?room=test-sector&ui=${v}&fakeCredits=1`);
  await page.waitForSelector('[data-testid="game-surface"]', { timeout: 30_000 });
  await page.locator('[data-testid="hud-status"]').first().waitFor({ timeout: 30_000 });
  return { page, close: () => ctx.close() };
}

interface Box { id: string; x: number; y: number; w: number; h: number }

async function hudBoxes(page: Page): Promise<Box[]> {
  return page.evaluate((ids) => {
    const out: { id: string; x: number; y: number; w: number; h: number }[] = [];
    for (const id of ids) {
      const el =
        id === 'hud-auto-toggle-visual'
          ? (document.querySelector('[data-testid="hud-auto-toggle"]')?.firstElementChild as Element | null)
          : document.querySelector(`[data-testid="${id}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') continue;
      out.push({ id, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  }, IDS);
}

function overlaps(a: Box, b: Box): boolean {
  const pad = 1; // sub-pixel rounding
  return a.x + pad < b.x + b.w && b.x + pad < a.x + a.w && a.y + pad < b.y + b.h && b.y + pad < a.y + a.h;
}

test.describe('experimental HUD variants', () => {
  test.describe.configure({ timeout: 90_000 });

  for (const v of VARIANTS) {
    for (const vp of VIEWPORTS) {
      test(`ui=${v} ${vp.name}: no HUD controls overlap, all on screen`, async ({ browser }) => {
        const { page, close } = await boot(browser, v, vp);
        const boxes = await hudBoxes(page);
        const ids = boxes.map((b) => b.id);
        // The core controls exist for this variant/viewport.
        expect(ids).toContain('hud-status');
        if (vp.touch) {
          expect(ids).toContain('hud-move-home');
          expect(ids).toContain('hud-boost');
          if (v === 'a') expect(ids).toContain('hud-fire');
          if (v === 'b') expect(ids).toContain('hud-aim-home');
          if (v === 'c') expect(ids).toContain('hud-attack-home');
        } else {
          expect(ids).toContain('hud-fire'); // desktop fire-mode chip
        }
        for (const b of boxes) {
          expect.soft(b.x, `${b.id} left`).toBeGreaterThanOrEqual(0);
          expect.soft(b.y, `${b.id} top`).toBeGreaterThanOrEqual(0);
          expect.soft(b.x + b.w, `${b.id} right`).toBeLessThanOrEqual(vp.width + 1);
          expect.soft(b.y + b.h, `${b.id} bottom`).toBeLessThanOrEqual(vp.height + 1);
        }
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            expect
              .soft(overlaps(boxes[i]!, boxes[j]!), `${boxes[i]!.id} overlaps ${boxes[j]!.id}`)
              .toBe(false);
          }
        }
        await close();
      });
    }
  }

  test('floating move stick spawns under the thumb and glides home', async ({ browser }) => {
    const { page, close } = await boot(browser, 'a', VIEWPORTS[0]);
    const home = page.locator('[data-testid="hud-move-home"]');
    const zone = page.locator('[data-testid="hud-move-zone"]');
    const rest = await home.boundingBox();
    expect(rest).not.toBeNull();

    const touchAt = { x: 260, y: 230 };
    await zone.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: touchAt.x, clientY: touchAt.y, bubbles: true });
    const spawned = await home.boundingBox();
    expect(Math.abs(spawned!.x + spawned!.width / 2 - touchAt.x)).toBeLessThan(3);
    expect(Math.abs(spawned!.y + spawned!.height / 2 - touchAt.y)).toBeLessThan(3);
    await expect(home).toHaveAttribute('data-active', '1');

    await zone.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: touchAt.x, clientY: touchAt.y, bubbles: true });
    await expect(home).toHaveAttribute('data-active', '0');
    await expect
      .poll(async () => {
        const b = await home.boundingBox();
        return Math.abs(b!.x - rest!.x) + Math.abs(b!.y - rest!.y);
      }, { timeout: 2_000 })
      .toBeLessThan(2);
    await close();
  });

  test('no ?ui param keeps the legacy HUD', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    // A stored choice from another test must not leak in.
    await page.addInitScript(() => localStorage.removeItem('eqxHudVariant'));
    await page.goto(`${BASE_URL}/?room=test-sector`);
    await page.locator('[data-testid="sector-info-panel"]').waitFor({ timeout: 30_000 });
    await expect(page.locator('[data-testid="hud-status"]')).toHaveCount(0);
    await ctx.close();
  });
});

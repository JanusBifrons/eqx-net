/**
 * Off-screen radar — geometry lock in the `radar-sandbox` room (plan
 * sparkling-wondering-rose, Wave 2).
 *
 * User report (2026-10-31): "fix the ring radar. It draws too close, too big,
 * too opaque. Ideally nothing on screen should ever have an icon drawn, they
 * should be proportional to how far away an object is."
 *
 * The sandbox spawns the ship at a FIXED point S with contacts at measured
 * offsets (src/server/index.ts `radar-sandbox`): one ON screen, static ones at
 * graded distances/bearings, one beyond range, plus scripted movers. With the
 * camera pinned (`?zoom=1`), each user complaint becomes a geometric assertion:
 *   (a) no icon for anything visible on screen, and none beyond range;
 *   (b) "too close": every icon sits in the band at the screen EDGE, never in
 *       the play area around the ship;
 *   (c) "proportional to distance": within a category, a farther contact is
 *       never drawn bigger or more opaque than a nearer one;
 *   (d) no two icons overlap;
 *   (e) mobile: icons stay out from under the HUD (joystick / fire cluster …).
 * Plus the WORKER render path (desktop default) actually draws icons.
 *
 * Run: pnpm exec playwright test --project=feature tests/e2e/radar-sandbox.spec.ts --reporter=line
 */
import { randomUUID } from 'node:crypto';
import { test, expect, devices, type Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

// Mirrors RADAR_SANDBOX_LAYOUT in src/server/index.ts (offsets from S).
const S = { x: -3000, y: -3000 };
const ON_SCREEN = { x: S.x + 350, y: S.y };
const BEYOND_RANGE = { x: S.x + 7780, y: S.y + 7780 };
const STATIC_CONTACTS = [
  { x: S.x + 900, y: S.y },
  { x: S.x, y: S.y + 1800 },
  { x: S.x - 2500, y: S.y },
  { x: S.x + 2475, y: S.y - 2475 },
  { x: S.x + 4950, y: S.y + 4950 },
  { x: S.x - 1500, y: S.y - 1100 },
  { x: S.x - 1200, y: S.y + 1400 }, // capital
  { x: S.x + 1600, y: S.y - 1200 }, // solar
];

interface Icon {
  key: string; cat: string; wx: number; wy: number; x: number; y: number;
  size: number; alpha: number; grouped: boolean;
}

async function boot(page: Page, extra = ''): Promise<void> {
  await page.goto(`${BASE_URL}?room=radar-sandbox&testId=${randomUUID()}&zoom=1${extra}`);
  await page.waitForFunction(
    () => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0,
    undefined,
    { timeout: 20_000 },
  );
}

async function icons(page: Page): Promise<Icon[]> {
  return page.evaluate(() => ((window as unknown as { __eqxHaloDebug?: () => Icon[] }).__eqxHaloDebug?.() ?? []));
}

async function settledIcons(page: Page): Promise<Icon[]> {
  // The camera glides in from the sector origin after join — wait until it is
  // centred on the ship at S, so world/screen geometry is the steady state.
  await expect.poll(async () => {
    const c = await page.evaluate(() => (window as unknown as { __eqxCameraCenter: () => { x: number; y: number } }).__eqxCameraCenter());
    return Math.hypot(c.x - S.x, c.y - S.y);
  }, { timeout: 15_000 }).toBeLessThan(60);
  await expect.poll(async () => (await icons(page)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
  await page.waitForTimeout(600); // fade-ins (160 ms) complete; deadline, not a game-time wait
  return icons(page);
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, r: number): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) < r;

function dOffWorld(c: { x: number; y: number }, cx: number, cy: number, halfW: number, halfH: number): number {
  const dx = Math.max(0, Math.abs(c.x - cx) - halfW);
  const dy = Math.max(0, Math.abs(c.y - cy) - halfH);
  return Math.hypot(dx, dy);
}

test.describe('radar sandbox — desktop (?worker=0 geometry)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('edge band, nothing visible, distance → size + opacity, no overlap', async ({ page }) => {
    test.setTimeout(60_000); // cold room + physics worker boot; no game-time waits
    await boot(page, '&worker=0');
    const list = await settledIcons(page);
    const vp = page.viewportSize()!;
    const cam = await page.evaluate(() => (window as unknown as { __eqxCameraCenter: () => { x: number; y: number } }).__eqxCameraCenter());
    const halfW = vp.width / 2; // zoom 1 ⇒ 1 world unit per CSS px
    const halfH = vp.height / 2;

    for (const ic of list) {
      // (a) every icon's contact is OFF screen …
      const off = Math.abs(ic.wx - cam.x) > halfW || Math.abs(ic.wy - cam.y) > halfH;
      expect(off, `icon ${ic.key} points at a visible contact`).toBe(true);
      // (b) … and the icon sits in the band at the screen edge, not near the ship.
      const edgeDist = Math.min(ic.x, vp.width - ic.x, ic.y, vp.height - ic.y);
      expect(edgeDist, `icon ${ic.key} is ${edgeDist.toFixed(0)} px from the edge`).toBeLessThanOrEqual(90);
      expect(Math.hypot(ic.x - vp.width / 2, ic.y - vp.height / 2)).toBeGreaterThan(250);
    }
    // (a) explicitly: no icon for the on-screen drone or the beyond-range one.
    expect(list.some((ic) => near({ x: ic.wx, y: ic.wy }, ON_SCREEN, 80))).toBe(false);
    expect(list.some((ic) => near({ x: ic.wx, y: ic.wy }, BEYOND_RANGE, 200))).toBe(false);

    // (c) within a category: farther (beyond the screen edge) ⇒ never bigger, never more opaque.
    const statics = list.filter((ic) => !ic.grouped && STATIC_CONTACTS.some((c) => near({ x: ic.wx, y: ic.wy }, c, 60)));
    expect(
      statics.length,
      `static-contact icons; drawn: ${JSON.stringify(list.map((i) => [i.key, i.cat, Math.round(i.wx), Math.round(i.wy), i.grouped]))}`,
    ).toBeGreaterThanOrEqual(3);
    const byCat = new Map<string, Icon[]>();
    for (const ic of statics) byCat.set(ic.cat, [...(byCat.get(ic.cat) ?? []), ic]);
    for (const [, group] of byCat) {
      group.sort((a, b) => dOffWorld({ x: a.wx, y: a.wy }, cam.x, cam.y, halfW, halfH)
        - dOffWorld({ x: b.wx, y: b.wy }, cam.x, cam.y, halfW, halfH));
      for (let i = 1; i < group.length; i++) {
        expect(group[i]!.size).toBeLessThanOrEqual(group[i - 1]!.size + 0.01);
        expect(group[i]!.alpha).toBeLessThanOrEqual(group[i - 1]!.alpha + 0.01);
      }
    }
    // "too big / too opaque": researched desktop ceilings (grouped ×1.25).
    for (const ic of list) {
      expect(ic.size).toBeLessThanOrEqual(12 * 1.25 + 0.01);
      expect(ic.alpha).toBeLessThanOrEqual(0.76);
    }
    // (d) no two icons touch (size-aware; ×0.7 tolerates the diagonal across a
    // track corner, where perimeter spacing exceeds straight-line distance).
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.hypot(list[i]!.x - list[j]!.x, list[i]!.y - list[j]!.y);
        const minD = ((list[i]!.size + list[j]!.size) / 2) * 0.7;
        expect(d, `${list[i]!.key} overlaps ${list[j]!.key}`).toBeGreaterThanOrEqual(minD);
      }
    }
  });
});

test.describe('radar sandbox — desktop WORKER render path', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('the default (OffscreenCanvas worker) path draws radar icons', async ({ page }) => {
    test.setTimeout(60_000);
    await boot(page); // no ?worker=0 → worker renderer on desktop
    const surface = page.locator('[data-testid="game-surface"]');
    await expect.poll(async () => parseInt((await surface.getAttribute('data-halo-arrow-count')) ?? '0', 10), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(4);
  });
});

test.describe('radar sandbox — mobile (touch defaults + HUD avoidance)', () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['Pixel 5'];
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });

  test('touch icons are smaller and never under the HUD', async ({ page }) => {
    test.setTimeout(60_000);
    await boot(page); // touch ⇒ main-thread renderer ⇒ the debug hook works
    const list = await settledIcons(page);
    const hud = await page.evaluate(() => {
      const surface = document.querySelector('[data-testid="game-surface"]')!.getBoundingClientRect();
      const out: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const host of Array.from(document.querySelectorAll('[data-anchor]'))) {
        const a = host.getAttribute('data-anchor');
        if (a === 'fullscreen' || a === 'transit') continue;
        for (const child of Array.from(host.children)) {
          const r = child.getBoundingClientRect();
          if (r.width >= 1 && r.height >= 1) out.push({ x: r.left - surface.left, y: r.top - surface.top, w: r.width, h: r.height });
        }
      }
      return out;
    });
    expect(hud.length).toBeGreaterThan(0);
    for (const ic of list) {
      expect(ic.size).toBeLessThanOrEqual(10 * 1.25 + 0.01); // touch default ceiling
      for (const r of hud) {
        const inside = ic.x >= r.x && ic.x <= r.x + r.w && ic.y >= r.y && ic.y <= r.y + r.h;
        expect(inside, `icon ${ic.key} at (${ic.x.toFixed(0)},${ic.y.toFixed(0)}) is under a HUD widget`).toBe(false);
      }
    }
  });
});

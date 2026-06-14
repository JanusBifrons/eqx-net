/**
 * Laser-beam falloff + taper PROBE + regression lock (Equinox laser issue, plan
 * `i-d-like-you-to-typed-cray`, 2026-06-14).
 *
 * The laser fix failed FOUR rounds of the Equinox-Bugs doc — every time
 * "verified" with screenshots that captured the beam HITTING a target (where it
 * correctly stops at the hit) so the real bug never showed. This drives the
 * condition that exposes it: firing into EMPTY SPACE (no hit), where the beam
 * draws to its max range and must visibly TERMINATE and FADE, not run off the
 * screen edge ("renders infinitely").
 *
 * Root cause (fixed): the client gradient/fade beam textures are 256 px WIDE but
 * the sprite length was set as `scale.x = worldLen` (renders 256× too long), so
 * the fade stretched ~19 000 u off-screen and the beam looked solid to infinity.
 * Deterministic lock for THAT: `BeamSpritePool.solidTaper.test.ts` (injects a
 * 256-px texture). This spec is the browser-level lock + the screenshot artefact:
 * the no-hit beam must be bounded (dist ≪ the 19 000 u bug) with a visible fade
 * tail (solidDist < dist), and a hit beam clips solid to the target.
 *
 * Screenshots → `diag/e2e-screenshots/laser-falloff/`; run STEP=before / =after
 * across a change to compare. `?worker=0` = the main-thread renderer (the touch
 * default; the worker path screenshots BLACK — docs/HANDOFF-smoke-followups-2026-06-06).
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const STEP = process.env['STEP'] ?? 'after';
// Force a KNOWN, fixed camera zoom (`?zoom=`) so the screenshot is deterministic
// (without it the spawn camera ease lands captures at different scales, making
// before/after invalid). 0.5 is DEFAULT_GAMEPLAY_ZOOM.
const ZOOM = process.env['ZOOM'] ?? '0.5';
const OUT_DIR = join(process.cwd(), 'diag', 'e2e-screenshots', 'laser-falloff');

interface Beam { mountId: string; dist: number; solidDist: number; hitId?: string }

async function joinInterceptor(page: Page, room: string, extra = ''): Promise<void> {
  const testId = randomUUID();
  await page.goto(`${BASE_URL}?room=${room}&shipKind=interceptor&worker=0&zoom=${ZOOM}&testId=${testId}${extra}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 20000 },
  );
  await page.waitForTimeout(1800); // prediction settle
}

async function fireAndShoot(page: Page, name: string): Promise<{ beamActive: boolean; beams: Beam[] }> {
  mkdirSync(OUT_DIR, { recursive: true });
  // Hold manual fire (override — engages with no hostile in range, the empty-
  // space repro). Sample a few frames so the continuous beam is mid-render.
  await page.keyboard.down('Space');
  await page.waitForTimeout(400);
  const diag = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="game-surface"]') as HTMLElement | null;
    const beamActive = el?.dataset['beamActive'] === '1';
    // `mirror` is a public field on the client singleton (`readonly mirror`).
    const client = (window as unknown as { __eqxClient?: { mirror?: { liveBeams?: Map<string, { dist: number; solidDist: number; hitId?: string }> } } }).__eqxClient;
    const beams: Array<{ mountId: string; dist: number; solidDist: number; hitId?: string }> = [];
    const lb = client?.mirror?.liveBeams;
    if (lb) for (const [mountId, b] of lb) beams.push({ mountId, dist: b.dist, solidDist: b.solidDist, hitId: b.hitId });
    return { beamActive, beams };
  });
  await page.screenshot({ path: join(OUT_DIR, `${STEP}-${name}.png`), fullPage: false });
  // Tight clip of the beam column (ship is screen-centred, beam fires straight up)
  // so the tip TAPER is inspectable, not guessed from a thumbnail.
  await page.screenshot({ path: join(OUT_DIR, `${STEP}-${name}-zoom.png`), clip: { x: 590, y: 40, width: 100, height: 380 } });
  await page.keyboard.up('Space');
  return diag;
}

test('no-hit beam (empty space) — bounded length with a visible fade tail', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await joinInterceptor(page, 'test-sector-fast');
    const { beamActive, beams } = await fireAndShoot(page, 'nohit');
    expect(beamActive, 'beam should be actively firing').toBe(true);
    expect(beams.length, 'interceptor fires twin beams').toBeGreaterThanOrEqual(1);
    for (const b of beams) {
      // BOUNDED: the beam's drawn distance is the optimal × maxRangeMul (325) for
      // a miss — NOT the ~19 000 u of the texture-width bug, NOT off to infinity.
      expect(b.hitId, 'empty-space shot hits nothing').toBeUndefined();
      expect(b.dist, `no-hit beam length ${b.dist} must stay bounded`).toBeLessThan(600);
      // A FADE TAIL must exist: the solid core stops well short of the tip.
      expect(b.solidDist, 'solid core must be shorter than the drawn length (fade tail)').toBeLessThan(b.dist - 1);
    }
  } finally {
    await ctx.close();
  }
});

test('hit beam (target 150u ahead) — clips solid to the target, no tail', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    // auto-fire-test parks a hull-exposed fighter at (0,150) — within the 250u
    // beam range. Manual fire (Space) lands on it; the beam clips there, solid.
    await joinInterceptor(page, 'auto-fire-test', '&initialHull=5000');
    const { beamActive, beams } = await fireAndShoot(page, 'hit');
    expect(beamActive, 'beam should be actively firing').toBe(true);
    const hitBeams = beams.filter((b) => b.hitId !== undefined);
    expect(hitBeams.length, 'at least one beam should hit the parked drone').toBeGreaterThanOrEqual(1);
    for (const b of hitBeams) {
      // Solid all the way to the hit — solidDist === dist (no premature fade).
      expect(b.solidDist, 'a hit beam is solid to the target').toBeCloseTo(b.dist, 1);
    }
  } finally {
    await ctx.close();
  }
});

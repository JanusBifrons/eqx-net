/**
 * Smoke-test bug (user, 2026-11-06, round 3 capital fly-by clip): "the engines
 * on the fighter were wrong in the video. They weren't the ones we redesigned."
 *
 * The clip's fighter WAS drawn by the redesigned exhaust (FxEngines, PR #288:
 * flame + ribbon per nozzle), but the ribbon, the part that makes the look,
 * was ~1 hull length and hid inside the flame. In the approved exhaust lab
 * (diag/art-lab/engines-r1) it trails several hull lengths.
 *
 * Root cause: the ribbon spans a fixed 16/60 s of each nozzle's path, tuned in
 * the lab at 1x ship scale. At the 2x default ships are twice as long and
 * ~0.7x as fast, so the ribbon is ~2.8x shorter against the hull, while the
 * flame grows with the nozzle. A size-dependent number authored as a constant
 * (invariant #18). Not capital-specific: any room at 2x shows it.
 *
 * Repro: join as a fighter with `art=machined&fx=new` (the showcase's look),
 * wait until no art is pending (the recorder's `artSettled`), track it with
 * the fly-by's camera, thrust 3 s, and read `__eqxArtStats().localEngine` every
 * frame. Before the fix: ribbon 37 u behind a 48 u hull (0.76 hulls).
 */
import { test, expect, chromium } from '@playwright/test';
import { launchTestClient } from './helpers/gameScenario';
import { getShipKind } from '../../src/shared-types/shipKinds';

const GPU_ARGS = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

interface LocalEngine { drawn: boolean; thrust: number; boost: number; nozzles: number; ribbons: number; ringLen: number; resets: number; speed: number; ribbonUnits: number; nozzleR: number }
interface Stats { mode?: string; effectQuality?: string; fxRibbons?: number; fxEngines?: number; engineParticles?: number; pending?: number; ready?: number; failed?: number; fxPending?: number; lastFailure?: string }

test('a thrusting fighter trails the redesigned ribbon, several hull lengths long', async () => {
  test.setTimeout(90_000);
  const browser = await chromium.launch({ args: GPU_ARGS });
  const { ctx, page } = await launchTestClient(browser, {
    room: 'test-sector', spawnX: 0, spawnY: 0, shipKind: 'fighter', initialHull: 1_000_000,
    extraParams: { worker: '0', art: 'machined', fx: 'new', cleanworld: '1', hud: 'none', diag: '0' },
  });
  try {
    const stats = (): Promise<Stats> => page.evaluate(() => (globalThis as { __eqxArtStats?: () => Stats }).__eqxArtStats?.() ?? {});
    // As the recorder: wait until no art is still baking.
    await page.waitForFunction(() => {
      const s = (globalThis as { __eqxArtStats?: () => { pending?: number; ready?: number } }).__eqxArtStats?.();
      return !!s && (s.ready ?? 0) > 0 && (s.pending ?? 1) === 0;
    }, null, { timeout: 60_000, polling: 500 });
    // The fly-by's camera: track the pilot at the 720p capture's zoom.
    await page.evaluate(() => (globalThis as unknown as { __eqxCinema?: { play(c: unknown[]): void } }).__eqxCinema?.play([{ atMs: 0, smoothMs: 0, shot: { kind: 'track', target: 'local', zoom: 0.667, leadMs: 250 } }]));
    await page.keyboard.down('w');
    await page.waitForTimeout(3000); // up to speed, as the fly-by flies
    // The LOCAL fighter, every frame for ~1 s (the parked wing's ribbons don't count).
    const frames = await page.evaluate(() => new Promise<Array<LocalEngine | null>>((resolve) => {
      const out: Array<LocalEngine | null> = [];
      const f = (): void => {
        out.push((globalThis as { __eqxArtStats?: () => { localEngine?: LocalEngine | null } }).__eqxArtStats?.().localEngine ?? null);
        if (out.length < 60) requestAnimationFrame(f); else resolve(out);
      };
      requestAnimationFrame(f);
    }));
    const s = await stats();
    await page.keyboard.up('w');
    console.log('[engine-ribbon-length]', JSON.stringify({ ...s, localEngine: undefined }), JSON.stringify(frames.slice(0, 8)), JSON.stringify(frames.slice(-3)));
    expect(s.mode).toBe('machined');
    expect(s.failed ?? 0, `art failures: ${s.lastFailure ?? ''}`).toBe(0);
    const drawn = frames.filter((f) => f?.drawn);
    expect(drawn.length, 'the local fighter is drawn by the new engines').toBe(frames.length);
    // Thrust held: the engine is lit...
    expect(Math.min(...drawn.map((f) => f!.thrust))).toBeGreaterThan(0.8);
    // ...and the redesign's RIBBON trails every nozzle, every frame (high/medium quality).
    const ribbonless = drawn.filter((f) => f!.ribbons < f!.nozzles).length;
    expect(ribbonless, `frames with a nozzle missing its ribbon (quality ${s.effectQuality})`).toBe(0);
    // ...and it trails well clear of the flame: the lab's approved look was a
    // ribbon several hull lengths long at cruise. Authored at 1x, it came out
    // ~1 hull at the 2x default (bigger and slower ships) and hid in the flame.
    // Its length follows speed, and the ship is still speeding up, so judge
    // the drawn ribbon's span in seconds (length / speed) as hull lengths at
    // top speed: ~9.4 in the lab (1x); 3.3 here before the fix.
    const fighter = getShipKind('fighter'), hullLen = 2 * fighter.radius;
    const median = drawn.map((f) => f!.ribbonUnits).sort((a, b) => a - b)[drawn.length >> 1]!;
    const meanSpeed = drawn.reduce((a, f) => a + f!.speed, 0) / drawn.length;
    const hullsAtTop = ((median / meanSpeed) * fighter.maxSpeed) / hullLen;
    expect(meanSpeed, 'the fighter is moving').toBeGreaterThan(50);
    expect(hullsAtTop, `ribbon ${median.toFixed(0)} u at ${meanSpeed.toFixed(0)} u/s behind a ${hullLen} u hull`).toBeGreaterThan(6);
  } finally {
    await ctx.close();
    await browser.close();
  }
});

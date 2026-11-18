import type { Shot, ShotContext } from '../types.js';
import { SURVIVE, selectAt } from './_helpers.js';
import { flyTo } from './_pilot.js';

/** The nearest cargo pod in the client mirror, or null. */
async function nearestPod(ctx: ShotContext): Promise<{ x: number; y: number } | null> {
  return ctx.page.evaluate(() => {
    const m = (window as unknown as {
      __eqxClient?: { mirror?: { localPlayerId?: string | null; ships?: Map<string, { x: number; y: number }>; swarm?: Map<number, { kind: number; shipKind?: string; x: number; y: number }> } };
    }).__eqxClient?.mirror;
    const me = m?.localPlayerId ? m.ships?.get(m.localPlayerId) : undefined;
    if (!me) return null;
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const [, e] of m?.swarm ?? []) {
      if (e.kind !== 3 || e.shipKind !== 'cargo-pod') continue;
      const d = Math.hypot(e.x - me.x, e.y - me.y);
      if (d < bestD) { bestD = d; best = { x: e.x, y: e.y }; }
    }
    return best;
  });
}

/**
 * Loot & cargo — "open a pod" on a sideways phone. A kill drops one pod; the
 * pilot flies alongside, taps it, presses Open, watches the "?" tiles reveal,
 * takes all found and closes the window. Nothing is picked up by flying over.
 */
export const loot: Shot = {
  id: 'loot',
  section: 'mechanics',
  title: 'Loot & cargo',
  caption: 'Every kill drops a loot pod. Fly alongside, tap it and press Open: the hold reveals item by item. Take what you want, or lose it all if you die.',
  features: ['M17'],
  docs: ['loot-and-cargo'],
  reel: true,
  server: 'lean',
  viewport: 'phone-landscape',
  // A roster-backed room (cargo needs a roster row). Its heavy is peaceful and
  // hull-exposed: auto-fire kills it fast and it drops its pod.
  target: { room: 'showcase-levelup', params: { shipKind: 'interceptor', ...SURVIVE } },
  hud: 'full',
  durationMs: 20_000,
  camera: [{ atMs: 0, smoothMs: 250, shot: { kind: 'track', target: 'local', zoom: 1.4, offsetY: 60 } }],
  async run(ctx) {
    const { page } = ctx;
    await page.waitForFunction(
      () => {
        const m = (window as unknown as { __eqxClient?: { mirror?: { swarm?: Map<number, { kind: number; shipKind?: string }> } } }).__eqxClient?.mirror;
        for (const [, e] of m?.swarm ?? []) if (e.kind === 3 && e.shipKind === 'cargo-pod') return true;
        return false;
      },
      undefined,
      { timeout: 12_000 },
    );
    await ctx.sleep(800);
    const pod = await nearestPod(ctx);
    if (pod === null) throw new Error('loot shot: no pod dropped');
    await flyTo(ctx, pod.x, pod.y - 50, { arrive: 40, maxMs: 6000, cruise: 160 });
    const at = (await nearestPod(ctx)) ?? pod;
    await selectAt(ctx, at.x, at.y);
    await page.locator('[data-testid="pod-open"][data-in-reach="1"]').waitFor({ timeout: 5000 });
    await ctx.sleep(700);
    await page.getByTestId('pod-open').click();
    await page.getByTestId('cargo-panel').waitFor({ timeout: 5000 });
    await page.getByTestId('cargo-unknown-tile').first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
    await ctx.sleep(1200);
    await page.getByTestId('cargo-take-found').click();
    await ctx.sleep(1800);
    await page.getByTestId('loot-window-close').click();
  },
};

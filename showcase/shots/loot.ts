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
  // Roster-backed (cargo needs a roster row). Four peaceful, hull-exposed
  // heavies: auto-fire kills them in turn and a death keeps its loot about
  // half the time, so a pod is almost sure to drop.
  target: { room: 'showcase-loot', params: { shipKind: 'interceptor', ...SURVIVE } },
  hud: 'full',
  durationMs: 40_000,
  async run(ctx) {
    const { page } = ctx;
    const step = (s: string): void => console.log(`[loot] ${s}`);
    try {
      await openPodAndTake(ctx, step);
    } catch (e) {
      await page.screenshot({ path: `diag/showcase/loot-fail-${Date.now()}.png` }).catch(() => undefined);
      throw e;
    }
  },
};

async function openPodAndTake(ctx: ShotContext, step: (s: string) => void): Promise<void> {
  const { page } = ctx;
  await page.waitForFunction(
    () => {
      const m = (window as unknown as { __eqxClient?: { mirror?: { swarm?: Map<number, { kind: number; shipKind?: string }> } } }).__eqxClient?.mirror;
      for (const [, e] of m?.swarm ?? []) if (e.kind === 3 && e.shipKind === 'cargo-pod') return true;
      return false;
    },
    undefined,
    { timeout: 25_000 },
  );
  step('pod dropped');
  await ctx.sleep(800);
  const pod = await nearestPod(ctx);
  if (pod === null) throw new Error('loot shot: no pod dropped');
  await flyTo(ctx, pod.x, pod.y - 50, { arrive: 40, maxMs: 6000, cruise: 160 });
  const at = (await nearestPod(ctx)) ?? pod;
  step('alongside; selecting');
  await selectAt(ctx, at.x, at.y);
  await page.locator('[data-testid="pod-open"][data-in-reach="1"]').waitFor({ timeout: 5000 });
  await ctx.sleep(700);
  step('open in reach; clicking Open');
  await page.getByTestId('pod-open').click({ timeout: 5000 });
  await page.getByTestId('cargo-panel').waitFor({ timeout: 5000 });
  await page.getByTestId('cargo-unknown-tile').first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
  await ctx.sleep(1200);
  step('searched; Take all found');
  await page.getByTestId('cargo-take-found').click({ timeout: 5000 });
  await ctx.sleep(1800);
  step('taken; Close');
  await page.getByTestId('loot-window-close').click({ timeout: 5000 });
  step('done');
}

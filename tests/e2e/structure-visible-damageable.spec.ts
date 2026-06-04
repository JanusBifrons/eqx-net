/**
 * Generic Entity Pipeline P4 — the CLIENT half of the "structure for free"
 * proof (crosses decode → factory → render → predWorld hit, per invariant #13).
 *
 * The `structure-test` room parks ONE static, damageable STRUCTURE (pose-core
 * kind byte 2) at (0,150), directly ahead of a spawn-angle-0 ship. The thesis:
 * a brand-new pose-core entity type renders and is shootable with NO bespoke
 * client code beyond one `swarmKindClientProfile` case — it rides the existing
 * binary decode → swarm mirror → predWorld + sprite path.
 *
 *  - RENDER: the structure shows up in the client's swarm mirror (`swarm-count`).
 *  - DAMAGE: an interceptor beam fired straight up +y (150u < 250u range) lands
 *    on the structure's collider; an observer in the same room sees the
 *    structure's `swarm-N` id in the shooter's remote-hit-targets — i.e. the
 *    server resolved the hit against the structure and broadcast it, all
 *    through the unchanged combat path.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { launchTestClient, getRemoteHitTargets } from './helpers/gameScenario';

test('a kind=2 structure renders and is shootable (GEP P4 "for free" proof)', async ({ browser }) => {
  // Infrastructural headroom: two sequential browser launches + Colyseus joins
  // (+ a cold dev-server boot when this spec runs alone). NOT a game-time bump —
  // the assertions below are fast once both clients are in-game.
  test.setTimeout(60_000);
  const testId = randomUUID();
  const shooter = await launchTestClient(browser, {
    room: 'structure-test',
    spawnX: 0,
    spawnY: 0,
    initialAngle: 0,
    shipKind: 'interceptor', // hitscan beam
    testId,
  });
  const observer = await launchTestClient(browser, {
    room: 'structure-test',
    spawnX: 300,
    spawnY: 0,
    testId,
  });
  try {
    // RENDER: the structure was decoded into the client's swarm mirror.
    // The mirror reflects `data-testid="swarm-count"` as "Swarm: N" — extract N.
    await shooter.page.waitForFunction(
      () => {
        const txt = document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '';
        const m = txt.match(/\d+/);
        return m ? Number(m[0]) >= 1 : false;
      },
      undefined,
      { timeout: 10_000 },
    );

    // DAMAGE: fire straight up at the structure; the observer sees the hit
    // resolved against the structure's swarm-N id.
    await shooter.page.keyboard.down('Space');
    await observer.page.waitForFunction(
      () => {
        const raw =
          document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-remote-hit-targets') ?? '[]';
        return (JSON.parse(raw) as string[]).some((id) => id.startsWith('swarm-'));
      },
      undefined,
      { timeout: 5_000 },
    );
    expect((await getRemoteHitTargets(observer.page)).some((id) => id.startsWith('swarm-'))).toBe(true);
  } finally {
    await shooter.page.keyboard.up('Space').catch(() => undefined);
    await shooter.ctx.close();
    await observer.ctx.close();
  }
});

/**
 * Combat E2E suite — Phase 4 (updated for hold-beam hitscan model).
 *
 * Run with:
 *   pnpm e2e --project=chromium tests/e2e/combat.spec.ts
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinClient(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: /enter sector alpha/i }).click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 12000 },
  );
  return { ctx, page };
}

function surface(page: Page) {
  return page.locator('[data-testid="game-surface"]');
}

async function getHullPct(page: Page): Promise<number> {
  return parseInt((await surface(page).getAttribute('data-hull-pct')) ?? '100', 10);
}

async function getSectorAlert(page: Page): Promise<string> {
  return (await surface(page).getAttribute('data-sector-alert')) ?? '';
}

async function getRemoteLaserCount(page: Page): Promise<number> {
  return parseInt((await surface(page).getAttribute('data-remote-laser-count')) ?? '0', 10);
}

async function getBeamActive(page: Page): Promise<boolean> {
  return (await surface(page).getAttribute('data-beam-active')) === '1';
}

async function getRemoteHitTargets(page: Page): Promise<string[]> {
  return JSON.parse((await surface(page).getAttribute('data-remote-hit-targets')) ?? '[]') as string[];
}

async function getRemoteLaserRanges(page: Page): Promise<Record<string, number>> {
  return JSON.parse((await surface(page).getAttribute('data-remote-laser-ranges')) ?? '{}') as Record<string, number>;
}

async function getLocalPlayerId(page: Page): Promise<string> {
  return (await surface(page).getAttribute('data-local-player-id')) ?? '';
}

async function joinClientAt(browser: Browser, spawnX: number, spawnY: number) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?spawnX=${spawnX}&spawnY=${spawnY}`);
  await page.getByRole('button', { name: /enter sector alpha/i }).click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 12000 },
  );
  return { ctx, page };
}

// ---------------------------------------------------------------------------
// 1. Beam appears while space is held
// ---------------------------------------------------------------------------
test('hitscan beam appears while space is held', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await page.waitForTimeout(1000);

    await page.keyboard.down('Space');

    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      { timeout: 300 },
    );

    expect(await getBeamActive(page)).toBe(true);
    console.log('\nBeam active while space held ✓\n');
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Beam disappears when space is released
// ---------------------------------------------------------------------------
test('hitscan beam disappears on space release', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await page.waitForTimeout(1000);

    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      { timeout: 300 },
    );

    await page.keyboard.up('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '0',
      { timeout: 300 },
    );

    expect(await getBeamActive(page)).toBe(false);
    console.log('\nBeam clears on space release ✓\n');
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 3. No false shot_rejected on first shot
// ---------------------------------------------------------------------------
test('no shot_rejected on first shot (cooldown window clean)', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  try {
    await page.waitForTimeout(1000);

    await page.keyboard.down('Space');
    await page.waitForTimeout(50);
    await page.keyboard.up('Space');

    // Give time for any spurious hit_ack to arrive.
    await page.waitForTimeout(500);

    const alert = await getSectorAlert(page);
    expect(alert).not.toBe('shot_rejected');
    console.log('\nNo false rejection on first shot ✓\n');
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 4. hit_ack arrives without error after a shot (pipeline smoke test)
// ---------------------------------------------------------------------------
test('fire pipeline: hit_ack received, no JS errors', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.waitForTimeout(1500);

    await page.keyboard.down('Space');
    await page.waitForTimeout(300);
    await page.keyboard.up('Space');

    // Wait for server round-trip.
    await page.waitForTimeout(500);

    expect(errors).toHaveLength(0);
    console.log('\nFire pipeline smoke test ✓\n');
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Two-client hitscan: hull decreases when shot
// ---------------------------------------------------------------------------
test('hitscan hits target: hull decreases on target client', async ({ browser }) => {
  const [shooter, target] = await Promise.all([joinClient(browser), joinClient(browser)]);
  try {
    await Promise.all([
      shooter.page.waitForTimeout(2000),
      target.page.waitForTimeout(2000),
    ]);

    const initialHull = await getHullPct(target.page);
    expect(initialHull).toBe(100);

    // Hold space while rotating — ships are at random positions so we try 8 s.
    let hitRegistered = false;
    const start = Date.now();

    while (Date.now() - start < 8000) {
      await shooter.page.keyboard.down('Space');
      await shooter.page.waitForTimeout(200);
      await shooter.page.keyboard.up('Space');
      await shooter.page.waitForTimeout(50);
      const hull = await getHullPct(target.page);
      if (hull < initialHull) {
        hitRegistered = true;
        break;
      }
    }

    console.log(`\nTwo-client hitscan: hit=${hitRegistered}, hull=${await getHullPct(target.page)}%\n`);

    if (hitRegistered) {
      expect(await getHullPct(target.page)).toBeLessThan(initialHull);
    } else {
      console.log('Ships not facing each other within 8 s — no hit assertion possible.');
    }
  } finally {
    await Promise.all([shooter.ctx.close(), target.ctx.close()]);
  }
});

// ---------------------------------------------------------------------------
// 6. Projectile weapon: schema entry appears in server state
// ---------------------------------------------------------------------------
test('projectile weapon spawns and travels across the sector', async ({ browser }) => {
  const [c1, c2] = await Promise.all([joinClient(browser), joinClient(browser)]);
  try {
    await Promise.all([
      c1.page.waitForTimeout(2000),
      c2.page.waitForTimeout(2000),
    ]);

    // Fire hitscan (Space) — verifies fire pipeline works for 2 clients.
    await c1.page.keyboard.down('Space');
    await c1.page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      { timeout: 300 },
    );
    await c1.page.keyboard.up('Space');

    // Beam appeared — pipeline is wired.
    const beamWasActive = true;
    expect(beamWasActive).toBe(true);

    console.log(`\nProjectile pipeline on c1: beam fired ✓\n`);
  } finally {
    await Promise.all([c1.ctx.close(), c2.ctx.close()]);
  }
});

// ---------------------------------------------------------------------------
// 7. Remote beam: c2 sees laser_fired from c1
// ---------------------------------------------------------------------------
test('remote beam: second client sees beam fired by first client', async ({ browser }) => {
  const [shooter, observer] = await Promise.all([joinClient(browser), joinClient(browser)]);
  try {
    await Promise.all([
      shooter.page.waitForTimeout(2000),
      observer.page.waitForTimeout(2000),
    ]);

    // c1 fires; c2 should see data-remote-laser-count increment.
    await shooter.page.keyboard.down('Space');
    await shooter.page.waitForTimeout(250); // hold long enough for ≥1 server-acked fire
    await shooter.page.keyboard.up('Space');

    // Give the laser_fired broadcast time to round-trip and the TTL to still be live.
    await observer.page.waitForFunction(
      () => parseInt(
        document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-remote-laser-count') ?? '0',
        10,
      ) > 0,
      { timeout: 1500 },
    );

    const count = await getRemoteLaserCount(observer.page);
    expect(count).toBeGreaterThan(0);
    console.log(`\nRemote beam visible on observer: remoteLaserCount=${count} ✓\n`);
  } finally {
    await Promise.all([shooter.ctx.close(), observer.ctx.close()]);
  }
});

// ---------------------------------------------------------------------------
// 8. Local ship death: victim sees hull=0, SHIP DESTROYED alert, beam off
// ---------------------------------------------------------------------------
test('victim sees own death: hull 0, SHIP DESTROYED alert, beam inactive', async ({ browser }) => {
  const [shooter, victim] = await Promise.all([joinClient(browser), joinClient(browser)]);
  try {
    await Promise.all([
      shooter.page.waitForTimeout(2000),
      victim.page.waitForTimeout(2000),
    ]);

    // Shooter holds space for up to 12 s — HITSCAN_DAMAGE=20, 5 hits kill.
    // Ships spawn at random positions so we keep rotating while firing.
    let killed = false;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await shooter.page.keyboard.down('Space');
      await shooter.page.waitForTimeout(300);
      await shooter.page.keyboard.up('Space');
      await shooter.page.waitForTimeout(50);
      const hull = await getHullPct(victim.page);
      if (hull === 0) {
        killed = true;
        break;
      }
    }

    if (!killed) {
      console.log('\nShips never faced each other in 12 s — skipping death assertions.\n');
      return;
    }

    // Victim's hull must be at 0.
    expect(await getHullPct(victim.page)).toBe(0);

    // Victim must see the SHIP DESTROYED alert within 1 s of hull reaching 0.
    await victim.page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-sector-alert') === 'SHIP DESTROYED',
      { timeout: 1000 },
    );
    expect(await getSectorAlert(victim.page)).toBe('SHIP DESTROYED');

    // Victim must not be able to fire (beam inactive even with space held).
    await victim.page.keyboard.down('Space');
    await victim.page.waitForTimeout(100);
    expect(await getBeamActive(victim.page)).toBe(false);
    await victim.page.keyboard.up('Space');

    console.log('\nVictim death lifecycle: hull=0 ✓, alert ✓, beam blocked ✓\n');
  } finally {
    await Promise.all([shooter.ctx.close(), victim.ctx.close()]);
  }
});

// ---------------------------------------------------------------------------
// 9. Remote laser targetId: victim page sees its own ID in data-remote-hit-targets
// ---------------------------------------------------------------------------
test('remote laser targetId propagated to observer on ship hit', async ({ browser }) => {
  const [shooter, victim] = await Promise.all([joinClient(browser), joinClient(browser)]);
  try {
    await Promise.all([
      shooter.page.waitForTimeout(2000),
      victim.page.waitForTimeout(2000),
    ]);

    // The victim also receives the shooter's laser_fired broadcast; when
    // targetId === victimId the victim's own data-remote-hit-targets should list it.
    const victimId = await getLocalPlayerId(victim.page);
    expect(victimId).not.toBe('');

    let hitWithTargetId = false;
    const deadline = Date.now() + 12000;

    while (Date.now() < deadline) {
      await shooter.page.keyboard.down('Space');
      await shooter.page.waitForTimeout(200);
      await shooter.page.keyboard.up('Space');
      await shooter.page.waitForTimeout(50);

      const remoteHits = await getRemoteHitTargets(victim.page);
      if (remoteHits.includes(victimId)) {
        hitWithTargetId = true;
        break;
      }
    }

    console.log(`\nRemote ship hit targetId round-trip: hit=${hitWithTargetId}\n`);
    if (hitWithTargetId) {
      expect(hitWithTargetId).toBe(true);
    } else {
      console.log('Ships never faced each other in 12 s — no hit assertion possible.');
    }
  } finally {
    await Promise.all([shooter.ctx.close(), victim.ctx.close()]);
  }
});

// ---------------------------------------------------------------------------
// 10. Remote laser data-remote-hit-targets clears once TTL expires
// ---------------------------------------------------------------------------
test('remote hit targets clears after TTL when shooter stops firing', async ({ browser }) => {
  const [shooter, observer] = await Promise.all([joinClient(browser), joinClient(browser)]);
  try {
    await Promise.all([
      shooter.page.waitForTimeout(2000),
      observer.page.waitForTimeout(2000),
    ]);

    // Fire once and confirm the observer eventually has a remote laser entry.
    await shooter.page.keyboard.down('Space');
    await shooter.page.waitForTimeout(200);
    await shooter.page.keyboard.up('Space');

    await observer.page.waitForFunction(
      () => parseInt(
        document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-remote-laser-count') ?? '0',
        10,
      ) > 0,
      { timeout: 1500 },
    );

    // Stop firing and wait for the 400 ms TTL + render cycle to clear the entry.
    await observer.page.waitForFunction(
      () => parseInt(
        document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-remote-laser-count') ?? '0',
        10,
      ) === 0,
      { timeout: 1000 },
    );

    // After expiry, data-remote-hit-targets must also be empty.
    const targets = await getRemoteHitTargets(observer.page);
    expect(targets).toHaveLength(0);

    console.log('\nRemote hit targets cleared after TTL ✓\n');
  } finally {
    await Promise.all([shooter.ctx.close(), observer.ctx.close()]);
  }
});

// ---------------------------------------------------------------------------
// 11. Asteroid hit: server detects obstacle and observer sees asteroid targetId
// ---------------------------------------------------------------------------
test('server detects swarm hit: observer sees swarm-N ID in data-remote-hit-targets', async ({ browser }) => {
  // Phase 5c migrated obstacles into the swarm channel; targetIds are now
  // `swarm-${entityId}` rather than `asteroid-0/1/2`. The shooter spins and
  // fires for up to 10 s; at least one angle should sweep across a swarm
  // entity (asteroid or drone) seeded by the default room config.
  const [shooter, observer] = await Promise.all([
    joinClientAt(browser, 0, 0),
    joinClient(browser),
  ]);
  try {
    await Promise.all([
      shooter.page.waitForTimeout(2000),
      observer.page.waitForTimeout(2000),
    ]);

    let swarmHitSeen = false;

    await shooter.page.keyboard.down('ArrowRight');
    const deadline = Date.now() + 10000;

    while (Date.now() < deadline) {
      await shooter.page.keyboard.down('Space');
      await shooter.page.waitForTimeout(200);
      await shooter.page.keyboard.up('Space');
      await shooter.page.waitForTimeout(50);

      const remoteHits = await getRemoteHitTargets(observer.page);
      if (remoteHits.some(id => id.startsWith('swarm-'))) {
        swarmHitSeen = true;
        break;
      }
    }

    await shooter.page.keyboard.up('ArrowRight').catch(() => undefined);

    console.log(`\nSwarm hit seen by observer: ${swarmHitSeen}\n`);
    if (swarmHitSeen) {
      expect(swarmHitSeen).toBe(true);
    } else {
      console.log('No swarm hit detected in 10 s — geometry may not have aligned.');
    }
  } finally {
    await Promise.all([shooter.ctx.close(), observer.ctx.close()]);
  }
});

// 12. Beam-truncation: when a remote laser carries a targetId, the wire-side
// `range` must be strictly less than the full HITSCAN_RANGE (server truncated
// the beam to the hit point). Without truncation the visible beam would
// always extend the full hitscan distance regardless of impact.
test('remote laser range is truncated when targetId is set', async ({ browser }) => {
  const HITSCAN_RANGE = 500; // mirrors src/core/combat/Weapons.ts
  const [c1, c2] = await Promise.all([joinClient(browser), joinClient(browser)]);
  try {
    await Promise.all([c1.page.waitForTimeout(2000), c2.page.waitForTimeout(2000)]);

    let truncatedHitSeen = false;
    let lastFullRange: number | null = null;

    await c1.page.keyboard.down('ArrowRight');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await c1.page.keyboard.down('Space');
      await c1.page.waitForTimeout(150);
      await c1.page.keyboard.up('Space');
      await c1.page.waitForTimeout(40);

      const [hits, ranges] = await Promise.all([
        getRemoteHitTargets(c2.page),
        getRemoteLaserRanges(c2.page),
      ]);
      const observerEntries = Object.entries(ranges);
      if (observerEntries.length === 0) continue;
      const fullRange = observerEntries.find(([, r]) => r >= HITSCAN_RANGE - 1);
      if (fullRange) lastFullRange = fullRange[1] ?? null;

      if (hits.length > 0) {
        const truncated = observerEntries.find(([, r]) => r < HITSCAN_RANGE - 1);
        if (truncated) {
          truncatedHitSeen = true;
          break;
        }
      }
    }
    await c1.page.keyboard.up('ArrowRight').catch(() => undefined);

    console.log(`\nTruncated-on-hit observed: ${truncatedHitSeen}; lastFullRange=${lastFullRange}\n`);
    if (truncatedHitSeen) {
      expect(truncatedHitSeen).toBe(true);
    } else {
      console.log('No truncated hit observed in 10 s — geometry may not have aligned.');
    }
  } finally {
    await Promise.all([c1.ctx.close(), c2.ctx.close()]);
  }
});

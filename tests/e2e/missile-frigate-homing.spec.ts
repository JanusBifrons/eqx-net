/**
 * Missile-frigate homing regression lock (2026-05-27).
 *
 * Drives the smoke-test bug class the user reported on the
 * `claude/missiles-frigate-weapon-xthqM` branch:
 *
 *   > "The missiles only flew straight for like 3 seconds then vanished —
 *    didn't lock on as far as I could tell."
 *
 * The diagnostic gap that hid the cause: `MissileSimulation` never called
 * `serverLogEvent`, so the streaming diag capture had zero server-side
 * missile lifecycle data. This spec is paired with the instrumentation
 * that closed that gap (`missile_spawned` / `missile_detonated` /
 * `missile_lock_lost`).
 *
 * Scenario:
 *   - Two clients in `test-sector-fast` (testTimeScale=10 → 6 s missile
 *     lifetime compresses to ~600 ms wall-clock).
 *   - Shooter spawns as `missile-frigate` at origin facing +y.
 *   - Target spawns 1000 u in front of the shooter (well inside the
 *     2400 u lock range; well outside the 36 u proximity-fuse so the
 *     test exercises homing + sweep-collision, not the spawn-coincident
 *     fuse).
 *   - Shooter cycles weapon to heat-seeker (Q twice from default
 *     hitscan) and holds Space for ~1.2 s to maximise the chance of
 *     catching the fire-dispatch wall-clock-anchored catch-up loop on
 *     an iteration where its per-RAF deficit is positive.
 *
 * Assertions via `GET /dev/events` (the in-memory ServerEventLog ring):
 *   1. A `missile_spawned` event arrives with this shooter's playerId.
 *   2. `lockedTargetId` is the target's playerId — NOT null, NOT an
 *      asteroid, NOT a drone. Regression lock for the "didn't lock on"
 *      symptom.
 *   3. A `missile_detonated` event arrives for the same missileId with
 *      `cause !== 'lifetime'` — i.e. the missile reached the target via
 *      sweep-collision (or proximity-fuse), NOT dumb-flew until expiry.
 *
 * Run:
 *   pnpm e2e --project=feature tests/e2e/missile-frigate-homing.spec.ts --reporter=line
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page, APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? 'http://localhost:2567';

interface ServerLogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

async function joinShip(
  browser: Browser,
  opts: { testId: string; spawnX: number; spawnY: number; shipKind: string; room?: string },
): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page; playerId: string }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: opts.room ?? 'test-sector-fast',
    testId: opts.testId,
    spawnX: String(opts.spawnX),
    spawnY: String(opts.spawnY),
    shipKind: opts.shipKind,
  });
  // `fpscap=0` disables the internal work-loop cap so the catch-up
  // loop iterates every RAF — the fire dispatch lives inside that loop
  // (ColyseusClient.ts:3051), and when its per-RAF deficit is negative
  // (`inputTick >= targetTick`) the loop body skips and `sendFire`
  // never runs. Headless Playwright shows intermittent negative
  // deficits which silently swallowed every heat-seeker fire in early
  // diagnostic runs.
  await page.goto(`${BASE_URL}?${params.toString()}&fpscap=0`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      const id = el?.getAttribute('data-local-player-id') ?? '';
      return id.length > 0;
    },
    { timeout: 12_000 },
  );
  const playerId = (await page
    .locator('[data-testid="game-surface"]')
    .getAttribute('data-local-player-id')) ?? '';
  return { ctx, page, playerId };
}

async function fetchEvents(
  request: APIRequestContext,
  predicate: (e: ServerLogEntry) => boolean,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<ServerLogEntry | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 50;
  while (Date.now() < deadline) {
    const res = await request.get(`${SERVER_URL}/dev/events?limit=500`);
    if (res.ok()) {
      const body = (await res.json()) as { events: ServerLogEntry[] };
      // Scan newest-first so we get the most recent match. The ring
      // rolls quickly (tick_budget every tick) — a missed match means
      // "not in the last 500 events" rather than "never happened."
      for (let i = body.events.length - 1; i >= 0; i--) {
        const ev = body.events[i]!;
        if (predicate(ev)) return ev;
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

test('heat-seeker locks onto in-range player and detonates via homing — not lifetime', async ({
  browser,
  request,
}) => {
  const testId = randomUUID();
  // Shooter at origin, target 1000 u ahead. Default spawn angle is 0
  // (forward = +y). 1000 u is inside the 2400 u lock range and outside
  // the 36 u proximity fuse — clean homing + sweep-collision path.
  // Parallel join to keep the test under the 30 s per-test cap.
  const [shooter, target] = await Promise.all([
    joinShip(browser, { testId, spawnX: 0, spawnY: 0, shipKind: 'missile-frigate' }),
    joinShip(browser, { testId, spawnX: 0, spawnY: 1000, shipKind: 'fighter' }),
  ]);

  try {
    expect(shooter.playerId).not.toBe('');
    expect(target.playerId).not.toBe('');
    expect(shooter.playerId).not.toBe(target.playerId);

    // Let the snapshot loop settle so the missile lock sees the target
    // in `shipPoseCache` / `playerToSlot`. test-sector-fast ticks 10x
    // so 300 ms wall-clock ≈ 3 s game-time of settle.
    await shooter.page.waitForTimeout(300);

    // Fire the heat-seeker by calling `__eqxClient.triggerFireForTest(
    // 'heat-seeker')` directly. This bypasses BOTH the keyboard event
    // pipeline (synthetic Space-keydowns in Playwright headless are
    // unreliable on a freshly-loaded canvas page) AND the wall-clock-
    // anchored catch-up loop's fire dispatch (silently skipped when
    // `inputTick > targetTick` — a headless-RAF quirk that swallowed
    // every heat-seeker fire in keyboard-driven iterations, while the
    // SAME setup fires hitscan reliably; the cooldown-tick gap between
    // 10 (hitscan) and 180 (heat-seeker) is what made it weapon-
    // specific). `triggerFireForTest` returns true iff `sendFire` ran
    // (predWorld + ship + room present); the missile_spawned assertion
    // below confirms the round-trip.
    const fireTs = Date.now();
    const fired = await shooter.page.evaluate(() => {
      const w = window as unknown as {
        __eqxClient?: { triggerFireForTest?: (id: string) => boolean };
      };
      if (!w.__eqxClient?.triggerFireForTest) return 'hook missing';
      return w.__eqxClient.triggerFireForTest('heat-seeker') ? 'ok' : 'sendFire bailed';
    });
    expect(
      fired,
      `triggerFireForTest result was '${fired}' — expected 'ok'. ` +
      `'hook missing' ⇒ App.tsx DEV exposure not loaded; 'sendFire bailed' ⇒ ` +
      `predWorld/ship/room not ready (race on initial spawn).`,
    ).toBe('ok');

    // Assertion 1: missile_spawned arrives for this shooter.
    const spawned = await fetchEvents(
      request,
      (e) => e.tag === 'missile_spawned'
        && e.data['ownerId'] === shooter.playerId
        && e.ts >= fireTs,
      { timeoutMs: 4000 },
    );
    if (spawned === null) {
      // Diagnostic on failure — what tags ARE in the ring right now?
      // Distinguishes "server didn't see any fire at all" from
      // "fire happened but rejected" from "fire happened, missile
      // spawned for a different ownerId".
      const res = await request.get(`${SERVER_URL}/dev/events?limit=500`);
      const body = (await res.json()) as { events: ServerLogEntry[] };
      const tagHist: Record<string, number> = {};
      for (const e of body.events) tagHist[e.tag] = (tagHist[e.tag] ?? 0) + 1;
      const recentFire = body.events.filter((e) => e.tag === 'fire_received').slice(-3);
      const recentSpawn = body.events.filter((e) => e.tag === 'missile_spawned').slice(-3);
      // eslint-disable-next-line no-console
      console.log('RING tag histogram:', JSON.stringify(tagHist));
      // eslint-disable-next-line no-console
      console.log('RING fire_received (last 3):', JSON.stringify(recentFire));
      // eslint-disable-next-line no-console
      console.log('RING missile_spawned (last 3):', JSON.stringify(recentSpawn));
    }
    expect(spawned, 'no missile_spawned event arrived for shooter — fire never reached MissileSimulation.spawn').not.toBeNull();
    const _missileId = spawned!.data['missileId'] as number;
    const lockedTargetId = spawned!.data['lockedTargetId'];
    const candidateCount = spawned!.data['candidateCount'] as number;
    const hostileCandidateCount = spawned!.data['hostileCandidateCount'] as number;

    // Assertion 2: lock acquired AND it's the target player.
    expect(
      lockedTargetId,
      `missile lock was null — candidateCount=${candidateCount} hostileCandidateCount=${hostileCandidateCount}. ` +
      `candidateCount=0 ⇒ missile sim saw no entities at all; > 0 ⇒ hostility predicate rejected them.`,
    ).not.toBeNull();
    expect(
      lockedTargetId,
      `missile locked onto wrong entity: ${String(lockedTargetId)} (expected target playerId ${target.playerId})`,
    ).toBe(target.playerId);

    // Assertion 3: missile_detonated arrives for ANY missile from this
    // shooter (the frigate has 2 mounts → 2 missiles per salvo) with
    // a non-lifetime cause. 'lifetime' ⇒ flew dumb until expiry (the
    // smoke-test bug). 'sweep' (direct hit) or 'fuse' (proximity)
    // both ⇒ homing reached the target.
    const detonated = await fetchEvents(
      request,
      (e) => e.tag === 'missile_detonated'
        && e.data['ownerId'] === shooter.playerId
        && e.ts >= fireTs,
      { timeoutMs: 7000 },
    );
    if (detonated === null) {
      // Diagnostic on failure — dump every missile event from this
      // shooter so we can see whether the missile is in-flight, lost
      // its lock, or otherwise stalled.
      const res = await request.get(`${SERVER_URL}/dev/events?limit=500`);
      const body = (await res.json()) as { events: ServerLogEntry[] };
      const missileEvents = body.events.filter(
        (e) => (e.tag === 'missile_spawned' || e.tag === 'missile_detonated' || e.tag === 'missile_lock_lost')
          && e.data['ownerId'] === shooter.playerId,
      );
      // eslint-disable-next-line no-console
      console.log('MISSILE EVENTS for shooter:', JSON.stringify(missileEvents, null, 2));
    }
    expect(detonated, 'no missile_detonated arrived from shooter within 7 s').not.toBeNull();
    const cause = detonated!.data['cause'] as string;
    const ageTicks = detonated!.data['ageTicks'] as number;
    expect(
      cause,
      `missile detonated via '${cause}' after ${ageTicks} ticks — 'lifetime' ⇒ flew dumb, never reached target (the smoke-test bug). ` +
      `Expected 'sweep' (direct hit) or 'fuse' (proximity).`,
    ).not.toBe('lifetime');

    // Assertion 4: damage actually applied to the target. Read the
    // target's ShieldHullBar attrs after the detonate — fighter spawns
    // at 100% shield + 100% hull, so any successful missile hit must
    // drop EITHER `data-shield-pct` or `data-hull-pct` below 100 once
    // the `damage` broadcast arrives. Polled to ride out the
    // ~50–150 ms wire RTT after `detonated`.
    const damaged = await target.page.waitForFunction(
      () => {
        const el = document.querySelector('[data-shield-pct]');
        if (!el) return null;
        const sh = parseInt(el.getAttribute('data-shield-pct') ?? '100', 10);
        const hp = parseInt(el.getAttribute('data-hull-pct') ?? '100', 10);
        return sh < 100 || hp < 100 ? { sh, hp } : null;
      },
      null,
      { timeout: 3000 },
    ).catch(() => null);
    if (damaged === null) {
      const attrs = await target.page.evaluate(() => {
        const el = document.querySelector('[data-shield-pct]');
        return el
          ? {
              shieldPct: el.getAttribute('data-shield-pct'),
              hullPct: el.getAttribute('data-hull-pct'),
            }
          : 'no ShieldHullBar element';
      });
      // eslint-disable-next-line no-console
      console.log('DAMAGE FAILURE — target ShieldHullBar attrs:', JSON.stringify(attrs));
    }
    expect(
      damaged,
      `target's shield+hull never dropped below 100% within 3 s after missile_detonated — ` +
      `damage broadcast either never sent or arrived but didn't reduce shield/hull. ` +
      `This is the "zero damage" smoke-test class.`,
    ).not.toBeNull();
  } finally {
    await Promise.all([shooter.ctx.close(), target.ctx.close()]);
  }
});

test('heat-seeker damages a drone (swarm target) — not just other players', async ({
  browser,
  request,
}) => {
  // Regression lock for the "fires/tracks/aims/hits but ZERO damage in
  // solo galaxy play" smoke-test class. The first spec only validated
  // player→player damage; for solo play the user's targets are SWARM
  // entities (drones / Living World bots), which route through a
  // DIFFERENT DamageRouter branch (line 208-243). Pre-fix that branch
  // would short-circuit to null for galaxy asteroids (whose ids are
  // `asteroid-N` — no `swarm-` prefix — so `swarmHealth.get(id)`
  // returned undefined and `damageSwarmLayered` early-returned, silently
  // dropping the broadcast). The fix gates lock-on + sweep on
  // `rec.kind === 0` so missiles never select an asteroid in the first
  // place. This spec asserts a drone genuinely takes non-zero damage.
  //
  // `mount-test` (testMode=true) spawns 6 drones in a 250 u ring around
  // origin. No asteroids. No testTimeScale, so missile lifetime is full
  // 6 s wall-clock — the test runs ~8-12 s total, comfortably under the
  // 30 s per-test cap.
  const testId = randomUUID();
  const shooter = await joinShip(browser, {
    testId,
    spawnX: 0,
    spawnY: 0,
    shipKind: 'missile-frigate',
    room: 'mount-test',
  });

  try {
    expect(shooter.playerId).not.toBe('');

    // Let the snapshot loop settle so the drones are in `playerToSlot`
    // / `swarmRegistry`. mount-test doesn't accelerate physics.
    await shooter.page.waitForTimeout(500);

    // Fire heat-seeker via the dev-only test hook — same path as the
    // first spec.
    const fireTs = Date.now();
    const fired = await shooter.page.evaluate(() => {
      const w = window as unknown as {
        __eqxClient?: { triggerFireForTest?: (id: string) => boolean };
      };
      return w.__eqxClient?.triggerFireForTest?.('heat-seeker') ? 'ok' : 'failed';
    });
    expect(fired, 'triggerFireForTest did not succeed').toBe('ok');

    // Assertion 1: missile spawned with a lock on a DRONE (swarm-kind
    // target, NOT an asteroid). Asteroid exclusion is now at the
    // candidate-build site, so the lock target id should start with
    // `swarm-drone-` (or be a drone-style id from the spawner).
    const spawned = await fetchEvents(
      request,
      (e) => e.tag === 'missile_spawned'
        && e.data['ownerId'] === shooter.playerId
        && e.ts >= fireTs,
      { timeoutMs: 4000 },
    );
    expect(spawned, 'no missile_spawned event for shooter').not.toBeNull();
    const lockedTargetId = spawned!.data['lockedTargetId'] as string | null;
    const candidateCount = spawned!.data['candidateCount'] as number;
    expect(
      lockedTargetId,
      `lock was null — candidateCount=${candidateCount}. mount-test should have 6 drones in range; ` +
      `if candidateCount=0 the candidate build is broken; if > 0 the predicate rejected all of them.`,
    ).not.toBeNull();
    expect(
      typeof lockedTargetId === 'string' && (lockedTargetId.startsWith('swarm-drone-') || lockedTargetId.startsWith('lwbot-')),
      `missile locked onto unexpected target '${String(lockedTargetId)}' — expected a drone (swarm-drone-* or lwbot-*).`,
    ).toBe(true);

    // Assertion 2: missile detonates via homing — not lifetime.
    const detonated = await fetchEvents(
      request,
      (e) => e.tag === 'missile_detonated'
        && e.data['ownerId'] === shooter.playerId
        && e.ts >= fireTs,
      { timeoutMs: 8000 },
    );
    expect(detonated, 'no missile_detonated from shooter within 8 s').not.toBeNull();
    const cause = detonated!.data['cause'] as string;
    expect(
      cause,
      `missile detonated via '${cause}' — expected 'sweep' or 'fuse'. 'lifetime' ⇒ it flew dumb past the drones.`,
    ).not.toBe('lifetime');

    // Assertion 3: a `damage_applied` event landed on a swarm target
    // from this shooter, with non-zero damage. This is the regression
    // lock for the asteroid-lock-with-silent-no-op bug — without the
    // fix, missile_detonated still fires but no damage broadcast goes
    // out (the swarm-branch early-return at DamageRouter.ts:212).
    const damageApplied = await fetchEvents(
      request,
      (e) => e.tag === 'damage_applied'
        && e.data['shooterId'] === shooter.playerId
        && e.data['kind'] === 'swarm'
        && Number(e.data['damage'] ?? 0) > 0,
      { timeoutMs: 2000 },
    );
    if (damageApplied === null) {
      const res = await request.get(`${SERVER_URL}/dev/events?limit=500`);
      const body = (await res.json()) as { events: ServerLogEntry[] };
      const allDamage = body.events.filter((e) => e.tag === 'damage_applied').slice(-5);
      const allMissile = body.events.filter(
        (e) => e.tag.startsWith('missile_') && e.data['ownerId'] === shooter.playerId,
      ).slice(-5);
      // eslint-disable-next-line no-console
      console.log('NO DAMAGE — last 5 damage_applied:', JSON.stringify(allDamage));
      // eslint-disable-next-line no-console
      console.log('NO DAMAGE — last 5 missile events from shooter:', JSON.stringify(allMissile));
    }
    expect(
      damageApplied,
      `no damage_applied event for swarm target from shooter — missile detonated but ` +
      `the swarm damage path returned null (target had no swarmHealth entry). ` +
      `This is THE "zero damage" bug. Likely an asteroid was the actual hit target ` +
      `(asteroid ids without 'swarm-asteroid-' prefix bypass the predicate).`,
    ).not.toBeNull();
  } finally {
    await shooter.ctx.close();
  }
});

test('held fire auto-refires heat-seeker every cooldown — no need to tap', async ({
  browser,
  request,
}) => {
  // Regression lock for the "if I hold the fire button they don't seem
  // to fire when available, I've got to tap it repeatedly" smoke-test
  // report. The client-side cooldown gate
  // (`ColyseusClient.ts:3068 — tick - lastFiredAtTick >= cooldownTicks`)
  // is INSIDE the wall-clock-anchored catch-up loop, so a held fire
  // input should auto-refire each cooldown without any tap-release-tap
  // cadence from the user. heat-seeker `cooldownTicks=180` = 3.0 s
  // game-time; this spec holds the fire input for ~7 s (well over two
  // cooldowns) and asserts ≥ 2 distinct missile_spawned events from
  // this shooter.
  const testId = randomUUID();
  const shooter = await joinShip(browser, {
    testId,
    spawnX: 0,
    spawnY: 0,
    shipKind: 'missile-frigate',
    room: 'mount-test',
  });

  try {
    expect(shooter.playerId).not.toBe('');
    await shooter.page.waitForTimeout(500);

    // Set activeWeapon to heat-seeker via the test hook (skips KeyQ-
    // cycle race conditions documented above).
    await shooter.page.evaluate(() => {
      const w = window as unknown as {
        __eqxSetActiveWeapon?: (id: string) => void;
      };
      w.__eqxSetActiveWeapon?.('heat-seeker');
    });

    // Click to focus + hold Space for 7 s (covers 2× the 3 s cooldown
    // with margin). 7 s × 60 Hz / 16.67 ms/tick ≈ 420 RAFs ≈ 2.33×
    // cooldown windows. Expect 3 distinct fires (the initial one at
    // hold-start, and 2 more on cooldown rollover).
    await shooter.page.locator('[data-testid="game-surface"]').click();
    await shooter.page.waitForTimeout(40);
    const fireTs = Date.now();
    await shooter.page.keyboard.down('Space');
    await shooter.page.waitForTimeout(7000);
    await shooter.page.keyboard.up('Space');

    // Collect every `missile_spawned` event from this shooter since the
    // hold began. Group by `missileId` so we count distinct missiles
    // (each fire produces 2 missiles per salvo = 2 mounts).
    const res = await request.get(`${SERVER_URL}/dev/events?limit=500`);
    const body = (await res.json()) as { events: ServerLogEntry[] };
    const ourMissiles = body.events.filter(
      (e) => e.tag === 'missile_spawned'
        && e.data['ownerId'] === shooter.playerId
        && e.ts >= fireTs,
    );
    // Group missiles into distinct SALVOS — missiles fired within one
    // catch-up burst share a tight `ts` cluster. Use a 500 ms gap as
    // the salvo boundary (well under the 3000 ms cooldown, well over
    // any intra-salvo Δ).
    const salvoTs: number[] = [];
    for (const m of ourMissiles) {
      if (salvoTs.length === 0 || m.ts - salvoTs[salvoTs.length - 1]! > 500) {
        salvoTs.push(m.ts);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`HOLD-FIRE: ${ourMissiles.length} missiles, ${salvoTs.length} salvos at ts:`, salvoTs);
    expect(
      salvoTs.length,
      `held-fire produced ${salvoTs.length} salvo(s) in 7 s but expected ≥ 2 ` +
      `(cooldownTicks=180 = 3.0 s wallclock — 7 s should fit one initial fire + ≥ 1 cooldown rollover). ` +
      `If only 1 salvo, the held-fire path is broken (fireHeld not sampled across cooldown).`,
    ).toBeGreaterThanOrEqual(2);
    // Inter-salvo gap should be ≈ 3000 ms (cooldown). Allow ±500 ms
    // for tick-quantisation + RAF jitter.
    if (salvoTs.length >= 2) {
      const gap = salvoTs[1]! - salvoTs[0]!;
      // Diagnostic on a too-wide gap: dump the client's input_intent
      // log so we can see whether fireHeld was actually held throughout
      // and what inputTick was doing.
      if (gap > 3700) {
        const intents = await shooter.page.evaluate(() => {
          const w = window as unknown as {
            __eqxLogs?: Array<{ tag: string; data: Record<string, unknown> }>;
          };
          const logs = w.__eqxLogs ?? [];
          const fires = logs.filter((l) => l.tag === 'fire').map((l) => ({
            tick: Number(l.data['tick']),
            weapon: String(l.data['weapon']),
            ts: Number(l.data['ts'] ?? 0),
          }));
          const ii = logs.filter((l) => l.tag === 'input_intent');
          // Sliding 30-tick windows around interesting boundaries:
          //   the first fire tick, the expected-second-fire tick (=first+180),
          //   the actual-second-fire tick.
          const fireTicks = fires.map((f) => f.tick);
          const expectedSecond = fireTicks[0] !== undefined ? fireTicks[0] + 180 : null;
          const interesting = new Set<number>();
          for (const t of fireTicks) interesting.add(t);
          if (expectedSecond !== null) interesting.add(expectedSecond);
          const aroundExpected = expectedSecond !== null
            ? ii.filter((l) => Math.abs(Number(l.data['tick']) - expectedSecond) <= 5).map((l) => ({
                tick: Number(l.data['tick']),
                fireHeld: Boolean(l.data['fireHeld']),
              }))
            : [];
          const rafs = logs.filter((l) => l.tag === 'rafTick');
          // Sample 8 rafTicks spaced across the held window so we can see
          // stepsThisFrame, overPredictionCapped, deficitBefore.
          const step = Math.max(1, Math.floor(rafs.length / 8));
          const rafSamples = [];
          for (let i = 0; i < rafs.length; i += step) {
            const d = rafs[i]!.data;
            rafSamples.push({
              elapsedMs: d['elapsedMs'],
              inputTick: d['inputTick'],
              deficitBefore: d['deficitBefore'],
              stepsThisFrame: d['stepsThisFrame'],
              overPredictionCapped: d['overPredictionCapped'],
              leadTicks: d['leadTicks'],
            });
          }
          return {
            iiTotal: ii.length,
            fires,
            expectedSecond,
            aroundExpected,
            rafTotal: rafs.length,
            rafSamples,
          };
        });
        // eslint-disable-next-line no-console
        console.log('HOLD-FIRE DIAG:', JSON.stringify(intents, null, 2));
      }
      expect(
        gap,
        `first inter-salvo gap was ${gap} ms — expected ≈ 3000 ms (cooldownTicks 180 @ 60 Hz). ` +
        `A gap < 2500 ms ⇒ cooldown not enforced; > 3500 ms ⇒ tick rate stalled.`,
      ).toBeGreaterThanOrEqual(2500);
      expect(gap).toBeLessThanOrEqual(3700);
    }
  } finally {
    await shooter.ctx.close();
  }
});

test('touch fire path: setting touchInput.fireHeld dispatches a missile', async ({
  browser,
  request,
}) => {
  // Regression lock for the touch-fire branch of the hoisted per-RAF
  // fire dispatch (2026-05-27 — the hoist initially used `kb.fireHeld`
  // only, breaking firing entirely on real phones where the keyboard
  // is never the source of the FIRE button. The other tests use
  // `keyboard.down('Space')` and trivially passed despite the bug).
  //
  // This spec drives fire through the same code path real touch users
  // hit: `MobileControls` → `touchInput.setFireHeld(true)`. We poke the
  // touchInput directly via the dev-only `__eqxClient` window hook
  // (skipping the React `onTouchStart` UI ceremony — the regression
  // would have been in the wire-up between `touchInput.getFireHeld()`
  // and the fire dispatch, not in the React layer).
  const testId = randomUUID();
  const shooter = await joinShip(browser, {
    testId,
    spawnX: 0,
    spawnY: 0,
    shipKind: 'missile-frigate',
    room: 'mount-test',
  });
  try {
    await shooter.page.waitForTimeout(500);

    // Switch to heat-seeker.
    await shooter.page.evaluate(() => {
      const w = window as unknown as { __eqxSetActiveWeapon?: (id: string) => void };
      w.__eqxSetActiveWeapon?.('heat-seeker');
    });

    // Drive fire via touchInput. The client constructor lazily attaches
    // a TouchInput only on devices the renderer detects as touch — in
    // Playwright headless that's normally null, so the test also
    // attaches one if missing (mirrors `App.tsx`'s init path).
    const fireTs = Date.now();
    const result = await shooter.page.evaluate(() => {
      // Reach into the private `touchInput` field. The class field name
      // survives TS `private` at runtime.
      const w = window as unknown as {
        __eqxClient?: {
          touchInput: { setFireHeld: (v: boolean) => void } | null;
          setTouchInput?: (ti: unknown) => void;
        };
      };
      const client = w.__eqxClient;
      if (!client) return 'no __eqxClient';
      if (!client.touchInput) {
        // Attach a minimal TouchInput-shaped stub so the cleanup path
        // doesn't crash. Only `getFireHeld` matters for the fire gate.
        const stub = {
          _fireHeld: false,
          setFireHeld(v: boolean) { this._fireHeld = v; },
          getFireHeld(): boolean { return this._fireHeld; },
          getJoystickVector() { return null; },
          getBoostHeld() { return false; },
          setJoystick() { /* noop */ },
          setJoystickIdle() { /* noop */ },
          setBoostHeld() { /* noop */ },
        };
        // @ts-expect-error — runtime mutation through the dev hook.
        client.touchInput = stub;
      }
      client.touchInput!.setFireHeld(true);
      return 'ok';
    });
    expect(result).toBe('ok');

    // Hold for one full salvo (≥ 1 RAF + 1 server tick). 300 ms is
    // generous; cooldown is 3000 ms so only ONE fire happens.
    await shooter.page.waitForTimeout(300);

    await shooter.page.evaluate(() => {
      const w = window as unknown as {
        __eqxClient?: { touchInput: { setFireHeld: (v: boolean) => void } | null };
      };
      w.__eqxClient?.touchInput?.setFireHeld(false);
    });

    // Touch fire must produce a missile_spawned event server-side.
    const spawned = await fetchEvents(
      request,
      (e) => e.tag === 'missile_spawned'
        && e.data['ownerId'] === shooter.playerId
        && e.ts >= fireTs,
      { timeoutMs: 3000 },
    );
    expect(
      spawned,
      'touch FIRE did not produce a missile_spawned — the fire dispatch is ignoring touchInput.getFireHeld()',
    ).not.toBeNull();
  } finally {
    await shooter.ctx.close();
  }
});

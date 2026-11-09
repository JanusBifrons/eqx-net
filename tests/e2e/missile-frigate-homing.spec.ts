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
 *     2400 u lock range). Since the impact-only change (2026-06-06) the
 *     proximity fuse is disabled, so detonation here is always 'sweep'
 *     (a direct homing hit) — the assertion stays `cause !== 'lifetime'`.
 *   - Lock-to-fire (2026-11-09): the shooter (`?instantLock=1`) locks the
 *     target with its 'missiles' group through the LOCK button, then the
 *     AUTO group fires at the completed lock (`lockMissiles` below).
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
import { waitForInPlay } from './helpers/gameScenario';
import { lockOn, setActiveGroup, toAuto, toManual } from './helpers/fireControl';
import { test, expect } from '@playwright/test';
import type { Browser, Page, APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getWeapon } from '../../src/core/combat/WeaponCatalogue';

// Heat-seeker cooldown read from the catalogue. It was 180 ticks (3 s) when
// the held-fire test was written; c795302d made it 90 (1.5 s) and the
// hard-coded 3 s band went stale (2026-11-08).
const HS_COOLDOWN_TICKS = getWeapon('heat-seeker').cooldownTicks;
const HS_COOLDOWN_MS = (HS_COOLDOWN_TICKS * 1000) / 60;
// Hold for ~2.33 cooldowns: one initial salvo + at least one rollover.
const HS_HOLD_MS = Math.round(HS_COOLDOWN_MS * 2.33);

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? 'http://localhost:2567';

interface ServerLogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

// Joining waits for the loading curtain (infrastructural, up to ~16 s each
// under load), so the default 30 s is too tight for a two-ship test.
test.describe.configure({ timeout: 90_000 });

async function joinShip(
  browser: Browser,
  opts: { testId: string; spawnX: number; spawnY: number; shipKind: string; room?: string; extra?: Record<string, string>; touch?: boolean },
): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page; playerId: string }> {
  const ctx = await browser.newContext(opts.touch ? { hasTouch: true } : {});
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: opts.room ?? 'test-sector-fast',
    testId: opts.testId,
    spawnX: String(opts.spawnX),
    spawnY: String(opts.spawnY),
    shipKind: opts.shipKind,
    ...(opts.extra ?? {}),
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
    }, undefined,
    { timeout: 12_000 },
  );
  // The ship must be ACTIVE before anyone fires at it (it activates when the
  // loading curtain lifts).
  await waitForInPlay(page);
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

/**
 * Lock-to-fire (universal since 2026-11-09): the frigate's missile group fires
 * only at a COMPLETED lock. Make 'missiles' the active group, put the point-
 * defence laser in MAN (so it never adds its own fire / damage to the scene),
 * then lock `target` through the LOCK button. With `mode: 'auto'` the group then
 * fires on its own at the lock (no keyboard — synthetic Space on a freshly
 * loaded canvas was the flake the old `triggerFireForTest` dodged); with
 * `'manual'` it waits for held fire (Space / touch). The shooter must join with
 * `instantLock=1` so a non-hostile target locks in ≤ 100 ms.
 */
async function lockMissiles(page: Page, target: Parameters<typeof lockOn>[1], mode: 'auto' | 'manual'): Promise<void> {
  await toManual(page, 'pd');
  await setActiveGroup(page, 'missiles');
  await toManual(page, 'missiles');
  await lockOn(page, target);
  if (mode === 'auto') await toAuto(page, 'missiles');
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
    joinShip(browser, { testId, spawnX: 0, spawnY: 0, shipKind: 'missile-frigate', extra: { instantLock: '1' } }),
    joinShip(browser, { testId, spawnX: 0, spawnY: 1000, shipKind: 'fighter' }),
  ]);

  try {
    expect(shooter.playerId).not.toBe('');
    expect(target.playerId).not.toBe('');
    expect(shooter.playerId).not.toBe(target.playerId);

    // Lock the frigate's missile group on the target (LOCK button; the shooter
    // joined with instantLock so the PvP failsafe completes in ≤ 100 ms), then
    // flip it to AUTO: it fires on its own at the completed lock. No keyboard
    // (synthetic Space on a fresh canvas was the flake `triggerFireForTest`
    // used to dodge).
    const fireTs = Date.now();
    await lockMissiles(shooter.page, { kind: 'ship', playerId: target.playerId }, 'auto');

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
  // Lock-to-fire (2026-11-09): a missile fires only at a lock, so the target
  // must be one the racks bear on. `auto-fire-test` parks one peaceful,
  // hull-exposed fighter 150 u dead ahead (was `mount-test`'s 250 u ring,
  // where most drones sit outside the racks' ±15° arc). No asteroids.
  // `startHostile=1` marks it hostile, so the AUTO missile group locks it
  // on its own (normal lock time, no instantLock) and fires. The point-
  // defence laser goes to MAN at once so the damage asserted below is the
  // missile's, not the laser's.
  const testId = randomUUID();
  // Before the join: an AUTO salvo may leave as soon as the curtain lifts.
  const fireTs = Date.now();
  const shooter = await joinShip(browser, {
    testId,
    spawnX: 0,
    spawnY: 0,
    shipKind: 'missile-frigate',
    room: 'auto-fire-test',
    extra: { startHostile: '1', initialHull: '5000' },
  });

  try {
    expect(shooter.playerId).not.toBe('');
    await toManual(shooter.page, 'pd');
    await setActiveGroup(shooter.page, 'missiles');
    await toAuto(shooter.page, 'missiles');

    // Assertion 1: missile spawned with a lock on a DRONE (swarm-kind
    // target, NOT an asteroid). Asteroid exclusion is now at the
    // candidate-build site, so the lock target id should start with
    // `swarm-drone-` (or be a drone-style id from the spawner).
    const spawned = await fetchEvents(
      request,
      (e) => e.tag === 'missile_spawned'
        && e.data['ownerId'] === shooter.playerId
        && e.ts >= fireTs,
      // Covers the AUTO group's real (hostile-target) lock time before the
      // first salvo — the state under test, not a pacing wait.
      { timeoutMs: 15_000 },
    );
    expect(spawned, 'no missile_spawned event for shooter').not.toBeNull();
    const lockedTargetId = spawned!.data['lockedTargetId'] as string | null;
    const candidateCount = spawned!.data['candidateCount'] as number;
    expect(
      lockedTargetId,
      `lock was null — candidateCount=${candidateCount}. auto-fire-test has one drone 150 u ahead; ` +
      `if candidateCount=0 the candidate build is broken; if > 0 the predicate rejected all of them.`,
    ).not.toBeNull();
    expect(
      typeof lockedTargetId === 'string' && /^(swarm-drone-|pose-drone-|lwbot-)/.test(lockedTargetId),
      `missile locked onto unexpected target '${String(lockedTargetId)}' — expected a drone (swarm-drone-* / pose-drone-* / lwbot-*).`,
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
  //
  // Lock-to-fire (2026-11-09): held fire only fires a MAN group at a
  // completed lock, so the shooter locks a second pilot 600 u ahead (huge
  // hull, so the first salvo never kills it and drops the lock) in the
  // real-time `test-sector` (wall-clock cooldown bands below).
  const testId = randomUUID();
  const [shooter, target] = await Promise.all([
    joinShip(browser, { testId, spawnX: 0, spawnY: 0, shipKind: 'missile-frigate', room: 'test-sector', extra: { instantLock: '1' } }),
    joinShip(browser, { testId, spawnX: 0, spawnY: 600, shipKind: 'fighter', room: 'test-sector', extra: { initialHull: '100000' } }),
  ]);

  try {
    expect(shooter.playerId).not.toBe('');
    await lockMissiles(shooter.page, { kind: 'ship', playerId: target.playerId }, 'manual');

    // Click to focus + hold Space for ~2.33 cooldown windows (HS_HOLD_MS).
    // Expect ≥ 2 distinct salvos (the initial one at hold-start, then a
    // cooldown rollover).
    await shooter.page.locator('[data-testid="game-surface"]').click();
    await shooter.page.waitForTimeout(40);
    const fireTs = Date.now();
    await shooter.page.keyboard.down('Space');
    await shooter.page.waitForTimeout(HS_HOLD_MS);
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
    // the salvo boundary (well under the cooldown, well over any
    // intra-salvo Δ).
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
      `held-fire produced ${salvoTs.length} salvo(s) in ${HS_HOLD_MS} ms but expected ≥ 2 ` +
      `(cooldownTicks=${HS_COOLDOWN_TICKS} — the hold fits one initial fire + ≥ 1 cooldown rollover). ` +
      `If only 1 salvo, the held-fire path is broken (fireHeld not sampled across cooldown).`,
    ).toBeGreaterThanOrEqual(2);
    // Inter-salvo gap should be ≈ the cooldown. Allow -500/+700 ms
    // for tick-quantisation + RAF jitter.
    if (salvoTs.length >= 2) {
      const gap = salvoTs[1]! - salvoTs[0]!;
      // Diagnostic on a too-wide gap: dump the client's input_intent
      // log so we can see whether fireHeld was actually held throughout
      // and what inputTick was doing.
      if (gap > HS_COOLDOWN_MS + 700) {
        const intents = await shooter.page.evaluate((cooldownTicks) => {
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
          //   the first fire tick, the expected-second-fire tick (=first+cooldown),
          //   the actual-second-fire tick.
          const fireTicks = fires.map((f) => f.tick);
          const expectedSecond = fireTicks[0] !== undefined ? fireTicks[0] + cooldownTicks : null;
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
        }, HS_COOLDOWN_TICKS);
        // eslint-disable-next-line no-console
        console.log('HOLD-FIRE DIAG:', JSON.stringify(intents, null, 2));
      }
      expect(
        gap,
        `first inter-salvo gap was ${gap} ms — expected ≈ ${HS_COOLDOWN_MS} ms (cooldownTicks ${HS_COOLDOWN_TICKS} @ 60 Hz). ` +
        `Well under ⇒ cooldown not enforced; well over ⇒ tick rate stalled.`,
      ).toBeGreaterThanOrEqual(HS_COOLDOWN_MS - 500);
      expect(gap).toBeLessThanOrEqual(HS_COOLDOWN_MS + 700);
    }
  } finally {
    await Promise.all([shooter.ctx.close(), target.ctx.close()]);
  }
});

test('impact-only: a missile with no target FIZZLES on expiry — no lifetime/fuse detonation, no damage', async ({
  browser,
  request,
}) => {
  // Regression lock for the impact-only change (smoke handoff 2026-06-06,
  // Issue 2: "make it only explode on impact"). A missile that never lands
  // a DIRECT sweep hit must despawn WITHOUT detonating — no splash, no
  // damage, no explosion. Pre-change a missile that flew its full lifetime
  // detonated with cause 'lifetime' (splash-in-place), and a near-miss
  // detonated 'fuse' (proximityFuseRadius=36) → this test FAILS on the old
  // code, satisfying Invariant #13.
  //
  // Scenario (lock-to-fire, 2026-11-09 — a missile can no longer be fired
  // with nothing locked): a missile-frigate in the real-time `test-sector`
  // (no drones, no asteroids) locks a second pilot 1100 u ahead (inside the
  // 1200 u missile reach, ~2.7 s of flight) and the AUTO group fires. The
  // moment the first missile spawns the target LEAVES the room, so the
  // missile has nothing left to hit and must fizzle at the end of its 6 s
  // lifetime.
  const testId = randomUUID();
  const [shooter, target] = await Promise.all([
    joinShip(browser, { testId, spawnX: 0, spawnY: 0, shipKind: 'missile-frigate', room: 'test-sector', extra: { instantLock: '1' } }),
    joinShip(browser, { testId, spawnX: 0, spawnY: 1100, shipKind: 'fighter', room: 'test-sector' }),
  ]);
  let targetOpen = true;

  try {
    expect(shooter.playerId).not.toBe('');
    const fireTs = Date.now();
    await lockMissiles(shooter.page, { kind: 'ship', playerId: target.playerId }, 'auto');

    // Confirm the missile actually spawned (so "no detonation" means
    // "fizzled", not "never fired").
    const spawned = await fetchEvents(
      request,
      (e) => e.tag === 'missile_spawned' && e.data['ownerId'] === shooter.playerId && e.ts >= fireTs,
      { timeoutMs: 4000 },
    );
    expect(spawned, 'no missile_spawned — fire never reached the simulation').not.toBeNull();
    // Take the only target out of the world: the missile is now a miss.
    await target.ctx.close();
    targetOpen = false;

    // The missile must EXPIRE. Missiles step once per server update, which
    // `testTimeScale` does not speed up, so the lifetime is the catalogue's
    // `lifetimeTicks` in real time (6 s), not "~600 ms at 10×" as this spec
    // once assumed (it waited 1.5 s + 2 s and never saw the expiry,
    // 2026-11-08). Poll with the lifetime as a deadline, not a pace.
    const lifetimeMs = (getWeapon('heat-seeker') as { lifetimeTicks: number }).lifetimeTicks * (1000 / 60);
    const expired = await fetchEvents(
      request,
      (e) => e.tag === 'missile_expired' && e.data['ownerId'] === shooter.playerId && e.ts >= fireTs,
      { timeoutMs: lifetimeMs + 3000 },
    );
    expect(expired, 'missile never logged missile_expired — the impact-only despawn path did not run').not.toBeNull();

    // No IMPACT detonation from this shooter. Since WS-C #14 an expiring
    // missile still broadcasts a `missile_detonated` with cause 'lifetime'
    // (so the client removes it instead of freezing a ghost), with NO splash;
    // a 'sweep' / 'fuse' / 'wall' detonation here would be an in-place
    // explosion with no target present.
    const impact = await fetchEvents(
      request,
      (e) => e.tag === 'missile_detonated' && e.data['ownerId'] === shooter.playerId && e.ts >= fireTs
        && e.data['cause'] !== 'lifetime',
      { timeoutMs: 500 },
    );
    expect(
      impact,
      `a missile detonated (cause '${String(impact?.data['cause'])}') with no target present — ` +
      `impact-only means a missed missile must fizzle, never explode in-place.`,
    ).toBeNull();

    // And no damage was applied by this shooter.
    const damageApplied = await fetchEvents(
      request,
      (e) => e.tag === 'damage_applied' && e.data['shooterId'] === shooter.playerId,
      { timeoutMs: 500 },
    );
    expect(damageApplied, 'a missed missile dealt damage — impact-only violated').toBeNull();
  } finally {
    await Promise.all([shooter.ctx.close(), targetOpen ? target.ctx.close() : Promise.resolve()]);
  }
});

test("touch fire path: holding a MAN group's chip dispatches a missile", async ({
  browser,
  request,
}) => {
  // Regression lock for the touch-fire branch (2026-05-27: the hoisted fire
  // dispatch once read the keyboard only, so phones could not fire at all;
  // the Space-driven tests trivially passed despite the bug).
  //
  // Lock-to-fire (2026-11-09): a touch pilot fires a MAN weapon group by
  // HOLDING its weapon-strip chip (the old FIRE button / touchInput.fireHeld
  // path is gone). This drives a real touch press on the chip (CDP touch
  // events → pointerdown/pointerup) with the missiles locked on a pilot ahead.
  const testId = randomUUID();
  const [shooter, target] = await Promise.all([
    joinShip(browser, { testId, spawnX: 0, spawnY: 0, shipKind: 'missile-frigate', room: 'test-sector', extra: { instantLock: '1' }, touch: true }),
    joinShip(browser, { testId, spawnX: 0, spawnY: 600, shipKind: 'fighter', room: 'test-sector', extra: { initialHull: '100000' } }),
  ]);
  try {
    await lockMissiles(shooter.page, { kind: 'ship', playerId: target.playerId }, 'manual');

    const box = await shooter.page.locator('[data-testid="fc-chip-missiles"]').boundingBox();
    expect(box, 'missiles chip not on screen').not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    const cdp = await shooter.ctx.newCDPSession(shooter.page);
    const fireTs = Date.now();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    // Hold for one salvo (≥ 1 RAF + 1 server tick); the cooldown means
    // only ONE fire happens.
    await shooter.page.waitForTimeout(300);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

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
      'holding the MAN missiles chip did not produce a missile_spawned — the chip-hold fire path is broken',
    ).not.toBeNull();
  } finally {
    await Promise.all([shooter.ctx.close(), target.ctx.close()]);
  }
});

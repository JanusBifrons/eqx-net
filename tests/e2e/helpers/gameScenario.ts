import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { DEFAULT_BASE_URL } from './ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

export interface TestClientOpts {
  spawnX: number;
  spawnY: number;
  /** Optional spawn HP override (test-sector only; gated server-side).
   *  Use 1 for "kill in one tick" scenarios so the spec runs in seconds
   *  instead of fighting 500 HP + shield through full TTK. */
  initialHull?: number;
  /** Pre-load the roster XP so one kill levels the ship (roster-backed rooms only). */
  initialXp?: number;
  initialShield?: number;
  /** Which test room to join (default 'test-sector'). Pass
   *  'test-sector-fast' for 10x physics-tick acceleration, or
   *  'combat-drone-test' for one peaceful, hull-exposed scout parked at
   *  (0,200) in the beam line of a (0,0)-angle-0 shooter. */
  room?: 'test-sector' | 'test-sector-fast' | 'combat-drone-test';
  /** Initial facing angle in radians (test-sector only; gated server-side).
   *  SPAWN creates the body at angle 0; this forces a deterministic facing so
   *  a held beam/bolt fires along a known vector. Forward = (-sin θ, cos θ):
   *  θ=0 fires toward +y, θ=-π/2 toward +x. */
  initialAngle?: number;
  /** Ship-kind id (e.g. 'interceptor' fires the hitscan beam, 'scout'/
   *  'fighter'/'heavy'/'gunship' fire bolts, 'missile-frigate' fires missiles).
   *  NOT testMode-gated (legit player choice) so it works in any room. Use
   *  'interceptor' for any spec that asserts `data-beam-active`. */
  shipKind?: string;
  /** Mobile-perf gate test-only — bytes per RAF tick to retain on a
   *  global array. Wires `?injectLeak=N` so the gate's
   *  `jsHeapGrowthMb` metric can be exercised end-to-end. DEV-build
   *  only; the hook tree-shakes from prod via `import.meta.env.DEV`. */
  injectLeak?: number;
  /** Lock-to-fire bespoke trigger (`?instantLock=1`, testMode rooms only):
   *  every lock completes on the next lock step (≤ 100 ms). Use it in any spec
   *  that needs to SHOOT something but isn't about locking. It does NOT widen
   *  AUTO targeting — add `anyTarget` for that. */
  instantLock?: boolean;
  /** Fire-control bespoke trigger (`?lockTimeCapS=N`, testMode rooms only):
   *  no NON-player lock in the room (NPC ships on pilots, capital turrets on
   *  structures, structure / coastal turrets) takes longer than N seconds;
   *  0 = the first lock step. Reaches the room on the room-creating client. */
  lockTimeCapS?: number;
  /** Fire-control bespoke trigger (`?anyTarget=1`, testMode rooms only): AUTO
   *  weapon groups also pick NON-hostile NPCs and non-own structures in reach
   *  + arc. Never auto-picks other players — lock those with `lockOn`
   *  (helpers/fireControl.ts). Usually paired with `instantLock`. */
  anyTarget?: boolean;
  /** Fire-control trigger (`?groupMode=manual`, testMode rooms only): every
   *  weapon group starts in MAN, so AUTO never self-picks before the spec sets
   *  the group it wants (`toAuto` / `lockOn`). Pair with `instantLock` when an
   *  AUTO group would otherwise kill a fragile target first. */
  groupMode?: 'manual';
  /** Per-test room isolation. Pass a unique value (e.g. randomUUID) for
   *  the first client; pass the SAME value for additional clients that
   *  must share a room with the first. Omit ⇒ a fresh UUID is minted
   *  per call (NOT shared — every launchTestClient call is its own
   *  room). For multi-client specs, mint the testId at the test level
   *  and pass it explicitly to each launchTestClient call. */
  testId?: string;
  /** Any other URL params (e.g. `{ worker: '0', art: 'machined' }`). */
  extraParams?: Record<string, string>;
  /** How long to wait for the join (ms, default 12 s). Capitals take longer
   *  (their art bakes on spawn): load time, not game time. */
  joinTimeoutMs?: number;
  /** Return only once the client is IN PLAY (loading curtain lifted, ship
   *  active) — default `true`. A ship that exists but sits behind the
   *  curtain ignores input and is not yet targetable, so a spec that acts
   *  straight after the join races the curtain (2026-11-08: beam-appears'
   *  2 s deadline missed the ~2.4 s curtain). Pass `false` ONLY in a spec
   *  that observes the curtain itself (join-art-ready, loading-catchup). */
  waitForInPlay?: boolean;
}

export async function launchTestClient(browser: Browser, opts: TestClientOpts) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: opts.room ?? 'test-sector',
    spawnX: String(opts.spawnX),
    spawnY: String(opts.spawnY),
    testId: opts.testId ?? randomUUID(),
  });
  if (opts.initialHull !== undefined) params.set('initialHull', String(opts.initialHull));
  if (opts.initialXp !== undefined) params.set('initialXp', String(opts.initialXp));
  if (opts.initialShield !== undefined) params.set('initialShield', String(opts.initialShield));
  if (opts.initialAngle !== undefined) params.set('initialAngle', String(opts.initialAngle));
  if (opts.shipKind !== undefined) params.set('shipKind', opts.shipKind);
  if (opts.injectLeak !== undefined) params.set('injectLeak', String(opts.injectLeak));
  if (opts.instantLock) params.set('instantLock', '1');
  if (opts.lockTimeCapS !== undefined) params.set('lockTimeCapS', String(opts.lockTimeCapS));
  if (opts.anyTarget) params.set('anyTarget', '1');
  if (opts.groupMode) params.set('groupMode', opts.groupMode);
  for (const [k, v] of Object.entries(opts.extraParams ?? {})) params.set(k, v);
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () =>
      parseInt(
        document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0',
        10,
      ) > 0, undefined,
    { timeout: opts.joinTimeoutMs ?? 12_000 },
  );
  if (opts.waitForInPlay !== false) await waitForInPlay(page);
  return { ctx, page };
}

export interface GalaxyTestClientOpts {
  /** Shared room key — mint ONE per test (randomUUID) and pass to every
   *  client that must share the room (owner + observer). filterBy(['testId'])
   *  routes same-testId clients to the same galaxy-test room instance. */
  testId: string;
  /** Durable identity seeded into localStorage before load so the client
   *  joins with a known playerId (queryable via /dev/player-ships). Must be a
   *  UUID (the server rejects non-UUID playerIds). Defaults to a fresh UUID. */
  playerId?: string;
  shipKind?: string;
  spawnX?: number;
  spawnY?: number;
  /** Test-only disconnect-linger TTL (ms). Short values let a spec observe
   *  the despawn→return-to-pool transition without the 15-min prod window. */
  lingerMs?: number;
  /** Force a fresh roster ship (`?newShip=1` → isNewShip). Used to displace
   *  an existing hull into a lingering one in the same browser context. */
  newShip?: boolean;
  /** Renderer zoom override (`?zoom=`). > 1 zooms IN — handy for visual
   *  capture specs that want the ship + effects larger on screen. */
  zoom?: number;
  /** See `TestClientOpts.instantLock`. */
  instantLock?: boolean;
  /** See `TestClientOpts.waitForInPlay` — default `true`. */
  waitForInPlay?: boolean;
}

/**
 * Launch a browser client into the isolated, bot-free, LINGER-CAPABLE
 * `galaxy-test` room (sectorKey set, droneCount 0, filterBy testId). Unlike
 * `launchTestClient` (engineering rooms that never linger) this reaches the
 * galaxy-only linger / abandon-poll paths. Forces `?worker=0` so the rendered
 * canvas is screenshot-able. Returns the seeded `playerId` for roster queries.
 */
export async function launchGalaxyTestClient(browser: Browser, opts: GalaxyTestClientOpts) {
  const playerId = opts.playerId ?? randomUUID();
  const ctx = await browser.newContext();
  await ctx.addInitScript((pid) => {
    try {
      localStorage.setItem('eqxPlayerId', pid as string);
    } catch {
      /* ignore */
    }
  }, playerId);
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'galaxy-test',
    worker: '0',
    testId: opts.testId,
  });
  if (opts.shipKind !== undefined) params.set('shipKind', opts.shipKind);
  if (opts.spawnX !== undefined) params.set('spawnX', String(opts.spawnX));
  if (opts.spawnY !== undefined) params.set('spawnY', String(opts.spawnY));
  if (opts.lingerMs !== undefined) params.set('lingerMs', String(opts.lingerMs));
  if (opts.newShip) params.set('newShip', '1');
  if (opts.zoom !== undefined) params.set('zoom', String(opts.zoom));
  if (opts.instantLock) params.set('instantLock', '1');
  await page.goto(`${BASE_URL}?${params}`);
  // Galaxy rooms lazy-create + boot a physics worker on first join, so allow
  // a longer ready window than the engineering-room helper.
  await page.waitForFunction(
    () =>
      parseInt(
        document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0',
        10,
      ) > 0, undefined,
    { timeout: 20_000 },
  );
  if (opts.waitForInPlay !== false) await waitForInPlay(page);
  return { ctx, page, playerId };
}

export const surface = (page: Page) => page.locator('[data-testid="game-surface"]');

/**
 * Wait until this client is IN PLAY: the loading curtain has lifted (the
 * client sends `client_ready` and the HUD mounts then). A ship counts for
 * targeting, collisions and hostility only once active, and the curtain
 * holds for art + the spawn handshake (6–16 s on a loaded box), so a test
 * that acts right after `data-local-player-id` appears acts on a pending
 * ship (perf-plan test audit 2026-11-06: missile locks saw no entities, the
 * energy bar was not mounted yet).
 */
export async function waitForInPlay(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForSelector('[data-testid="warp-screen"][data-warp-visible="0"]', { state: 'attached', timeout: timeoutMs });
}

export async function getHullPct(page: Page): Promise<number> {
  return parseInt((await surface(page).getAttribute('data-hull-pct')) ?? '100', 10);
}

export async function getSectorAlert(page: Page): Promise<string> {
  return (await surface(page).getAttribute('data-sector-alert')) ?? '';
}

export async function getShipX(page: Page): Promise<number> {
  return parseFloat((await surface(page).getAttribute('data-ship-x')) ?? '0');
}

export async function getShipY(page: Page): Promise<number> {
  return parseFloat((await surface(page).getAttribute('data-ship-y')) ?? '0');
}

export async function getObstaclePositions(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return JSON.parse((await surface(page).getAttribute('data-obstacle-positions')) ?? '{}');
}

export async function getShipPositions(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return JSON.parse((await surface(page).getAttribute('data-ship-positions')) ?? '{}');
}

/** Lingering hulls visible to this client (disconnected / displaced ships,
 *  isActive=false). Keyed by shipInstanceId; each carries the owning playerId.
 *  NOTE: the OWNER never sees their own displaced lingering hull (it's
 *  rescued into mirror.ships) — assert this from a 2nd observer client. */
export async function getLingeringPositions(
  page: Page,
): Promise<Record<string, { x: number; y: number; ownerPlayerId: string }>> {
  return JSON.parse((await surface(page).getAttribute('data-lingering-positions')) ?? '{}');
}

export async function getBeamActive(page: Page): Promise<boolean> {
  return (await surface(page).getAttribute('data-beam-active')) === '1';
}

export async function getRemoteLaserCount(page: Page): Promise<number> {
  return parseInt((await surface(page).getAttribute('data-remote-laser-count')) ?? '0', 10);
}

export async function getRemoteHitTargets(page: Page): Promise<string[]> {
  return JSON.parse((await surface(page).getAttribute('data-remote-hit-targets')) ?? '[]') as string[];
}

export async function getRemoteLaserRanges(page: Page): Promise<Record<string, number>> {
  return JSON.parse(
    (await surface(page).getAttribute('data-remote-laser-ranges')) ?? '{}',
  ) as Record<string, number>;
}

export async function getLocalPlayerId(page: Page): Promise<string> {
  return (await surface(page).getAttribute('data-local-player-id')) ?? '';
}

export async function waitForDeath(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-hull-pct') === '0', undefined,
    { timeout },
  );
}

export async function waitForRespawn(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () =>
      parseInt(
        document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-hull-pct') ?? '0',
        10,
      ) > 0, undefined,
    { timeout },
  );
}

/**
 * Netcode-health gate — Playwright spec (plan: e2e-rebuild, Phase 1).
 *
 * NOT a normal E2E spec: it is driven exclusively by
 * `tests/netgate/run-netgate.mjs` (`pnpm e2e:netgate`), which boots the
 * Colyseus server, the HTTP+WS latency proxy, and one or two same-mode
 * Vite DEV arms, then runs this with `CI_SKIP_WEBSERVER=1` so Playwright
 * does NOT start its own webServer. Running it directly (plain
 * `pnpm e2e`) is expected to skip — the env contract below is absent.
 *
 * STEP 3 (this commit) = single-arm SEAM PROOF only. It asserts the
 * LIVENESS preconditions end-to-end:
 *   - the client joined `feel-test-25` THROUGH the latency proxy
 *     (proves the HTTP+WS reverse proxy / hostile-F1 fix: colyseus.js
 *     matchmake REST + WS both traversed 2568 → 2567);
 *   - `window.__eqxDiagEnabled === false` under real WebDriver (proves
 *     Phase 0a `?diag=0` overrides the webdriver auto-diag — the gate
 *     measures the player program, not the instrumented one);
 *   - no `mirror_clone` entries in `__eqxLogs` (positive proof the
 *     heavy per-frame diagnostic path stayed OFF);
 *   - `snapshotCount > 40` (the live loop actually ran under injected
 *     latency).
 * It does NOT yet compare arms or apply the budget — Step 4 adds the
 * interleaved baseline arm + `evaluateNetHealth`.
 */
import { test, expect, type Page } from '@playwright/test';

interface ArmSpec {
  name: string;
  url: string;
}

const TOKEN = process.env['NETGATE_TOKEN'] ?? '';
const ARMS: ArmSpec[] = JSON.parse(process.env['NETGATE_ARMS'] ?? '[]') as ArmSpec[];
const RUN_MS = Number(process.env['NETGATE_RUN_MS'] ?? 8000);

/** The fixed, deterministic scenario — identical for every arm/rep.
 *  Mirrors `feel-test-lockstep.spec.ts:138-151` (strafe through the
 *  25-drone pack: thrust + fire + alternating hard turns). No RNG, no
 *  mouse, no human timing. */
async function runScenario(page: Page): Promise<void> {
  await page.keyboard.down('w');
  await page.keyboard.down('Space');
  await page.keyboard.down('a');
  await page.waitForTimeout(RUN_MS * 0.25);
  await page.keyboard.up('a');
  await page.keyboard.down('d');
  await page.waitForTimeout(RUN_MS * 0.25);
  await page.keyboard.up('d');
  await page.keyboard.down('a');
  await page.waitForTimeout(RUN_MS * 0.25);
  await page.keyboard.up('a');
  await page.keyboard.up('w').catch(() => undefined);
  await page.keyboard.up('Space').catch(() => undefined);
  await page.waitForTimeout(RUN_MS * 0.1);
}

async function readPredStats(page: Page): Promise<Record<string, number | boolean>> {
  return page.evaluate(() => {
    const raw = document
      .querySelector('[data-testid="game-surface"]')
      ?.getAttribute('data-pred-stats');
    return JSON.parse(raw ?? '{}') as Record<string, number | boolean>;
  });
}

async function readDiagState(page: Page): Promise<{ diagEnabled: boolean; mirrorClones: number }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __eqxDiagEnabled?: boolean;
      __eqxLogs?: Array<{ tag: string }>;
    };
    return {
      diagEnabled: w.__eqxDiagEnabled === true,
      mirrorClones: (w.__eqxLogs ?? []).filter((e) => e.tag === 'mirror_clone').length,
    };
  });
}

// The gate is intentionally long-running (one fixed-duration scenario
// per arm/rep); it owns its own timeout, like feel-test-lockstep. These
// MUST be module-level — Playwright forbids test.use()/configure() inside
// a describe group.
test.describe.configure({
  timeout: Number(process.env['NETGATE_TEST_TIMEOUT_MS'] ?? 180_000),
  retries: 0,
});
test.use({ trace: 'off' });

test.describe('netcode-health gate', () => {
  test('single-arm seam: joins through the latency proxy, diag forced OFF, live loop runs', async ({
    browser,
  }) => {
    test.skip(ARMS.length === 0, 'driven only by run-netgate.ts (NETGATE_ARMS unset)');
    const arm = ARMS[0]!;
    const origin = new URL(arm.url).origin;

    const ctx = await browser.newContext();
    // hostile S1: the 5173-scoped storageState does NOT cover this arm's
    // origin — inject the minted JWT for THIS origin before any nav.
    await ctx.addInitScript(
      (token) => {
        try {
          window.localStorage.setItem('eqxAuthToken', token);
        } catch {
          /* localStorage unavailable — the assertion below will catch it */
        }
      },
      TOKEN,
    );
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`    [${arm.name} browser error] ${m.text()}`);
    });
    // Low-volume, high-signal diagnostics only (per-request logging
    // floods on healthz polls over the gate's long run): the room WS
    // target + any failed matchmake/WS request.
    page.on('websocket', (ws) => console.log(`    [${arm.name} WS] ${ws.url()}`));
    page.on('requestfailed', (r) => {
      const u = r.url();
      if (/\/matchmake|2568|sessionId=/.test(u)) {
        console.log(`    [${arm.name} REQ-FAIL] ${r.method()} ${u} :: ${r.failure()?.errorText ?? '?'}`);
      }
    });

    // ?diag=0 (Phase 0a) forces the heavy instrumentation OFF even though
    // Playwright sets navigator.webdriver. ?room=feel-test-25 deep-links
    // straight into the deterministic 25-drone room.
    await page.goto(`${arm.url}/?room=feel-test-25&diag=0`);

    // Join succeeded ⇒ the matchmake REST + WS BOTH traversed the proxy
    // (hostile-F1 fix proven end-to-end). If the proxy were WS-only this
    // would hang here.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="ship-count"]');
        return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
      },
      { timeout: 30_000 },
    );

    // Phase 0a, proven under REAL WebDriver: diag is OFF before we even
    // exercise the loop — fail fast if the override regressed.
    const pre = await readDiagState(page);
    expect(pre.diagEnabled, '__eqxDiagEnabled must be false (Phase 0a ?diag=0 under webdriver)').toBe(
      false,
    );

    await runScenario(page);

    const stats = await readPredStats(page);
    const post = await readDiagState(page);

    console.log(`\n=== netcode-health single-arm seam [${arm.name}] (${origin}) ===`);
    console.log(`  snapshotCount    : ${stats['snapshotCount']}`);
    console.log(`  rollingCorrRate  : ${stats['rollingCorrRate']}`);
    console.log(`  ticksAhead       : ${stats['ticksAhead']}`);
    console.log(`  maxDriftUnits    : ${stats['maxDriftUnits']}`);
    console.log(`  snapshotJitterMs : ${stats['snapshotJitterMs']}`);
    console.log(`  rttMeanMs        : ${stats['rttMeanMs']}`);
    console.log(`  __eqxDiagEnabled : ${post.diagEnabled}`);
    console.log(`  mirror_clone logs: ${post.mirrorClones}`);
    console.log('==========================================================\n');

    // Liveness preconditions ONLY (Step 3 scope).
    expect(post.diagEnabled, 'diag must stay OFF for the whole run').toBe(false);
    expect(
      post.mirrorClones,
      'no mirror_clone entries ⇒ the heavy per-frame diagnostic path was OFF',
    ).toBe(0);
    expect(
      Number(stats['snapshotCount']),
      'the live loop must have run under injected latency (snapshots flowed)',
    ).toBeGreaterThan(40);

    await ctx.close();
  });
});

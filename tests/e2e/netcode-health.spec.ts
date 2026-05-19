/**
 * Netcode-health gate — Playwright spec (plan: e2e-rebuild, Phase 1).
 *
 * NOT a normal E2E spec: driven exclusively by
 * `tests/netgate/run-netgate.ts` (`pnpm e2e:netgate`), which boots the
 * Colyseus server, per-arm HTTP+WS latency proxies, and two same-mode
 * Vite DEV arms, then runs this with `CI_SKIP_WEBSERVER=1`. Plain
 * `pnpm e2e` skips it (the env contract is absent).
 *
 * TWO-ARM gate (≥2 arms): interleaved A/B/A/B… (baseline, HEAD,
 * baseline, …) for `NETGATE_REPS` reps, sector reset before every arm
 * visit, then per-metric MEDIAN across reps fed to the pure
 * `evaluateNetHealth` budget. Interleaving + median rejects a one-arm
 * host transient (hostile S2 — sequential arms can't cancel it,
 * distributional comparison can). The budget is relative∧absolute so a
 * code regression trips while same-session host load cancels.
 *
 * ONE-ARM (1 arm): Step-3 liveness seam proof only (kept for fast
 * bring-up debugging).
 *
 * Liveness preconditions are asserted distinctly from a metric
 * regression — "did not validly run" must never read as "healthy".
 */
import { test, expect, type Page } from '@playwright/test';
import { evaluateNetHealth, type NetHealthArm } from '../netgate/netHealthBudget';

interface ArmSpec {
  name: string;
  url: string;
}

const TOKEN = process.env['NETGATE_TOKEN'] ?? '';
const ARMS: ArmSpec[] = JSON.parse(process.env['NETGATE_ARMS'] ?? '[]') as ArmSpec[];
const RUN_MS = Number(process.env['NETGATE_RUN_MS'] ?? 8000);
// Even default so arm-order alternation balances first/second-after-reset
// slots exactly (each arm is "first" half the reps, "second" the other).
const REPS = Number(process.env['NETGATE_REPS'] ?? 4);
const RESET_URL = process.env['NETGATE_RESET_URL'] ?? '';

// The gate owns its timeout (long by design — interleaved reps × arms);
// MUST be module-level (Playwright forbids it inside a describe group).
test.describe.configure({
  timeout: Number(process.env['NETGATE_TEST_TIMEOUT_MS'] ?? 360_000),
  retries: 0,
});
test.use({ trace: 'off' });

interface RepSample {
  rollingCorrRate: number;
  ticksAhead: number;
  maxDriftUnits: number;
  totalDriftUnits: number;
  snapshotCount: number;
  snapshotJitterMs: number;
  droppedSnapshotsRecent: number;
  rttMeanMs: number;
  diagEnabled: boolean;
  mirrorClones: number;
}

/** Fixed, deterministic scenario — identical for every arm/rep. Mirrors
 *  `feel-test-lockstep.spec.ts:138-151` (strafe the 25-drone pack). */
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

/** One arm visit: fresh context, per-origin JWT inject (hostile S1 —
 *  the 5173-scoped storageState does NOT cover :5273/:5274), join
 *  through that arm's latency proxy, run the scenario, sample stats. */
async function visitArm(
  browser: import('@playwright/test').Browser,
  arm: ArmSpec,
): Promise<RepSample> {
  const ctx = await browser.newContext();
  await ctx.addInitScript((token) => {
    try {
      window.localStorage.setItem('eqxAuthToken', token as string);
    } catch {
      /* asserted below */
    }
  }, TOKEN);
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`    [${arm.name} err] ${m.text()}`);
  });
  page.on('websocket', (ws) => console.log(`    [${arm.name} WS] ${ws.url()}`));
  page.on('requestfailed', (r) => {
    if (/\/matchmake|256[89]|sessionId=/.test(r.url())) {
      console.log(`    [${arm.name} REQ-FAIL] ${r.url()} :: ${r.failure()?.errorText ?? '?'}`);
    }
  });

  try {
    await page.goto(`${arm.url}/?room=feel-test-25&diag=0`);
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="ship-count"]');
        return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
      },
      { timeout: 30_000 },
    );
    // Phase 0a, under REAL webdriver: fail fast if diag is on.
    const preDiag = await page.evaluate(
      () => (window as unknown as { __eqxDiagEnabled?: boolean }).__eqxDiagEnabled === true,
    );
    expect(preDiag, `[${arm.name}] __eqxDiagEnabled must be false (Phase 0a)`).toBe(false);

    await runScenario(page);

    const s = await page.evaluate(() => {
      const surf = document.querySelector('[data-testid="game-surface"]');
      const stats = JSON.parse(surf?.getAttribute('data-pred-stats') ?? '{}') as Record<
        string,
        number
      >;
      const w = window as unknown as { __eqxDiagEnabled?: boolean; __eqxLogs?: { tag: string }[] };
      return {
        rollingCorrRate: Number(stats['rollingCorrRate'] ?? 0),
        ticksAhead: Number(stats['ticksAhead'] ?? 0),
        maxDriftUnits: Number(stats['maxDriftUnits'] ?? 0),
        totalDriftUnits: Number(stats['totalDriftUnits'] ?? 0),
        snapshotCount: Number(stats['snapshotCount'] ?? 0),
        snapshotJitterMs: Number(stats['snapshotJitterMs'] ?? 0),
        droppedSnapshotsRecent: Number(stats['droppedSnapshotsRecent'] ?? 0),
        rttMeanMs: Number(stats['rttMeanMs'] ?? 0),
        diagEnabled: w.__eqxDiagEnabled === true,
        mirrorClones: (w.__eqxLogs ?? []).filter((e) => e.tag === 'mirror_clone').length,
      };
    });
    return s;
  } finally {
    await ctx.close();
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function toArm(samples: RepSample[]): NetHealthArm {
  const meanDrift = samples.map((r) => r.totalDriftUnits / Math.max(1, r.snapshotCount));
  return {
    rollingCorrRate: median(samples.map((r) => r.rollingCorrRate)),
    ticksAhead: median(samples.map((r) => r.ticksAhead)),
    maxDriftUnits: median(samples.map((r) => r.maxDriftUnits)),
    meanDriftUnits: median(meanDrift),
    snapshotJitterMs: median(samples.map((r) => r.snapshotJitterMs)),
    droppedSnapshotsRecent: median(samples.map((r) => r.droppedSnapshotsRecent)),
    // Liveness: the WEAKEST rep must still have run (min, not median).
    snapshotCount: Math.min(...samples.map((r) => r.snapshotCount)),
    // Any rep with diag on ⇒ the wrong program was measured.
    diagEnabled: samples.some((r) => r.diagEnabled),
  };
}

async function resetSector(): Promise<void> {
  if (!RESET_URL) return;
  await fetch(RESET_URL, { method: 'POST' }).catch(() => undefined);
}

test.describe('netcode-health gate', () => {
  test('baseline-vs-HEAD netcode health is within budget (or single-arm seam)', async ({
    browser,
  }) => {
    test.skip(ARMS.length === 0, 'driven only by run-netgate.ts (NETGATE_ARMS unset)');

    // ---- Single-arm: Step-3 liveness seam proof only ----
    if (ARMS.length === 1) {
      await resetSector();
      const s = await visitArm(browser, ARMS[0]!);
      console.log(`\n=== single-arm seam [${ARMS[0]!.name}] ===`);
      console.log(`  snapshotCount ${s.snapshotCount} | diag ${s.diagEnabled} | mirror_clone ${s.mirrorClones}`);
      expect(s.diagEnabled, 'diag must stay OFF').toBe(false);
      expect(s.mirrorClones, 'heavy diagnostic path must be OFF').toBe(0);
      expect(s.snapshotCount, 'live loop must have run').toBeGreaterThan(40);
      return;
    }

    // ---- Two-arm: interleaved A/B/A/B…, median, budget ----
    const baseline = ARMS.find((a) => a.name === 'baseline') ?? ARMS[0]!;
    const head = ARMS.find((a) => a.name === 'HEAD') ?? ARMS[1]!;
    const samples: Record<string, RepSample[]> = { [baseline.name]: [], [head.name]: [] };

    for (let rep = 1; rep <= REPS; rep++) {
      // Alternate the order each rep so neither arm is ALWAYS the cold
      // "first-after-reset" or warm "second" slot — that systematic
      // per-slot bias is what median-over-random-reps cannot cancel
      // (hostile S2 / self-critique #1). Balanced exactly for even REPS.
      const order = rep % 2 === 1 ? [baseline, head] : [head, baseline];
      for (const arm of order) {
        await resetSector(); // before every arm visit (incl. the very first)
        const s = await visitArm(browser, arm);
        samples[arm.name]!.push(s);
        console.log(
          `  rep${rep} ${arm.name.padEnd(8)} corr=${s.rollingCorrRate.toFixed(3)} ` +
            `ahead=${s.ticksAhead} maxDrift=${s.maxDriftUnits.toFixed(2)} ` +
            `jit=${s.snapshotJitterMs.toFixed(1)} drop=${s.droppedSnapshotsRecent} ` +
            `snaps=${s.snapshotCount} rtt=${s.rttMeanMs.toFixed(0)} diag=${s.diagEnabled}`,
        );
      }
    }
    await resetSector(); // leave no warm room for the next run

    const baseArm = toArm(samples[baseline.name]!);
    const headArm = toArm(samples[head.name]!);
    const verdict = evaluateNetHealth(headArm, baseArm);

    console.log(`\n=== netcode-health verdict (medians over ${REPS} reps) ===`);
    console.log(`  baseline: ${JSON.stringify(baseArm)}`);
    console.log(`  HEAD    : ${JSON.stringify(headArm)}`);
    if (verdict.preconditionFailures.length) {
      console.log(`  PRECONDITION FAILURES:`);
      for (const p of verdict.preconditionFailures) console.log(`    - ${p}`);
    }
    for (const f of verdict.failures) {
      console.log(
        `  REGRESSION ${f.metric}: HEAD ${f.head} vs baseline ${f.baseline} ` +
          `(ratio ${f.ratio.toFixed(2)}, >ceil ${f.ceil})`,
      );
    }
    console.log(`  PASS=${verdict.pass}`);
    console.log('==========================================================\n');

    expect(
      verdict.preconditionFailures,
      `gate did not validly run: ${verdict.preconditionFailures.join('; ')}`,
    ).toEqual([]);
    expect(
      verdict.pass,
      `netcode-health regressed vs baseline: ${verdict.failures
        .map((f) => `${f.metric} ${f.head}↗${f.baseline}`)
        .join(', ')}`,
    ).toBe(true);
  });
});

/**
 * Netcode-health gate — Playwright spec (plan: e2e-rebuild Phase 1;
 * multi-scenario expansion plan: misty-teapot).
 *
 * NOT a normal E2E spec: driven exclusively by
 * `tests/netgate/run-netgate.ts` (`pnpm e2e:netgate`), which boots the
 * Colyseus server, per-arm HTTP+WS latency proxies, and two same-mode
 * Vite DEV arms, then runs this with `CI_SKIP_WEBSERVER=1`. Plain
 * `pnpm e2e` skips it (the env contract is absent).
 *
 * MULTI-SCENARIO: the set of scenarios to run comes from
 * `NETGATE_SCENARIOS` (CSV of `scenarios.ts` names, default `core`). Each
 * resolved scenario becomes its OWN `test()` so CI reports per-scenario
 * pass/fail and each keeps its own (long) timeout. `core` (feel-test-25)
 * is byte-identical to the historical single-scenario gate.
 *
 * TWO-ARM gate (≥2 arms): interleaved A/B/A/B… (baseline, HEAD,
 * baseline, …) for `NETGATE_REPS` reps, sector reset before every arm
 * visit, then per-metric MEDIAN across reps fed to the pure
 * `evaluateNetHealth` budget. Interleaving + median rejects a one-arm
 * host transient. The budget is relative∧absolute so a code regression
 * trips while same-session host load cancels.
 *
 * ONE-ARM (1 arm): Step-3 liveness seam proof only (kept for fast
 * bring-up debugging).
 *
 * GATING (scenario.gating): 'gate' scenarios assert the budget verdict;
 * 'print-only' scenarios run + log the verdict but assert ONLY liveness
 * (their regression power isn't yet proven — see scenarios.ts header).
 * Liveness preconditions are asserted distinctly from a metric
 * regression — "did not validly run" must never read as "healthy".
 */
import { test, expect, type Page } from '@playwright/test';
import { evaluateNetHealth, type NetHealthArm } from '../netgate/netHealthBudget';
import { resolveScenarios, type InteractionId, type NetgateScenario } from '../netgate/scenarios';

interface ArmSpec {
  name: string;
  url: string;
}

const TOKEN = process.env['NETGATE_TOKEN'] ?? '';
const ARMS: ArmSpec[] = JSON.parse(process.env['NETGATE_ARMS'] ?? '[]') as ArmSpec[];
const RUN_MS = Number(process.env['NETGATE_RUN_MS'] ?? 8000);
// Keyless base — the spec appends each scenario's room (multi-scenario):
//   `${RESET_BASE}${scenario.room}` → POST /dev/reset-sector?key=<room>
const RESET_BASE = process.env['NETGATE_RESET_BASE'] ?? '';
// The scenarios to run this invocation (default `core`). Unknown name ⇒
// loud throw at collection (a typo must fail, never silently skip).
const SCENARIOS_TO_RUN = resolveScenarios(process.env['NETGATE_SCENARIOS'] ?? 'core');

/** Per-scenario reps: NETGATE_REPS env (set by the driver / CI=8) OVERRIDES
 *  the descriptor default, so `core` keeps its calibrated 8-rep budget. */
function repsFor(scenario: NetgateScenario): number {
  return process.env['NETGATE_REPS'] ? Number(process.env['NETGATE_REPS']) : scenario.reps;
}

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

/** Fixed, deterministic input sequence — identical for every arm/rep.
 *  `strafe-fire` mirrors `feel-test-lockstep.spec.ts:138-151` (strafe the
 *  drone pack while firing). */
async function runInteraction(page: Page, interaction: InteractionId): Promise<void> {
  switch (interaction) {
    case 'strafe-fire':
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
      return;
  }
}

/** One arm visit: fresh context, per-origin JWT inject (the 5173-scoped
 *  storageState does NOT cover :5273/:5274), join the scenario's room
 *  through that arm's latency proxy, run the interaction, sample stats. */
async function visitArm(
  browser: import('@playwright/test').Browser,
  arm: ArmSpec,
  scenario: NetgateScenario,
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
    await page.goto(`${arm.url}/?room=${scenario.room}&diag=0${scenario.urlParams}`);
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
      },
      scenario.liveSelector,
      { timeout: 30_000 },
    );
    // Phase 0a, under REAL webdriver: fail fast if diag is on.
    const preDiag = await page.evaluate(
      () => (window as unknown as { __eqxDiagEnabled?: boolean }).__eqxDiagEnabled === true,
    );
    expect(preDiag, `[${arm.name}] __eqxDiagEnabled must be false (Phase 0a)`).toBe(false);

    // Streaming auto-capture mode symmetric assertion (plan: streaming
    // auto-capture, Phase 1, 2026-05-21). The streaming mode adds a
    // continuous network + main-thread cost (POST every N seconds with
    // ring entries) that could perturb the netcode metrics this gate
    // measures. Assert OFF so a future accidental `?autocapture=1` in
    // the gate URL fails LOUDLY here, not as a slow drift in the
    // budget medians.
    const preAutoCapture = await page.evaluate(
      () => (window as unknown as { __eqxAutoCaptureEnabled?: boolean }).__eqxAutoCaptureEnabled === true,
    );
    expect(
      preAutoCapture,
      `[${arm.name}] __eqxAutoCaptureEnabled must be false (streaming changes the program under measurement)`,
    ).toBe(false);

    // Ghost-at-origin probe symmetric assertion (laser "ghost at (0,0)"
    // investigation, 2026-06-03). `?probe=ghost` adds a per-origin-hit
    // logEvent inside updateLiveBeam; assert OFF so a future accidental
    // leak into the gate URL fails LOUDLY here rather than perturbing the
    // measured program. Webdriver does NOT auto-enable it (opt-in only).
    const preGhostProbe = await page.evaluate(
      () => (window as unknown as { __eqxGhostProbeEnabled?: boolean }).__eqxGhostProbeEnabled === true,
    );
    expect(
      preGhostProbe,
      `[${arm.name}] __eqxGhostProbeEnabled must be false (probe changes the program under measurement)`,
    ).toBe(false);

    await runInteraction(page, scenario.interaction);

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

async function resetSector(room: string): Promise<void> {
  if (!RESET_BASE) return;
  await fetch(`${RESET_BASE}${room}`, { method: 'POST' }).catch(() => undefined);
}

test.describe('netcode-health gate', () => {
  for (const scenario of SCENARIOS_TO_RUN) {
    test(`[${scenario.name}] baseline-vs-HEAD netcode health is within budget (or single-arm seam)`, async ({
      browser,
    }) => {
      test.skip(ARMS.length === 0, 'driven only by run-netgate.ts (NETGATE_ARMS unset)');

      const reps = repsFor(scenario);

      // ---- Single-arm: Step-3 liveness seam proof only ----
      if (ARMS.length === 1) {
        await resetSector(scenario.room);
        const s = await visitArm(browser, ARMS[0]!, scenario);
        console.log(`\n=== single-arm seam [${scenario.name}/${ARMS[0]!.name}] ===`);
        console.log(
          `  snapshotCount ${s.snapshotCount} | diag ${s.diagEnabled} | mirror_clone ${s.mirrorClones}`,
        );
        expect(s.diagEnabled, 'diag must stay OFF').toBe(false);
        expect(s.mirrorClones, 'heavy diagnostic path must be OFF').toBe(0);
        expect(s.snapshotCount, 'live loop must have run').toBeGreaterThan(40);
        return;
      }

      // ---- Two-arm: interleaved A/B/A/B…, median, budget ----
      const baseline = ARMS.find((a) => a.name === 'baseline') ?? ARMS[0]!;
      const head = ARMS.find((a) => a.name === 'HEAD') ?? ARMS[1]!;
      const samples: Record<string, RepSample[]> = { [baseline.name]: [], [head.name]: [] };

      for (let rep = 1; rep <= reps; rep++) {
        // Alternate the order each rep so neither arm is ALWAYS the cold
        // "first-after-reset" or warm "second" slot — that systematic
        // per-slot bias is what median-over-random-reps cannot cancel.
        // Balanced exactly for even reps.
        const order = rep % 2 === 1 ? [baseline, head] : [head, baseline];
        for (const arm of order) {
          await resetSector(scenario.room); // before every arm visit (incl. the very first)
          const s = await visitArm(browser, arm, scenario);
          samples[arm.name]!.push(s);
          console.log(
            `  [${scenario.name}] rep${rep} ${arm.name.padEnd(8)} corr=${s.rollingCorrRate.toFixed(3)} ` +
              `ahead=${s.ticksAhead} maxDrift=${s.maxDriftUnits.toFixed(2)} ` +
              `jit=${s.snapshotJitterMs.toFixed(1)} drop=${s.droppedSnapshotsRecent} ` +
              `snaps=${s.snapshotCount} rtt=${s.rttMeanMs.toFixed(0)} diag=${s.diagEnabled}`,
          );
        }
      }
      await resetSector(scenario.room); // leave no warm room for the next run

      const baseArm = toArm(samples[baseline.name]!);
      const headArm = toArm(samples[head.name]!);
      const verdict = evaluateNetHealth(headArm, baseArm, scenario.budgetOverride);

      console.log(
        `\n=== netcode-health verdict [${scenario.name}] (medians over ${reps} reps, gating=${scenario.gating}) ===`,
      );
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

      // Liveness is asserted for EVERY scenario (a scenario that didn't
      // validly run is broken, gated or not).
      expect(
        verdict.preconditionFailures,
        `[${scenario.name}] gate did not validly run: ${verdict.preconditionFailures.join('; ')}`,
      ).toEqual([]);

      if (scenario.gating === 'gate') {
        expect(
          verdict.pass,
          `[${scenario.name}] netcode-health regressed vs baseline: ${verdict.failures
            .map((f) => `${f.metric} ${f.head}↗${f.baseline}`)
            .join(', ')}`,
        ).toBe(true);
      } else {
        // print-only: regression power not yet proven — log, don't gate.
        console.log(
          `  [${scenario.name}] PRINT-ONLY — budget verdict NOT gating CI (pass=${verdict.pass}).`,
        );
      }
    });
  }
});

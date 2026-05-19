/**
 * Phase 1 / Mechanism 4 (plan: e2e-rebuild) — the netcode-health budget,
 * the single most flake-critical unit, written FIRST.
 *
 * This pure module decides whether HEAD's netcode health regressed vs a
 * same-session baseline. The anti-flake core is:
 *
 *   FAIL(metric) = relativeBreach(metric) AND absoluteBreach(metric)
 *
 * The relative test catches a code regression while host load cancels
 * (both arms ran in the same session — Mechanism 3); the absolute
 * "still-playable" ceiling stops a lucky/unlucky baseline from
 * false-failing. EPS is an additive floor so a near-zero baseline can't
 * make the multiplicative test infinitely sensitive. Improvements
 * (head ≤ baseline) can NEVER fail.
 *
 * Liveness preconditions are a DISTINCT result channel — "the gate did
 * not validly run" must never masquerade as "healthy" (a green budget on
 * a diag-ON run, or on a run that never joined, measures the wrong
 * program — that is exactly the class of false-confidence this whole
 * plan exists to kill).
 *
 * Thresholds are grounded in existing in-repo assertions / system caps
 * (re-verified this session):
 *   - rollingCorrRate clean < 0.2  (prediction-diagnostics.spec.ts:84)
 *   - maxDriftUnits   clean < 1.0u (prediction-diagnostics.spec.ts:76);
 *     ~12u realistic / >50u catastrophic divergence (:153-155)
 *   - ticksAhead cap = 30          (lookaheadController.ts:40 CEILING_TICKS)
 *   - snapshotJitterMs cadence     = 20 Hz / 50 ms
 *   - droppedSnapshotsRecent window = last 10 (PredictionStats:134)
 *
 * Level: pure threshold math with zero IO — a node unit test at exactly
 * that level is the faithful lock. RED today: the module does not exist.
 */
import { describe, expect, it } from 'vitest';
import {
  NET_HEALTH_BUDGET,
  evaluateNetHealth,
  type NetHealthArm,
} from './netHealthBudget';

/** A fully-healthy arm: every metric well under every ceiling, liveness ok. */
function ok(): NetHealthArm {
  return {
    rollingCorrRate: 0.1,
    ticksAhead: 8,
    maxDriftUnits: 0.5,
    meanDriftUnits: 0.1,
    snapshotJitterMs: 12,
    droppedSnapshotsRecent: 0,
    snapshotCount: 160,
    diagEnabled: false,
  };
}

describe('evaluateNetHealth — happy path', () => {
  it('identical arms ⇒ pass, no failures, no precondition failures', () => {
    const v = evaluateNetHealth(ok(), ok());
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
    expect(v.preconditionFailures).toEqual([]);
  });

  it('HEAD strictly better than baseline on every metric ⇒ pass (improvements never fail)', () => {
    const baseline = ok();
    const head: NetHealthArm = {
      ...ok(),
      rollingCorrRate: 0.02,
      ticksAhead: 4,
      maxDriftUnits: 0.1,
      meanDriftUnits: 0.02,
      snapshotJitterMs: 4,
      droppedSnapshotsRecent: 0,
    };
    const v = evaluateNetHealth(head, baseline);
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('pass ⇔ (no precondition failures AND no metric failures)', () => {
    const v1 = evaluateNetHealth(ok(), ok());
    expect(v1.pass).toBe(v1.preconditionFailures.length === 0 && v1.failures.length === 0);
    const bad: NetHealthArm = { ...ok(), rollingCorrRate: 0.95 };
    const v2 = evaluateNetHealth(bad, { ...ok(), rollingCorrRate: 0.45 });
    expect(v2.pass).toBe(v2.preconditionFailures.length === 0 && v2.failures.length === 0);
  });
});

describe('evaluateNetHealth — the relative∧absolute AND-gate, per metric', () => {
  // For each gated metric: a relative-only breach (under the ceiling)
  // must PASS (the AND-gate); a breach of BOTH must FAIL naming it.
  const metrics = Object.keys(NET_HEALTH_BUDGET) as Array<keyof typeof NET_HEALTH_BUDGET>;

  for (const m of metrics) {
    const { margin, eps, ceil } = NET_HEALTH_BUDGET[m];

    it(`${m}: relative breach but UNDER ceiling ⇒ PASS (host-load is not a regression)`, () => {
      // baseline low, head breaches relative threshold but stays < ceil.
      const baselineVal = ceil * 0.2;
      const headVal = baselineVal * (1 + margin) + eps + ceil * 0.05; // > relative threshold
      // Guard the fixture: it must actually breach relative yet stay under ceil.
      expect(headVal).toBeGreaterThan(baselineVal * (1 + margin) + eps);
      expect(headVal).toBeLessThan(ceil);

      const v = evaluateNetHealth({ ...ok(), [m]: headVal }, { ...ok(), [m]: baselineVal });
      expect(v.pass).toBe(true);
      expect(v.failures).toEqual([]);
    });

    it(`${m}: breaches BOTH relative AND absolute ⇒ FAIL naming ${m} with magnitudes`, () => {
      const baselineVal = ceil * 0.9;
      const headVal = ceil * 3 + eps + 1; // unambiguously past relative + ceil
      expect(headVal).toBeGreaterThan(baselineVal * (1 + margin) + eps);
      expect(headVal).toBeGreaterThan(ceil);

      const v = evaluateNetHealth({ ...ok(), [m]: headVal }, { ...ok(), [m]: baselineVal });
      expect(v.pass).toBe(false);
      const f = v.failures.find((x) => x.metric === m);
      expect(f, `expected a failure for ${m}`).toBeDefined();
      expect(f!.head).toBe(headVal);
      expect(f!.baseline).toBe(baselineVal);
    });
  }

  it('multiple metrics breaching both ⇒ all listed; pass=false', () => {
    const baseline = ok();
    const head: NetHealthArm = {
      ...ok(),
      rollingCorrRate: 0.99,
      ticksAhead: 80,
      maxDriftUnits: 60,
    };
    const v = evaluateNetHealth(head, baseline);
    expect(v.pass).toBe(false);
    const names = v.failures.map((f) => f.metric).sort();
    expect(names).toEqual(['maxDriftUnits', 'rollingCorrRate', 'ticksAhead']);
  });
});

describe('evaluateNetHealth — EPS floor (near-zero baseline cannot make the ratio infinitely sensitive)', () => {
  it('rollingCorrRate baseline 0.00, head 0.04 ⇒ PASS (EPS=0.05 absorbs the tiny absolute rise)', () => {
    const v = evaluateNetHealth({ ...ok(), rollingCorrRate: 0.04 }, { ...ok(), rollingCorrRate: 0.0 });
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('droppedSnapshotsRecent baseline 0, head 3 ⇒ PASS (under ceil 4) but head 5 ⇒ FAIL', () => {
    expect(evaluateNetHealth({ ...ok(), droppedSnapshotsRecent: 3 }, ok()).pass).toBe(true);
    const v = evaluateNetHealth({ ...ok(), droppedSnapshotsRecent: 5 }, ok());
    expect(v.pass).toBe(false);
    expect(v.failures.map((f) => f.metric)).toContain('droppedSnapshotsRecent');
  });

  it('exact threshold equality is NOT a breach (strict >, boundary safety)', () => {
    const { margin, eps } = NET_HEALTH_BUDGET.snapshotJitterMs;
    const baselineVal = 20;
    const headVal = baselineVal * (1 + margin) + eps; // exactly the threshold
    const v = evaluateNetHealth({ ...ok(), snapshotJitterMs: headVal }, { ...ok(), snapshotJitterMs: baselineVal });
    expect(v.pass).toBe(true);
  });
});

describe('evaluateNetHealth — liveness preconditions are a DISTINCT channel (never masked as healthy)', () => {
  it('low snapshotCount ⇒ pass=false via preconditionFailures, NOT metric failures', () => {
    const v = evaluateNetHealth({ ...ok(), snapshotCount: 20 }, ok());
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures.length).toBeGreaterThan(0);
    expect(v.preconditionFailures.join(' ')).toMatch(/snapshotCount/i);
    expect(v.failures).toEqual([]); // a stalled run is not a "metric regression"
  });

  it('diagEnabled=true on either arm ⇒ pass=false via precondition (measured the wrong program)', () => {
    const vHead = evaluateNetHealth({ ...ok(), diagEnabled: true }, ok());
    expect(vHead.pass).toBe(false);
    expect(vHead.preconditionFailures.join(' ')).toMatch(/diag/i);

    const vBase = evaluateNetHealth(ok(), { ...ok(), diagEnabled: true });
    expect(vBase.pass).toBe(false);
    expect(vBase.preconditionFailures.join(' ')).toMatch(/diag/i);
  });

  it('a precondition failure short-circuits — healthy metrics do not flip it to pass', () => {
    const v = evaluateNetHealth({ ...ok(), snapshotCount: 0, diagEnabled: true }, ok());
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures.length).toBeGreaterThanOrEqual(2);
  });
});

describe('NET_HEALTH_BUDGET — the gated set is exactly the six grounded metrics', () => {
  it('locks the gated metric set (adding/removing one is a deliberate, reviewed change)', () => {
    expect(Object.keys(NET_HEALTH_BUDGET).sort()).toEqual(
      [
        'droppedSnapshotsRecent',
        'maxDriftUnits',
        'meanDriftUnits',
        'rollingCorrRate',
        'snapshotJitterMs',
        'ticksAhead',
      ].sort(),
    );
  });

  it('ticksAhead ceiling is the system saturation cap 30 (lookaheadController CEILING_TICKS)', () => {
    expect(NET_HEALTH_BUDGET.ticksAhead.ceil).toBe(30);
  });
});

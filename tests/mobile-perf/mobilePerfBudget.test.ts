/**
 * Lock the mobile-perf budget's verdict + precondition logic against
 * the same exhaustive cases the netgate's `netHealthBudget.test.ts`
 * covers. Pure unit tests — no Playwright, no IO.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateMobilePerf,
  evaluateMobilePerfAbsolute,
  MIN_SNAPSHOTS,
  MOBILE_PERF_BUDGET,
  type MobilePerfArm,
} from './mobilePerfBudget.js';

function makeArm(over: Partial<MobilePerfArm> = {}): MobilePerfArm {
  return {
    jsHeapUsedMb: 80,
    jsHeapGrowthMb: 0,
    documentCount: 2,
    jsEventListeners: 200,
    longtaskCount30s: 0,
    rafP50Ms: 12,
    rafP99Ms: 20,
    rafGapCount30s: 0,
    diagEnabled: false,
    snapshotCount: 100,
    ranKind: 'desktop-throttled',
    measuredMs: 30_000,
    ...over,
  };
}

describe('evaluateMobilePerf (two-arm)', () => {
  it('identical arms pass', () => {
    const arm = makeArm();
    const v = evaluateMobilePerf(arm, arm);
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
    expect(v.preconditionFailures).toEqual([]);
  });

  it('improvement (head better than baseline) always passes', () => {
    const head = makeArm({ jsHeapUsedMb: 50, jsHeapGrowthMb: 0 });
    const baseline = makeArm({ jsHeapUsedMb: 120, jsHeapGrowthMb: 5 });
    const v = evaluateMobilePerf(head, baseline);
    expect(v.pass).toBe(true);
  });

  it('relative-only breach (head doubles but still under ceil) passes — anti-flake AND', () => {
    // jsHeapGrowthMb: baseline=4, head=10. Relative: 10 > 4*1.5+2=8 (true).
    // Absolute: 10 > 25 (false). AND = false. Pass.
    const head = makeArm({ jsHeapGrowthMb: 10 });
    const baseline = makeArm({ jsHeapGrowthMb: 4 });
    const v = evaluateMobilePerf(head, baseline);
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('absolute-only breach (both above ceil but ratio fine) passes — anti-flake AND', () => {
    // jsHeapGrowthMb: head=30, baseline=29. Relative: 30 > 29*1.5+2 = 45.5 (false).
    // Absolute: 30 > 25 (true). AND = false. Pass.
    const head = makeArm({ jsHeapGrowthMb: 30 });
    const baseline = makeArm({ jsHeapGrowthMb: 29 });
    const v = evaluateMobilePerf(head, baseline);
    expect(v.pass).toBe(true);
  });

  it('both relative + absolute breach fails with kind=relative+absolute', () => {
    // jsHeapGrowthMb: head=40, baseline=4.
    // Relative: 40 > 4*1.5+2 = 8 (true).
    // Absolute: 40 > 25 (true). AND = true. Fail.
    const head = makeArm({ jsHeapGrowthMb: 40 });
    const baseline = makeArm({ jsHeapGrowthMb: 4 });
    const v = evaluateMobilePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0].metric).toBe('jsHeapGrowthMb');
    expect(v.failures[0].kind).toBe('relative+absolute');
    expect(v.failures[0].head).toBe(40);
    expect(v.failures[0].baseline).toBe(4);
    expect(v.failures[0].ratio).toBe(10);
  });

  it('eps additive floor: near-zero baseline cannot make the ratio test infinitely sensitive', () => {
    // documentCount: baseline=0, head=1.
    // Relative: 1 > 0*1.1+1 = 1 (false — strict >). NOT a relative breach.
    // (The eps floor of 1 absorbs the +1 delta over a zero baseline.)
    const head = makeArm({ documentCount: 1 });
    const baseline = makeArm({ documentCount: 0 });
    const v = evaluateMobilePerf(head, baseline);
    expect(v.pass).toBe(true);
  });

  it('precondition: head.diagEnabled=true is reported on the precondition channel', () => {
    const head = makeArm({ diagEnabled: true });
    const baseline = makeArm();
    const v = evaluateMobilePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.failures).toEqual([]);
    expect(v.preconditionFailures.some((m) => m.includes('HEAD') && m.includes('diag'))).toBe(true);
  });

  it('precondition: baseline.diagEnabled=true is reported distinctly', () => {
    const head = makeArm();
    const baseline = makeArm({ diagEnabled: true });
    const v = evaluateMobilePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures.some((m) => m.includes('baseline') && m.includes('diag'))).toBe(true);
  });

  it('precondition: snapshotCount <= MIN_SNAPSHOTS fails liveness', () => {
    const head = makeArm({ snapshotCount: MIN_SNAPSHOTS });
    const baseline = makeArm();
    const v = evaluateMobilePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(
      v.preconditionFailures.some((m) => m.includes('HEAD') && m.includes('snapshotCount')),
    ).toBe(true);
  });

  it('multiple metric failures aggregate in a single verdict', () => {
    const head = makeArm({
      jsHeapGrowthMb: 40, // both branches breach
      documentCount: 8, // 8 > 4 ceil AND 8 > 2*1.1+1=3.2
    });
    const baseline = makeArm({ jsHeapGrowthMb: 4, documentCount: 2 });
    const v = evaluateMobilePerf(head, baseline);
    expect(v.pass).toBe(false);
    expect(v.failures.map((f) => f.metric).sort()).toEqual(['documentCount', 'jsHeapGrowthMb']);
  });

  it('PRINT-ONLY metrics (rafP99Ms, rafP50Ms, rafGapCount30s) are NEVER in failures', () => {
    const head = makeArm({ rafP99Ms: 9999, rafP50Ms: 9999, rafGapCount30s: 9999 });
    const baseline = makeArm({ rafP99Ms: 1, rafP50Ms: 1, rafGapCount30s: 0 });
    const v = evaluateMobilePerf(head, baseline);
    expect(v.pass).toBe(true);
    expect(v.failures.find((f) => f.metric.startsWith('raf'))).toBeUndefined();
  });
});

describe('evaluateMobilePerfAbsolute (single-arm v1)', () => {
  it('arm well under all ceilings passes', () => {
    const v = evaluateMobilePerfAbsolute(makeArm());
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('absolute breach fails with kind=absolute', () => {
    const v = evaluateMobilePerfAbsolute(makeArm({ jsHeapGrowthMb: 40 }));
    expect(v.pass).toBe(false);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0].metric).toBe('jsHeapGrowthMb');
    expect(v.failures[0].kind).toBe('absolute');
    expect(v.failures[0].head).toBe(40);
    expect(v.failures[0].ceil).toBe(MOBILE_PERF_BUDGET.jsHeapGrowthMb.ceil);
  });

  it('multiple absolute breaches aggregate', () => {
    const v = evaluateMobilePerfAbsolute(
      makeArm({
        jsHeapUsedMb: 300, // > 220
        jsHeapGrowthMb: 50, // > 25
        documentCount: 10, // > 4
      }),
    );
    expect(v.pass).toBe(false);
    expect(v.failures.map((f) => f.metric).sort()).toEqual([
      'documentCount',
      'jsHeapGrowthMb',
      'jsHeapUsedMb',
    ]);
    expect(v.failures.every((f) => f.kind === 'absolute')).toBe(true);
  });

  it('precondition diagEnabled=true short-circuits with no metric failures', () => {
    const v = evaluateMobilePerfAbsolute(makeArm({ diagEnabled: true, jsHeapGrowthMb: 999 }));
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures).toHaveLength(1);
    expect(v.failures).toEqual([]);
  });

  it('precondition snapshotCount too low short-circuits', () => {
    const v = evaluateMobilePerfAbsolute(makeArm({ snapshotCount: 10 }));
    expect(v.pass).toBe(false);
    expect(v.preconditionFailures).toHaveLength(1);
  });

  it('PRINT-ONLY raf* values never trip the absolute gate', () => {
    const v = evaluateMobilePerfAbsolute(
      makeArm({ rafP99Ms: 9999, rafP50Ms: 9999, rafGapCount30s: 9999 }),
    );
    expect(v.pass).toBe(true);
  });
});

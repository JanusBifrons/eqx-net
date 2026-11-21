/**
 * Lead-sizing parity: the scenario runner sizes the input lead exactly as
 * the client does. Each snapshot's margin is measured here the way the
 * server measures it (`inputLeadMargin`: the claim of the input it holds
 * minus its tick, the claim read from the runner's own observed
 * `inputTick`) and fed through a fresh copy of the client's
 * `updateRttAndLookahead`. Any lead formula the runner keeps of its own —
 * the old `lastRtt − lead × 16.67` one, a stale clamp, a missed gap filter —
 * makes the two leads part.
 */
import { describe, it, expect } from 'vitest';
import { runScenario } from './runner';
import { buildScenarioEvents, type Scenario } from './scenarios';
import type { Event, Observation } from './types';
import { inputLeadMargin } from '../../src/core/physics/inputQueue';
import { updateRttAndLookahead } from '../../src/client/net/rttLookaheadUpdater';
import { createLookaheadController } from '../../src/client/net/lookaheadController';
import { createWelford } from '../../src/core/math/Welford';
import type { PredictionStats } from '../../src/client/net/predictionStats';
import type { Reconciler } from '../../src/core/prediction/Reconciler';

const INITIAL_LEAD = 5;

/** The client's lead after each snapshot, fed the margins the runner's own
 *  claims produce. */
function clientLeads(events: Event[], observations: Observation[]): number[] {
  const ctx = {
    reconciler: {} as Reconciler,
    stats: { rttMeanMs: 0, rttStdDevMs: 0 } as PredictionStats,
    rttWelford: createWelford(),
    lookaheadCtrl: createLookaheadController(INITIAL_LEAD),
    leadTicks: INITIAL_LEAD,
    lastFrameMs: 16.67,
    inputMargin: undefined as number | undefined,
    timeScale: 1,
  };
  const leads: number[] = [];
  let lastSnapAt = -1;
  let firstSnap = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.type === 'rafTick') {
      ctx.lastFrameMs = ev.dtMs;
      continue;
    }
    // Claim of the input sent at `inputSentAtMs`: the client's inputTick
    // after the last event at or before then (none before the loop starts).
    let claimed: number | undefined;
    if (firstSnap >= 0 && ev.inputSentAtMs !== undefined) {
      for (let j = i - 1; j >= firstSnap; j--) {
        if (observations[j]!.atMs <= ev.inputSentAtMs) { claimed = observations[j]!.inputTick; break; }
      }
    }
    ctx.inputMargin = claimed === undefined ? undefined : inputLeadMargin(claimed, ev.serverTick);
    ctx.leadTicks = updateRttAndLookahead(lastSnapAt >= 0 ? ev.atMs - lastSnapAt : -1, ctx);
    lastSnapAt = ev.atMs;
    if (firstSnap < 0) firstSnap = i;
    leads.push(ctx.leadTicks);
  }
  return leads;
}

function parity(scenario: Scenario): { runner: number[]; client: number[] } {
  const events = buildScenarioEvents(scenario);
  const observations = runScenario(events);
  const runner = observations.filter((o) => o.event === 'snapshot').map((o) => o.leadTicks);
  return { runner, client: clientLeads(events, observations) };
}

describe('scenario runner ↔ client lead sizing', () => {
  it('a 100 ms link: runner lead equals the client updater fed server-measured margins', () => {
    const { runner, client } = parity({ name: 'phone-tunnel', rafTickHz: 90, rttMs: 100, durationMs: 6_000 });
    expect(runner).toEqual(client);
    // Non-trivial: the margin path sees the link, so the lead leaves its
    // start and sits above the 3-tick floor.
    expect(Math.max(...runner)).toBeGreaterThan(INITIAL_LEAD);
    expect(runner[runner.length - 1]).toBeGreaterThan(3);
  });

  it('slow rafTick + repeated gaps: leads still agree snapshot for snapshot', () => {
    const { runner, client } = parity({
      name: 'mobile-pattern-a',
      rafTickHz: 30,
      rttMs: 83,
      gapsMs: [{ atMs: 1500, durationMs: 800 }, { atMs: 3500, durationMs: 800 }],
      durationMs: 6_000,
    });
    expect(runner).toEqual(client);
  });
});

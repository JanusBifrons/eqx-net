/**
 * Campaign PR 1.3 (anti-patterns review 2026-07, C-server 3) — failing-first
 * lock for the SAMPLED malformed-packet warn.
 *
 * The Validation Contract (server CLAUDE.md / invariant #3) requires
 * "per-connection error counter, sampled pino.warn". Every handler docstring
 * claimed it; no sampler existed — the `input` channel (up to 3 accepted
 * messages/tick = 180/s) warned once PER malformed packet, a
 * log-amplification DoS.
 *
 * RED on pre-fix code: 100 malformed inputs produce 100 warns. GREEN after:
 * the tracker warns on the 1st + every 25th (100 → 5 warns), the count is
 * queryable, and well-formed inputs never touch it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from 'colyseus';
import type pino from 'pino';
import { makeInputHandler, type InputHandlerCtx } from './InputHandler.js';
import { MalformedMessageTracker } from './MalformedMessageTracker.js';

function makeCtx(warnSpy: ReturnType<typeof vi.fn>): InputHandlerCtx {
  const logger = { warn: warnSpy } as unknown as pino.Logger;
  return {
    sessionToPlayer: new Map([['sess-1', 'player-1']]),
    inputCountThisTick: new Map(),
    maxInputsPerTick: Number.POSITIVE_INFINITY,
    playerToSlot: new Map([['player-1', 0]]),
    boostingPlayers: new Set(),
    thrustingPlayers: new Set(),
    postToWorker: () => {},
    serverTick: () => 100,
    shipEnergyOf: () => 100,
    logger,
    malformed: new MalformedMessageTracker({ warn: warnSpy }),
  };
}

const client = { sessionId: 'sess-1' } as unknown as Client;

describe('input handler — malformed packets are counted + SAMPLED, not warned per-packet (campaign 1.3)', () => {
  let warnSpy: ReturnType<typeof vi.fn>;
  let handler: (client: Client, raw: unknown) => void;
  let ctx: InputHandlerCtx;

  beforeEach(() => {
    warnSpy = vi.fn();
    ctx = makeCtx(warnSpy);
    handler = makeInputHandler(ctx);
  });

  it('100 malformed inputs warn far fewer than 100 times (1st + every 25th = 5)', () => {
    for (let i = 0; i < 100; i++) handler(client, { garbage: true });
    expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(5);
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('the per-connection counter tracks the full flood', () => {
    for (let i = 0; i < 100; i++) handler(client, { garbage: true });
    expect(ctx.malformed.countFor('sess-1')).toBe(100);
  });

  it('the sampled warn carries the running total', () => {
    for (let i = 0; i < 50; i++) handler(client, 'not-an-object');
    const lastFields = warnSpy.mock.calls.at(-1)![0] as { malformedCount: number };
    expect(lastFields.malformedCount).toBe(50);
  });

  it('well-formed inputs never warn and never count', () => {
    handler(client, { type: 'input', tick: 101, thrust: true, turnLeft: false, turnRight: false });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(ctx.malformed.countFor('sess-1')).toBe(0);
  });
});

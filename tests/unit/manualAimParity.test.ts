/**
 * Manual aim — the wire encoding (`encodeAim` / `decodeAim`, also used by fire
 * control's `lock_track.b`), the input schema's `aim` field and the server's
 * handling of it. The CLIENT no longer aims manually or sends `aim` (fire
 * control is universal: every weapon group aims + fires at its lock, and
 * `fcTickMountAngles` is the client mount-angle path), so the client-side
 * slew-parity, aimSteer and client-source checks were removed. Fails when:
 *  - the wire encoding stops round-tripping,
 *  - the input schema stops accepting (or starts accepting bad) aim values,
 *  - the server handler stops forwarding / clearing the held aim,
 *  - the server handler stops decoding with the shared helper.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Client } from 'colyseus';
import type pino from 'pino';
import {
  AIM_STEPS, encodeAim, decodeAim, allMountsFixed,
  stickToWorldBearing, vectorToWorldBearing,
} from '../../src/core/combat/manualAim.js';
import { wrapPi } from '../../src/core/ai/WeaponMountController.js';
import { InputMessageSchema } from '../../src/shared-types/messages.js';
import { makeInputHandler } from '../../src/server/rooms/InputHandler.js';
import { MalformedMessageTracker } from '../../src/server/rooms/MalformedMessageTracker.js';
import type { WeaponMount } from '../../src/shared-types/shipKinds.js';

const TURRET = {
  id: 'm0', localX: 6, localY: 4, baseAngle: 0.3, arcMin: -0.8, arcMax: 0.8, rotationSpeed: 3, weaponId: 'hitscan',
} as unknown as WeaponMount;
const FIXED = { ...TURRET, id: 'm1', arcMin: 0, arcMax: 0, rotationSpeed: 0 } as unknown as WeaponMount;

describe('manual aim wire encoding', () => {
  it('round-trips within one quantisation step', () => {
    const step = (2 * Math.PI) / AIM_STEPS;
    for (const b of [0, 0.5, -0.5, Math.PI - 1e-6, -Math.PI + 1e-6, 3, -3, 7.1, -9.4]) {
      const q = encodeAim(b);
      expect(Number.isInteger(q)).toBe(true);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThan(AIM_STEPS);
      expect(Math.abs(wrapPi(decodeAim(q) - b))).toBeLessThanOrEqual(step / 2 + 1e-9);
    }
  });

  it('screen stick + world vector use the ship-angle convention', () => {
    // Stick UP (y down negative) = bearing 0 = game +y.
    expect(stickToWorldBearing(0, -1)).toBeCloseTo(0);
    expect(vectorToWorldBearing(0, 1)).toBeCloseTo(0);
    // Stick RIGHT = -π/2 (same as joystickToInput's mapping).
    expect(stickToWorldBearing(1, 0)).toBeCloseTo(-Math.PI / 2);
    expect(vectorToWorldBearing(1, 0)).toBeCloseTo(-Math.PI / 2);
  });

  it('allMountsFixed tells fixed-gun hulls apart', () => {
    expect(allMountsFixed([FIXED])).toBe(true);
    expect(allMountsFixed([FIXED, TURRET])).toBe(false);
    expect(allMountsFixed([])).toBe(true);
  });
});

describe('input schema', () => {
  const base = { type: 'input', tick: 1, thrust: false, turnLeft: false, turnRight: false };
  it('accepts an integer aim in range and its absence', () => {
    expect(InputMessageSchema.safeParse({ ...base, aim: 0 }).success).toBe(true);
    expect(InputMessageSchema.safeParse({ ...base, aim: AIM_STEPS - 1 }).success).toBe(true);
    expect(InputMessageSchema.safeParse(base).success).toBe(true);
  });
  it('rejects out-of-range, fractional and null aims', () => {
    expect(InputMessageSchema.safeParse({ ...base, aim: AIM_STEPS }).success).toBe(false);
    expect(InputMessageSchema.safeParse({ ...base, aim: -1 }).success).toBe(false);
    expect(InputMessageSchema.safeParse({ ...base, aim: 1.5 }).success).toBe(false);
    expect(InputMessageSchema.safeParse({ ...base, aim: null }).success).toBe(false);
  });
});

describe('server input handler', () => {
  it('stores the held aim, clears it when absent, and drops it while disabled', () => {
    const aims: Array<number | null> = [];
    let disabled = false;
    const handler = makeInputHandler({
      sessionToPlayer: new Map([['s', 'p']]),
      inputCountThisTick: new Map(),
      maxInputsPerTick: Number.POSITIVE_INFINITY,
      playerToSlot: new Map([['p', 0]]),
      boostingPlayers: new Set(),
      thrustingPlayers: new Set(),
      postToWorker: () => {},
      serverTick: () => 1,
      shipEnergyOf: () => 1000,
      isDisabled: () => disabled,
      setPlayerAim: (_id, aim) => aims.push(aim),
      logger: { warn: () => {} } as unknown as pino.Logger,
      malformed: new MalformedMessageTracker({ warn: () => {} }),
    });
    const client = { sessionId: 's' } as unknown as Client;
    const msg = { type: 'input', tick: 1, thrust: false, turnLeft: false, turnRight: false };
    handler(client, { ...msg, aim: encodeAim(1) });
    handler(client, { ...msg, tick: 2 });
    disabled = true;
    handler(client, { ...msg, tick: 3, aim: encodeAim(1) });
    expect(aims[0]).toBeCloseTo(1, 2);
    expect(aims[1]).toBeNull();
    expect(aims[2]).toBeNull();
  });
});

describe('server input handler source', () => {
  it('decodes with the shared helper (no private copy)', () => {
    const handler = readFileSync(new URL('../../src/server/rooms/InputHandler.ts', import.meta.url), 'utf8');
    expect(handler).toContain('decodeAim(');
  });
});

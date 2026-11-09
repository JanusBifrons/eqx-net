/**
 * Manual aim (exp/hud-mobile-first) — one rule on both sides of the wire
 * (invariant #15). The pilot's held aim reaches the server as a quantised
 * world bearing; the client's predicted turret slew and the server's
 * authoritative one both turn it into a mount bearing via the shared
 * `manualAimMountBearing`. This test fails when:
 *  - the wire encoding stops round-tripping,
 *  - the input schema stops accepting (or starts accepting bad) aim values,
 *  - the server handler stops forwarding / clearing the held aim,
 *  - the client and server mount slews disagree for the same aim,
 *  - either side's source stops calling the shared helper.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Client } from 'colyseus';
import type pino from 'pino';
import {
  AIM_STEPS, encodeAim, decodeAim, manualAimMountBearing, allMountsFixed,
  stickToWorldBearing, vectorToWorldBearing,
} from '../../src/core/combat/manualAim.js';
import { rotateMountToward, wrapPi } from '../../src/core/ai/WeaponMountController.js';
import { InputMessageSchema } from '../../src/shared-types/messages.js';
import { makeInputHandler } from '../../src/server/rooms/InputHandler.js';
import { MalformedMessageTracker } from '../../src/server/rooms/MalformedMessageTracker.js';
import { tickLocalMountAngles } from '../../src/client/combat/localMountAim.js';
import type { WeaponMount } from '../../src/shared-types/shipKinds.js';
import { resolveAimSteer, makeAimSteerState } from '../../src/client/input/aimSteer.js';

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

describe('client and server slew the same way (#15)', () => {
  it('local prediction matches the server rule for the same aim', () => {
    const shipAngle = 0.4;
    const aim = decodeAim(encodeAim(-0.9));
    const client = [0.1, 0];
    tickLocalMountAngles(client, [TURRET, FIXED], new Set(['m0', 'm1']), null, 0, 0, shipAngle, 1 / 60, aim);
    // The server branch in WeaponMountTicker.tickPlayer, verbatim:
    const server = [0.1, 0].map((a, i) => {
      const m = [TURRET, FIXED][i]!;
      return rotateMountToward(a, manualAimMountBearing(aim, shipAngle, m.baseAngle), m, 1 / 60);
    });
    expect(client[0]).toBeCloseTo(server[0]!, 10);
    expect(client[1]).toBeCloseTo(server[1]!, 10);
  });

  it('a turret clamps to its arc and the auto target is ignored while aiming', () => {
    const out = [0, 0];
    // Aim straight behind: far outside ±0.8, so it must clamp at an arc edge.
    for (let i = 0; i < 120; i++) {
      tickLocalMountAngles(out, [TURRET, FIXED], new Set(['m0', 'm1']), { x: 1000, y: 0 }, 0, 0, 0, 1 / 60, Math.PI - 0.01);
    }
    expect(Math.abs(out[0]!)).toBeCloseTo(0.8, 5);
    expect(out[1]).toBe(0); // fixed mount never moves
  });

  it('both sides call the shared helper (no private copy)', () => {
    const server = readFileSync(new URL('../../src/server/rooms/WeaponMountTicker.ts', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../../src/client/combat/localMountAim.ts', import.meta.url), 'utf8');
    const handler = readFileSync(new URL('../../src/server/rooms/InputHandler.ts', import.meta.url), 'utf8');
    const net = readFileSync(new URL('../../src/client/net/ColyseusClient.ts', import.meta.url), 'utf8');
    expect(server).toContain('manualAimMountBearing(');
    expect(client).toContain('manualAimMountBearing(');
    expect(handler).toContain('decodeAim(');
    // The per-tick path and the sentinel path both encode.
    expect(net.split('encodeAim(').length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe('fixed-gun hull steer (aimSteer)', () => {
  it('turns toward the aim with hysteresis and thrusts only on a pushed stick', () => {
    const s = makeAimSteerState();
    resolveAimSteer(1, 0, 0, s);
    expect(s.turnLeft).toBe(true);
    expect(s.thrust).toBe(false);
    // Inside TURN_ON but outside TURN_OFF: keeps turning (hysteresis).
    resolveAimSteer(0.07, 0, 0.5, s);
    expect(s.turnLeft).toBe(true);
    expect(s.thrust).toBe(true);
    // Below TURN_OFF: stops.
    resolveAimSteer(0.02, 0, 0.35, s);
    expect(s.turnLeft || s.turnRight).toBe(false);
    expect(s.thrust).toBe(true); // 0.35 > OFF 0.30 keeps thrust
    resolveAimSteer(-1, 0, 0.1, s);
    expect(s.turnRight).toBe(true);
    expect(s.thrust).toBe(false);
  });
});

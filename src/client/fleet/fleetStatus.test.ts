import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyFleetStatus,
  getFleetStatus,
  getFleetStatusVersion,
  resetFleetStatus,
  type FleetStatusUpdate,
} from './fleetStatus.js';
import { describeActivity, describeShieldHull, fleetShipName, fleetTargetName, sharedValue } from './fleetView.js';
import type { RenderMirror } from '@core/contracts/IRenderer';

const row = (id: string, over: Partial<FleetStatusUpdate> = {}): FleetStatusUpdate => ({
  id,
  mode: 'defend',
  stance: 'defensive',
  activity: 'guarding',
  targetId: null,
  ...over,
});

describe('fleetStatus singleton', () => {
  beforeEach(() => resetFleetStatus());

  it('stores rows by id and bumps the version on change', () => {
    const v0 = getFleetStatusVersion();
    applyFleetStatus([row('a'), row('b', { mode: 'hunt', squadId: 'sq1' })]);
    expect(getFleetStatusVersion()).toBe(v0 + 1);
    expect(getFleetStatus('a')?.mode).toBe('defend');
    expect(getFleetStatus('b')?.squadId).toBe('sq1');
    expect(getFleetStatus('nope')).toBeUndefined();
  });

  it('an identical row does not bump the version', () => {
    applyFleetStatus([row('a')]);
    const v = getFleetStatusVersion();
    applyFleetStatus([row('a')]);
    expect(getFleetStatusVersion()).toBe(v);
    applyFleetStatus([row('a', { shieldPct: 50 })]);
    expect(getFleetStatusVersion()).toBe(v + 1);
    expect(getFleetStatus('a')?.shieldPct).toBe(50);
  });

  it('replace drops rows missing from the update; upsert keeps them', () => {
    applyFleetStatus([row('a'), row('b')]);
    applyFleetStatus([row('c')]);
    expect(getFleetStatus('a')).toBeDefined();
    applyFleetStatus([row('c')], { replace: true });
    expect(getFleetStatus('a')).toBeUndefined();
    expect(getFleetStatus('b')).toBeUndefined();
    expect(getFleetStatus('c')).toBeDefined();
  });

  it('holds no spatial fields', () => {
    applyFleetStatus([row('a', { orderKind: 'move' })]);
    const r = getFleetStatus('a')!;
    for (const k of ['x', 'y', 'vx', 'vy', 'angle']) expect(k in r).toBe(false);
  });
});

describe('describeActivity', () => {
  it('reads in plain language', () => {
    expect(describeActivity(row('a', { activity: 'guarding' }))).toBe('Guarding');
    expect(describeActivity(row('a', { activity: 'moving' }))).toBe('Moving');
    expect(describeActivity(row('a', { activity: 'blocked' }))).toBe("Can't get closer");
    expect(describeActivity(row('a', { activity: 'chasing' }), 'Drone')).toBe('Chasing Drone');
    expect(describeActivity(row('a', { activity: 'chasing' }))).toBe('Chasing');
    expect(describeActivity(row('a', { activity: 'attacking' }), 'Fighter')).toBe('Attacking Fighter');
    expect(describeActivity(row('a', { activity: 'retreating' }), undefined, 19.6)).toBe('Retreating – hull 20%');
    expect(describeActivity(row('a', { activity: 'formingUp' }))).toBe('Forming up');
    expect(describeActivity(row('a', { activity: 'patrolling' }))).toBe('Patrolling');
    expect(describeActivity(row('a', { activity: 'idle' }))).toBe('Idle');
    expect(describeActivity(undefined)).toBe('No report yet');
  });

  it('says why a ship is pulling out, in plain words', () => {
    // Hull lost (hull from the mirror ship entry, RTS Part A).
    expect(describeActivity(row('a', { activity: 'retreating' }), undefined, 45)).toBe('Retreating – hull 45%');
    // Hull whole but the shield is gone.
    expect(describeActivity(row('a', { activity: 'retreating', shieldPct: 0 }), undefined, 100)).toBe('Retreating – shields down');
    // Ordered to retreat, or hull not known yet: no reason to give.
    expect(describeActivity(row('a', { activity: 'retreating', mode: 'retreat' }), undefined, 100)).toBe('Retreating');
    expect(describeActivity(row('a', { activity: 'retreating' }))).toBe('Retreating');
  });

  it('shield and hull read together', () => {
    expect(describeShieldHull(40, 100)).toBe('Shield 40% · Hull 100%');
    expect(describeShieldHull(null, 80)).toBe('Hull 80%');
    expect(describeShieldHull(null, null)).toBe('Hull --');
  });
});

describe('sharedValue', () => {
  it('shared, mixed, unknown', () => {
    expect(sharedValue(['hunt', 'hunt', undefined])).toBe('hunt');
    expect(sharedValue(['hunt', 'defend'])).toBe('mixed');
    expect(sharedValue([undefined, undefined])).toBeNull();
    expect(sharedValue([])).toBeNull();
  });
});

describe('fleet names (no ids shown)', () => {
  const mirror = {
    ships: new Map([
      ['p1', { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'fighter' }],
      ['h1', { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'scout', ownerPlayerId: 'p1', isActive: false }],
    ]),
    swarm: new Map([
      [7, { kind: 1, shipKind: undefined }],
      [8, { kind: 2 }],
      [9, { kind: 0 }],
    ]),
  } as unknown as RenderMirror;

  it('own ships by kind', () => {
    expect(fleetShipName(mirror, 'p1')).toBe('Fighter');
    expect(fleetShipName(mirror, 'h1')).toBe('Scout');
    expect(fleetShipName(mirror, 'gone')).toBe('Ship');
    expect(fleetShipName(null, 'p1')).toBe('Ship');
  });

  it('targets by kind', () => {
    expect(fleetTargetName(mirror, '7')).toBe('Drone');
    expect(fleetTargetName(mirror, 'swarm-8')).toBe('Structure');
    expect(fleetTargetName(mirror, '9')).toBe('Asteroid');
    expect(fleetTargetName(mirror, 'p1')).toBe('Fighter');
    expect(fleetTargetName(mirror, 'gone')).toBeUndefined();
    expect(fleetTargetName(mirror, null)).toBeUndefined();
  });
});

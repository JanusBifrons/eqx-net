import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyFleetStatus,
  getFleetStatus,
  getFleetStatusVersion,
  resetFleetStatus,
  type FleetStatusUpdate,
} from './fleetStatus.js';
import { describeActivity, fleetShipName, fleetTargetName, sharedValue } from './fleetView.js';
import type { RenderMirror } from '@core/contracts/IRenderer';

const row = (id: string, over: Partial<FleetStatusUpdate> = {}): FleetStatusUpdate => ({
  id,
  mode: 'defend',
  stance: 'defensive',
  activity: 'guarding',
  targetId: null,
  hullPct: 100,
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
    applyFleetStatus([row('a', { hullPct: 50 })]);
    expect(getFleetStatusVersion()).toBe(v + 1);
    expect(getFleetStatus('a')?.hullPct).toBe(50);
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
    applyFleetStatus([row('a', { morale: 70, orderKind: 'move' })]);
    const r = getFleetStatus('a')!;
    for (const k of ['x', 'y', 'vx', 'vy', 'angle']) expect(k in r).toBe(false);
  });
});

describe('describeActivity', () => {
  it('reads in plain language', () => {
    expect(describeActivity(row('a', { activity: 'guarding' }))).toBe('Guarding');
    expect(describeActivity(row('a', { activity: 'moving' }))).toBe('Moving');
    expect(describeActivity(row('a', { activity: 'chasing' }), 'Drone')).toBe('Chasing Drone');
    expect(describeActivity(row('a', { activity: 'chasing' }))).toBe('Chasing');
    expect(describeActivity(row('a', { activity: 'attacking' }), 'Fighter')).toBe('Attacking Fighter');
    expect(describeActivity(row('a', { activity: 'retreating', hullPct: 19.6 }))).toBe('Retreating – hull 20%');
    expect(describeActivity(row('a', { activity: 'formingUp' }))).toBe('Forming up');
    expect(describeActivity(row('a', { activity: 'patrolling' }))).toBe('Patrolling');
    expect(describeActivity(row('a', { activity: 'idle' }))).toBe('Idle');
    expect(describeActivity(undefined)).toBe('No report yet');
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
    ships: new Map([['p1', { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'fighter' }]]),
    lingeringShips: new Map([['h1', { x: 0, y: 0, angle: 0, vx: 0, vy: 0, kind: 'scout', ownerPlayerId: 'p1' }]]),
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

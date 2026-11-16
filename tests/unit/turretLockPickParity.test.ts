/**
 * A capital group's turrets share its locks out with ONE rule on both sides of
 * the wire (invariant #15): the server aims and gates fire per mount with
 * `pickTurretLock` (LockSubsystem.aimKeyFor), and the client's predicted turret
 * aim + ghost-bolt gate must pick the same target, or the predicted barrels
 * train on a different ship than the real ones. Fails when either side stops
 * calling the shared function.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LockSubsystem, type LockTargetView } from '../../src/server/rooms/LockSubsystem.js';
import { ColyseusGameClient } from '../../src/client/net/ColyseusClient.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';
import { mountWeaponReach } from '../../src/core/combat/mountReach.js';
import { FcMountPicker } from '../../src/client/net/fcMountPick.js';

describe('pickTurretLock parity with mixed-class locks (#15, owner 2026-11-14)', () => {
  it('server aimKeyFor and client fcMountAimKey pick the same lock per turret', () => {
    // A pilot battleship (heading +y) with three locks on its main battery:
    // a fighter, a heavy cruiser and a structure, all in reach.
    const targets = new Map<string, LockTargetView>([
      ['s:1', { x: 1200, y: 1000, vx: 0, vy: 0, angle: 0, ship: true, kindId: 'fighter', shieldUp: true, radius: 24, hostile: true }],
      ['s:2', { x: 3000, y: 4000, vx: 0, vy: 0, angle: 0, ship: true, kindId: 'heavy-cruiser', shieldUp: true, radius: 2183, hostile: true }],
      ['s:3', { x: -3000, y: 1000, vx: 0, vy: 0, angle: 0, ship: false, kindId: null, shieldUp: false, radius: 80, hostile: true }],
    ]);
    const kind = getShipKind('battleship');
    const locks = new LockSubsystem({
      resolveTarget: (_p, key, out) => { const t = targets.get(key); if (!t) return false; Object.assign(out, t); return true; },
      shooterPose: (_p, out) => { out.x = 0; out.y = 0; out.vx = 0; out.vy = 0; out.angle = 0; return true; },
      shipOf: () => ({ kind, activated: [] }),
      autoPick: () => null,
      commitHostileAct: () => undefined,
      refreshHostility: () => undefined,
    });
    locks.enable('p1');
    for (const k of ['s:1', 's:2', 's:3']) locks.forceLock('p1', k, 'main');

    // The client, fed the same groups and the same targets through its mirror.
    const client = Object.create(ColyseusGameClient.prototype) as Record<string, unknown>;
    const mains = (kind.mounts ?? []).filter((m) => m.id.startsWith('main-'));
    const aas = (kind.mounts ?? []).filter((m) => m.id.startsWith('aa-'));
    const swarm = new Map<number, unknown>();
    for (const [key, t] of targets) {
      swarm.set(Number(key.slice(2)), {
        x: t.x, y: t.y, angle: t.angle, kind: t.ship ? 1 : 2, shipKind: t.ship ? t.kindId : undefined, shieldDown: !t.shieldUp, radius: t.radius,
      });
    }
    Object.assign(client, {
      mirror: { ships: new Map(), swarm },
      _fcGroups: locks.wireFor('p1'),
      _fcMountGroup: new Map([...mains.map((m) => [m.id, 'main'] as const), ...aas.map((m) => [m.id, 'aa'] as const)]),
      _fcMountDef: new Map([...mains.map((m, i) => [m.id, { mount: m, ordinal: i, reach: mountWeaponReach(m), group: mains }] as const)]),
      _fcKeys: new Map(),
    });
    Object.assign(client, {
      _fcPicker: new FcMountPicker((k, o) => (client['fcTargetPose'] as (k: string, o: unknown) => boolean).call(client, k, o), (k, o) => (client['fcTargetShape'] as (k: string, o: unknown) => void).call(client, k, o)),
    });
    const clientAim = (client['fcMountAimKey'] as (id: string, x: number, y: number, a: number) => string | null).bind(client);

    const server = mains.map((m) => locks.aimKeyFor('p1', m.id));
    const predicted = mains.map((m) => clientAim(m.id, 0, 0, 0));
    expect(predicted).toEqual(server);
    // And the rule itself: the 16" turrets never take the fighter.
    expect(server).not.toContain('s:1');
  });
});

describe('pickTurretLock parity (#15)', () => {
  it('the server lock aim and the client predicted aim both call it', () => {
    const server = readFileSync('src/server/rooms/LockSubsystem.ts', 'utf8');
    const client = readFileSync('src/client/net/fcMountPick.ts', 'utf8');
    expect(server).toMatch(/pickTurretLock\(/);
    expect(client).toMatch(/pickTurretLock\(/);
  });

  it('the client turret aim and ghost gate both go through the per-mount pick', () => {
    const client = readFileSync('src/client/net/ColyseusClient.ts', 'utf8');
    const aim = client.slice(client.indexOf('private fcTickMountAngles('), client.indexOf('private fcTickMountAngles(') + 1500);
    expect(aim).toMatch(/fcMountAimKey\(/);
    const bears = client.slice(client.indexOf('private fcMountBears('), client.indexOf('private fcMountBears(') + 600);
    expect(bears).toMatch(/fcMountAimKey\(/);
  });
});

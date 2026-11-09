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

describe('pickTurretLock parity (#15)', () => {
  it('the server lock aim and the client predicted aim both call it', () => {
    const server = readFileSync('src/server/rooms/LockSubsystem.ts', 'utf8');
    const client = readFileSync('src/client/net/ColyseusClient.ts', 'utf8');
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

/**
 * #15 — the tractor field the client's prediction world runs
 * (`client/net/tractorLinks.ts`) is the field the server's lease runs
 * (`server/rooms/ForceFieldSubsystem.ts`) for the same emitter pose, mount and
 * target: same force, reach, falloff, cushion and muzzle. Fails when one side
 * changes its pull alone. (The beam-line set and the muzzle velocity are
 * server-only: not on the wire.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ForceFieldSubsystem, type TractorPoseOut } from '../../src/server/rooms/ForceFieldSubsystem.js';
import type { WorkerCmd } from '../../src/server/rooms/PhysicsWorkerProxy.js';
import { TractorLinkClient } from '../../src/client/net/tractorLinks.js';
import type { BeamLinks } from '../../src/shared-types/beamLinksWire.js';
import { getShipKind, type WeaponMount } from '../../src/shared-types/shipKinds.js';
import type { ForceField, TractorForceField } from '../../src/core/physics/forceFields.js';

const mounts = getShipKind('interceptor').mounts as WeaponMount[];
const saved = mounts.map((m) => ({ weaponId: m.weaponId, size: m.size }));
afterEach(() => { mounts.forEach((m, i) => { m.weaponId = saved[i]!.weaponId; m.size = saved[i]!.size; }); });

describe('tractor field parity (server lease ↔ client predWorld)', () => {
  for (const size of ['S', 'L'] as const) {
    it(`same field both sides for a ${size} tractor mount on a turned, offset hull`, () => {
      const mount = mounts[0]!;
      mount.weaponId = 'tractor';
      mount.size = size;
      const pilot = { x: 120, y: -40, angle: 0.7 };
      const rock = { x: 300, y: 800 };

      // Server: a lease from the pilot's mount onto rock entity 42.
      const posted: WorkerCmd[] = [];
      const server = new ForceFieldSubsystem({
        post: (c) => posted.push(c),
        tractors: {
          tick: () => 500,
          poseOf: (id: string, out: TractorPoseOut) => {
            const p = id === 'pilot' ? pilot : id === 'rock' ? { ...rock, angle: 0 } : null;
            if (!p) return false;
            out.x = p.x; out.y = p.y; out.angle = p.angle;
            return true;
          },
          lineBodies: () => 0,
          inCrackHold: () => false,
          wireRef: (id) => (id === 'rock' ? 42 : id),
          onShipTractored: () => {},
          isTerrain: () => true,
        },
      });
      expect(server.renewTractor('pilot', mount, 'rock')).toBe(true);
      server.tickTractors();
      const sf = (posted.filter((c) => c.type === 'SET_FORCE_FIELD').at(-1) as { field: TractorForceField }).field;

      // Client: decode the server's own snapshot links, sync into a fake world.
      const links = server.beamLinks(undefined) as BeamLinks;
      const mirror = {
        ships: new Map([['pilot', { ...pilot, vx: 0, vy: 0, kind: 'interceptor' }]]),
        swarm: new Map([[42, { ...rock, angle: 0, vx: 0, vy: 0 }]]),
      };
      const client = new TractorLinkClient(mirror, new Map([[42, 'rock']]));
      let cf: TractorForceField | null = null;
      client.sync(links, { structure: () => {}, tractor: client.add }, {
        setForceField: (_id: string, f: ForceField) => { cf = { ...(f as TractorForceField) }; },
        removeForceField: () => {},
      });
      expect(cf).not.toBeNull();
      const c = cf!;
      expect(c.target).toBe(sf.target);
      expect(c.emitter).toBe(sf.emitter);
      expect(c.active).toBe(sf.active);
      for (const k of ['force', 'reach', 'dRef', 'hold', 'lineHalfWidth', 'lineFrac'] as const) expect(c[k]).toBe(sf[k]);
      expect(c.mx).toBeCloseTo(sf.mx, 9);
      expect(c.my).toBeCloseTo(sf.my, 9);
    });
  }

  it('same cushion both sides for a capital mount: the load rests clear of its hull (setTractorHold)', () => {
    const bs = getShipKind('battleship').mounts as WeaponMount[];
    const mount = bs.find((m) => m.localX !== 0) ?? bs[0]!;
    const keep = { weaponId: mount.weaponId, size: mount.size };
    mount.weaponId = 'tractor';
    mount.size = 'M';
    try {
      const ship = { x: 0, y: 0, angle: 0.4 };
      const c = Math.cos(ship.angle), s = Math.sin(ship.angle);
      const side = mount.localX >= 0 ? 1 : -1;
      const rock = { x: side * 2500 * c - mount.localY * s, y: side * 2500 * s + mount.localY * c, radius: 220 };
      const posted: WorkerCmd[] = [];
      const server = new ForceFieldSubsystem({
        post: (cmd) => posted.push(cmd),
        tractors: {
          tick: () => 500,
          poseOf: (id: string, out: TractorPoseOut) => {
            if (id === 'cap') { out.x = ship.x; out.y = ship.y; out.angle = ship.angle; out.kindId = 'battleship'; out.radius = 0; return true; }
            if (id === 'rock') { out.x = rock.x; out.y = rock.y; out.angle = 0; out.kindId = null; out.radius = rock.radius; return true; }
            return false;
          },
          lineBodies: () => 0, inCrackHold: () => false, wireRef: (id) => (id === 'rock' ? 42 : id),
          onShipTractored: () => {}, isTerrain: () => true,
        },
      });
      expect(server.renewTractor('cap', mount, 'rock')).toBe(true);
      server.tickTractors();
      const sf = (posted.filter((x) => x.type === 'SET_FORCE_FIELD').at(-1) as { field: TractorForceField }).field;
      const mirror = {
        ships: new Map([['cap', { ...ship, vx: 0, vy: 0, kind: 'battleship' }]]),
        swarm: new Map([[42, { x: rock.x, y: rock.y, angle: 0, vx: 0, vy: 0, kind: 4, radius: rock.radius }]]),
      };
      const client = new TractorLinkClient(mirror, new Map([[42, 'rock']]));
      let cf: TractorForceField | null = null;
      client.sync(server.beamLinks(undefined) as BeamLinks, { structure: () => {}, tractor: client.add }, {
        setForceField: (_id: string, f: ForceField) => { cf = { ...(f as TractorForceField) }; },
        removeForceField: () => {},
      });
      expect(cf).not.toBeNull();
      expect(sf.hold, 'the cushion reaches past the hull').toBeGreaterThan(rock.radius);
      expect(cf!.hold).toBe(sf.hold);
    } finally {
      mount.weaponId = keep.weaponId;
      mount.size = keep.size;
    }
  });
});

/**
 * Owner's rule (2026-11-13): "Ships turning, acceleration, weapons,
 * everything is related to the ship, regardless of pilot." The same ship kind
 * must be exactly as easy to hit, and take the same splash, whether a player
 * or an NPC flies it.
 *
 * Audit finding: a PLAYER's ship was hit on its shield bubble
 * (`kind.radius + shieldPad`) while its shield was up, but an NPC drone of the
 * same kind on a bare `kind.radius` circle (no pad), and shield-down drones
 * stayed a circle instead of the hull. Shell splash measured a player ship (and
 * a parked hull) as a fighter-sized 12 u circle but a drone as its own radius;
 * missiles hit a player on the fighter `hitRadius` circle. Every path now goes
 * through `core/combat/shipHitShape.ts`.
 *
 * Each case fires the SAME shot at the same kind, flown once by a player and
 * once by an NPC, at the same offsets, and requires the same result.
 */
import { describe, expect, it } from 'vitest';
import { ProjectilePipeline } from '../../../src/server/rooms/ProjectilePipeline.js';
import { MissileSimulation } from '../../../src/server/rooms/MissileSimulation.js';
import { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { Bus } from '../../../src/core/events/Bus.js';
import { getWeapon, type MissileWeaponDef } from '../../../src/core/combat/WeaponCatalogue.js';
import { SLOT_ANGLE_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../../src/shared-types/sabLayout.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';
import { shipTuning } from '../../../src/shared-types/shipScale/tuning.js';
import type { ShipState } from '../../../src/server/rooms/schema/SectorState.js';

type Sweep = { entry: number; hitX: number; hitY: number } | null;
// The room's own narrow phases (they read nothing from `this`).
const room = SectorRoom.prototype as unknown as {
  playerProjectileSweep(s: ShipState, fx: number, fy: number, sx: number, sy: number, pr: number, cx: number, cy: number, a: number): Sweep;
  playerHitscanDist(s: ShipState, fx: number, fy: number, dx: number, dy: number, md: number, cx: number, cy: number, a: number): number | null;
  swarmRayHit(rec: object, fx: number, fy: number, dx: number, dy: number, md: number, cx: number, cy: number, a: number): number | null;
};

const KINDS = ['fighter', 'heavy', 'battleship'] as const;
const ANGLES = [0, 0.4, 1.3, 2.9];

function offsetsFor(kindId: string): number[] {
  const k = getShipKind(kindId);
  const pad = shipTuning(k).shieldPad;
  const r = k.radius;
  return [0, r * 0.3, r * 0.7, r - 1, r + pad * 0.5, r + pad - 1, r + pad + 6];
}

function ship(kindId: string, shieldUp: boolean): ShipState {
  return { alive: true, isActive: true, kind: kindId, shield: shieldUp ? 100 : 0 } as unknown as ShipState;
}

function droneRec(kindId: string, shieldUp: boolean, slot = 5) {
  return { id: 'npc', slot, radius: getShipKind(kindId).radius, kind: 1, shipKind: kindId, shieldDown: !shieldUp };
}

/** One shell at lateral offset `off`, flown along +x past a ship at the origin. */
function shellRun(pilot: 'player' | 'npc', kindId: string, shieldUp: boolean, angle: number, off: number): Sweep {
  const sab = new Float32Array(slotBase(16));
  const b = slotBase(5);
  sab[b + SLOT_X_OFF] = 0; sab[b + SLOT_Y_OFF] = 0; sab[b + SLOT_ANGLE_OFF] = angle;
  let hit: Sweep = null;
  const s = ship(kindId, shieldUp);
  const R = getShipKind(kindId).radius + 400;
  const pipe = new ProjectilePipeline({
    sabF32: sab,
    serverTick: () => 0,
    playerToSlot: pilot === 'player' ? new Map([['pl', 5]]) : new Map(),
    getActiveShip: () => s,
    shipPoseCache: new Map([['pl', { x: 0, y: 0, angle }]]),
    playerSweep: (sh, fx, fy, sx, sy, pr, cx, cy, a) => room.playerProjectileSweep(sh, fx, fy, sx, sy, pr, cx, cy, a),
    swarmRegistry: { all: () => (pilot === 'npc' ? [droneRec(kindId, shieldUp)] : []) },
    lingeringSlots: new Map(),
    applyDamage: (_t, _s, _d, hx, hy) => { if (!hit) hit = { entry: 0, hitX: hx ?? NaN, hitY: hy ?? NaN }; },
  });
  // 20 u steps: fine enough to resolve the hull outline.
  pipe.spawn('gun', -R, off, 1200, 0, 10, 2, Math.ceil((2 * R) / 20) + 2, 'laser');
  for (let t = 0; t < Math.ceil((2 * R) / 20) + 2 && !hit; t++) pipe.advance();
  return hit;
}

describe('ship hit shape is the ship\'s, not the pilot\'s (owner rule 2026-11-13)', () => {
  for (const kindId of KINDS) {
    for (const shieldUp of [true, false]) {
      it(`${kindId}, shield ${shieldUp ? 'up' : 'down'}: a shell hits the player ship and the NPC at the same offsets and points`, () => {
        for (const angle of ANGLES) {
          for (const off of offsetsFor(kindId)) {
            const p = shellRun('player', kindId, shieldUp, angle, off);
            const n = shellRun('npc', kindId, shieldUp, angle, off);
            const what = `angle ${angle}, offset ${off.toFixed(1)}: player ${p ? 'hit' : 'miss'}, NPC ${n ? 'hit' : 'miss'}`;
            expect(n !== null, what).toBe(p !== null);
            if (p && n) {
              expect(n.hitX, what).toBeCloseTo(p.hitX, 3);
              expect(n.hitY, what).toBeCloseTo(p.hitY, 3);
            }
          }
        }
      });

      it(`${kindId}, shield ${shieldUp ? 'up' : 'down'}: a beam stops at the same distance on the player ship and the NPC`, () => {
        for (const angle of ANGLES) {
          for (const off of offsetsFor(kindId)) {
            for (const from of [-1, 1]) {
              const R = getShipKind(kindId).radius + 400;
              const fx = from * R;
              const dx = -from;
              const p = room.playerHitscanDist(ship(kindId, shieldUp), fx, off, dx, 0, 2 * R, 0, 0, angle);
              const n = room.swarmRayHit(droneRec(kindId, shieldUp), fx, off, dx, 0, 2 * R, 0, 0, angle);
              const what = `angle ${angle}, offset ${off.toFixed(1)}, from ${from}: player ${p}, NPC ${n}`;
              expect(n === null, what).toBe(p === null);
              if (p !== null && n !== null) expect(n, what).toBeCloseTo(p, 4);
            }
          }
        }
      });

      it(`${kindId}, shield ${shieldUp ? 'up' : 'down'}: a missile detonates at the same point on the player ship and the NPC`, () => {
        const HS = getWeapon('heat-seeker') as MissileWeaponDef;
        const angle = 0.4;
        for (const off of offsetsFor(kindId)) {
          const run = (pilot: 'player' | 'npc') => {
            const sab = new Float32Array(slotBase(16));
            const b = slotBase(5);
            sab[b + SLOT_X_OFF] = 0; sab[b + SLOT_Y_OFF] = 0; sab[b + SLOT_ANGLE_OFF] = angle;
            const s = ship(kindId, shieldUp);
            const hits: Array<{ id: string; x: number; y: number }> = [];
            const sim = new MissileSimulation({
              sabF32: sab,
              serverTick: () => 0,
              playerToSlot: pilot === 'player' ? [['pl', 5]] : [],
              getActiveShip: () => s,
              shipPoseCache: new Map([['pl', { x: 0, y: 0, vx: 0, vy: 0, angle }]]) as never,
              lingeringSlots: new Map(),
              lingeringPoseCache: new Map(),
              swarmRegistry: {
                get: (id: string) => (pilot === 'npc' && id === 'npc' ? droneRec(kindId, shieldUp) : null),
                all: function* () { if (pilot === 'npc') yield droneRec(kindId, shieldUp); },
              } as never,
              applyDamage: () => {},
              broadcastFired: () => {},
              broadcastDetonated: (m) => { hits.push({ id: 'det', x: m.x, y: m.y }); },
              bus: new Bus(),
            });
            const R = getShipKind(kindId).radius + 300;
            sim.spawn('gun', -R, off, 1, 0, HS, () => false);
            for (let t = 0; t < 400 && hits.length === 0; t++) sim.advance();
            return hits[0] ?? null;
          };
          const p = run('player');
          const n = run('npc');
          const what = `offset ${off.toFixed(1)}: player ${p ? `${p.x.toFixed(1)},${p.y.toFixed(1)}` : 'none'}, NPC ${n ? `${n.x.toFixed(1)},${n.y.toFixed(1)}` : 'none'}`;
          expect(n !== null, what).toBe(p !== null);
          if (p && n) {
            expect(n.x, what).toBeCloseTo(p.x, 2);
            expect(n.y, what).toBeCloseTo(p.y, 2);
          }
        }
      });
    }
  }

  it('a siege shell\'s splash hurts a player capital and an NPC capital of the same kind alike', () => {
    const SIEGE = getWeapon('naval_siege');
    const splash = SIEGE.mode === 'projectile' ? SIEGE.splash! : { radius: 0, falloffMin: 0 };
    const BS = getShipKind('battleship');
    // Burst on a fighter at (300, 0); the battleship's centre sits so its own
    // radius reaches halfway into the blast.
    const by = BS.radius + splash.radius / 2;
    const run = (pilot: 'player' | 'npc') => {
      const sab = new Float32Array(slotBase(16));
      const put = (slot: number, x: number, y: number) => {
        const b = slotBase(slot);
        sab[b + SLOT_X_OFF] = x; sab[b + SLOT_Y_OFF] = y; sab[b + SLOT_ANGLE_OFF] = 0;
      };
      put(0, 0, 0); put(1, 300, 0); put(5, 300, by);
      const recs: Array<Record<string, unknown>> = [
        { id: 'gun', slot: 0, radius: 12, kind: 2, halfW: 12, halfH: 12 },
        { id: 'target', slot: 1, radius: getShipKind('fighter').radius, kind: 1, shipKind: 'fighter' },
      ];
      if (pilot === 'npc') recs.push({ id: 'cap', slot: 5, radius: BS.radius, kind: 1, shipKind: 'battleship' });
      const dmg = new Map<string, number>();
      let tick = 0;
      const s = ship('battleship', true);
      const pipe = new ProjectilePipeline({
        sabF32: sab,
        serverTick: () => tick,
        playerToSlot: pilot === 'player' ? new Map([['cap', 5]]) : new Map(),
        getActiveShip: () => s,
        shipPoseCache: new Map([['cap', { x: 300, y: by, angle: 0 }]]),
        playerSweep: (sh, fx, fy, sx, sy, pr, cx, cy, a) => room.playerProjectileSweep(sh, fx, fy, sx, sy, pr, cx, cy, a),
        swarmRegistry: { all: () => recs as never },
        lingeringSlots: new Map(),
        applyDamage: (t, _s, d) => { dmg.set(t, (dmg.get(t) ?? 0) + d); },
      });
      pipe.spawn('gun', 20, 0, 1900, 0, 4200, 12, 160, 'naval_siege');
      for (let t = 0; t < 20; t++) { pipe.advance(); tick++; }
      expect(dmg.get('target'), JSON.stringify([...dmg])).toBe(4200);
      return dmg.get('cap') ?? 0;
    };
    const p = run('player');
    const n = run('npc');
    expect(n).toBeGreaterThan(0);
    expect(p).toBeCloseTo(n, 1); // float32 SAB pose vs the float64 pose cache
  });
});

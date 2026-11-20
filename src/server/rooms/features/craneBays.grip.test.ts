/**
 * Bug (structure-restyle, crane bays): while a ship was parked on a crane
 * bay and the crane held it, the clamp head (lifted over every hull) sat on
 * the ship's centre and hid a small hull for the whole hold. The crane must
 * grip the hull's edge facing it, so the ship being unloaded stays in view.
 * This drives the real bay dwell (`CraneBays.dockDwell`) to its reach and
 * checks the target it gives the arm.
 */
import { describe, expect, it } from 'vitest';
import { CraneBays, type CraneBayHost } from './craneBays.js';
import { CAPITAL_BAY, DOCK_SETTLE_TICKS, FREIGHT_DOCK_BAY, type CraneBay } from '../../../core/articulation/rigCatalogue.js';
import { shipHullDistance } from '../../../core/combat/shipHitShape.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import type { Hold } from '../../../shared-types/goods.js';
import type { LootCollector } from '../../cargo/LootSubsystem.js';
import type { StructureRecord } from '../../structures/StructureRegistry.js';

interface Started { clipId: string | null; target?: { readonly x: number; readonly y: number } }

/** One owned, built crane-bay structure at (sx, sy) turned `rot`°, and one
 *  stopped ship carrying minerals parked at host-frame (lx, ly), heading `la`. */
function serve(bay: CraneBay, kindId: string, lx: number, ly: number, la: number, sx: number, sy: number, rot: number): { started: Started[]; ship: LootCollector } {
  const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const dock = {
    id: 'dock-1', kind: bay.kindId, x: sx, y: sy, rot, owner: 'p1', isConstructed: true,
    hold: { goods: {}, blueprints: [] },
  } as unknown as StructureRecord;
  const kind = getShipKind(kindId);
  const ship: LootCollector = {
    playerId: 'p1', shipInstanceId: 'ship-1',
    x: sx + lx * c - ly * s, y: sy + lx * s + ly * c, angle: la + a,
    vx: 0, vy: 0, shieldUp: true, capacity: 100, kind,
  };
  const hold: Hold = { goods: { minerals: 10 }, blueprints: [] };
  let tick = 1000;
  const started: Started[] = [];
  const host: CraneBayHost = {
    structures: () => ({ get: (id: string) => (id === dock.id ? dock : undefined), all: () => [dock], size: 1 }),
    lootCollectors: { forEach: (fn: (c: LootCollector) => void) => fn(ship), fillShip: () => false },
    manualCargo: new Set(),
    serverTick: () => tick,
    storage: () => ({
      nearestOwnStorage: () => dock, nearestHoverDropOff: () => null,
      deposit: () => ({ goods: {}, blueprints: [] }), loadOutlet: () => ({ goods: {}, blueprints: [] }), outletLoadWeight: () => 0,
    }) as unknown as ReturnType<CraneBayHost['storage']>,
    shipHold: () => hold,
    autoUnloadOn: () => true,
    startStructureRigClip: (_id, clipId, target) => { started.push({ clipId, target }); dock.rigClip = clipId === null ? null : { clipId, startTick: tick, target }; return true; },
    noteDeposited: () => {},
  } as unknown as CraneBayHost;
  const bays = new CraneBays(host);
  for (let k = 0; k < 4 && started.length === 0; k++) { bays.tick(); tick += DOCK_SETTLE_TICKS; }
  return { started, ship };
}

describe('crane bay grip: the clamp holds the hull edge, never the ship centre', () => {
  const cases: Array<[string, CraneBay, number, number]> = [
    ['freight dock', FREIGHT_DOCK_BAY, FREIGHT_DOCK_BAY.cx + 120, FREIGHT_DOCK_BAY.cy + 60],
    ['Capital', CAPITAL_BAY, CAPITAL_BAY.cx - 80, CAPITAL_BAY.cy],
  ];
  for (const [name, bay, lx, ly] of cases) {
    for (const kindId of ['scout', 'fighter', 'trader-hauler']) {
      for (const rot of [0, 90]) {
        it(`${name}, ${kindId}, dock turned ${rot}°: the reach target is on the hull edge facing the crane`, () => {
          const { started, ship } = serve(bay, kindId, lx, ly, 0.7, 300, -200, rot);
          const reach = started.find((s) => s.clipId === 'arm-reach');
          expect(reach?.target).toBeDefined();
          const t = reach!.target!;
          // Host-frame target back to world.
          const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
          const wx = 300 + t.x * c - t.y * s, wy = -200 + t.x * s + t.y * c;
          const id = ship.kind.id;
          // On the hull (the clamp grips metal) ...
          expect(shipHullDistance(id, false, wx, wy, ship.x, ship.y, ship.angle)).toBeLessThan(0.5);
          // ... at its edge: a step back toward the crane pivot is off the hull.
          const px = 300 + bay.pivotX * c - bay.pivotY * s, py = -200 + bay.pivotX * s + bay.pivotY * c;
          const d = Math.hypot(px - wx, py - wy);
          const bx = wx + ((px - wx) / d) * 2, by = wy + ((py - wy) / d) * 2;
          expect(shipHullDistance(id, false, bx, by, ship.x, ship.y, ship.angle)).toBeGreaterThan(0.5);
          // Not the centre: the hub leaves the hull's middle in view.
          expect(Math.hypot(wx - ship.x, wy - ship.y)).toBeGreaterThan(3);
        });
      }
    }
  }
});

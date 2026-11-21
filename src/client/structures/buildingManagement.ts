/**
 * Who may manage buildings right now (owner, 2026-11-20: "It's in fly mode and
 * yet you can build stuff? ... It's supposed to be quite a clear separator").
 *
 * Building MANAGEMENT (deconstruct, reconnect, clear links, upgrade, recipe,
 * blueprint slot, gate access: anything that changes or configures your own
 * building) belongs to Build mode only. In Fly and Command a building's card is
 * read-only info. Pilot services done FROM a ship at a building (repair my
 * ship, refine my salvage, open cargo) are not management and ignore this.
 *
 * The ONE predicate every management affordance reads; built on the store's
 * own `selectControlMode`, so the mode names never drift.
 */
import { selectControlMode, type UIStore } from '../state/store.js';

export function canManageBuildings(s: Pick<UIStore, 'pilotMode' | 'buildMode'>): boolean {
  return selectControlMode(s) === 'build';
}

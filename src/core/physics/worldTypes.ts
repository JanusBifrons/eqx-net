/**
 * Shared shapes of `PhysicsWorld` (World.ts) and its extension modules
 * (`warpActuator.ts`, `spawnBodies.ts`). Kept in their own module so the
 * extensions import them without importing World.ts (no import cycle).
 * World.ts re-exports `ShipPhysicsState` and `ShipInput` for callers.
 */
import type RAPIER from '@dimforge/rapier2d-compat';
import type { ShipKind } from '../../shared-types/shipKinds.js';
import type { ShipInputMultipliers } from './applyShipInput.js';
import type { WarpState } from './warpDrive.js';

export interface ShipPhysicsState {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  /** Angular velocity in rad/s. Optional for back-compat with server snapshots that omit it. */
  angvel?: number;
}

export interface ShipInput {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  /** Shift-held boost — multiplies thrust impulse by `kind.boostMultiplier`
   *  while thrust is also held. No-op on its own. Optional for back-compat. */
  boost?: boolean;
  /** S / Down arrow held — applies a (typically) reduced-magnitude impulse in
   *  the opposite direction of the ship's facing. Cancels with thrust if both
   *  are pressed. Optional for back-compat with replay buffers / unit tests
   *  written before reverse landed. */
  reverse?: boolean;
  /** In-sector warp-to (Phase 4): the drop point asked for this tick. Held
   *  while the pilot wants the warp; absent = no request (cancels a spool).
   *  Run through `stepWarp` (warpDrive.ts) identically on both sides. */
  warpX?: number;
  warpY?: number;
}

export interface ShipBody {
  body: RAPIER.RigidBody;
  kind: ShipKind;
  /** Current collider geometry: false = cheap CIRCLE (shield up), true =
   *  exact HULL polygon compound (shield down). Owned by setHullExposed. */
  exposed: boolean;
  /** Phase 4 WS-B2 — per-instance PHYSICS stat multipliers (`topSpeed`,
   *  `turnRate`), set via `setStatMultipliers`. Threaded into `applyShipInput`
   *  so the server sim + client prediction scale movement identically (risk
   *  #1). `undefined` ⇒ no upgrades ⇒ byte-identical to the legacy path. */
  statMul?: ShipInputMultipliers;
  /** In-sector warp-to state; created on the first warp request. */
  warp?: WarpState;
  /** Pilot layer: the ShipKind an AI slot flies with when driven by input
   *  bits (`applyAiInput`). Set at drone spawn (`SPAWN_OBSTACLE.shipKindId`).
   *  Kept apart from `kind` (an obstacle's placeholder default kind, which
   *  other paths such as the bot warp align still read). */
  pilotKind?: ShipKind;
  /** True once `applyAiInput` has given the body its kind's damping. */
  piloted?: boolean;
}

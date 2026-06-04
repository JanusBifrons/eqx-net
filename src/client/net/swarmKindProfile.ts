/**
 * Client-side per-kind behaviour for binary-swarm (pose-core) entities — the
 * client analogue of the zone-pure `EntityKindRegistry`, and the fix for HC#2
 * (Generic Entity Pipeline Phase 3).
 *
 * THE BUG THIS CLOSES: `ColyseusClient.syncSwarmIntoPredWorld` used to branch
 * `entry.kind === 0 ? asteroid : <else-is-drone>`. The binary decoder reads
 * ANY `u8` kind byte without crashing, so a future pose-core kind (e.g. the
 * P4 `structure` = kind 2) would have fallen into the drone `else` — getting a
 * circular collider, registered as a `HostileDroneBehaviour` in the hostility
 * ledger, never posed — a silent mis-route. The wire stride/version is genuinely
 * unchanged by a new kind byte, but the CLIENT was not ready for one.
 *
 * THE FIX: route by an EXPLICIT per-kind profile. A kind with no profile
 * (`null`) is SKIPPED in predWorld construction — never falls through to the
 * drone path. Adding a new pose-core kind is one appended `case` here plus its
 * vertices/mass at the (now kind-explicit) construction site — the P4
 * "structure for free" seam.
 *
 * Behaviour-preserving for the existing wire: kinds 0 (asteroid) and 1 (drone)
 * resolve to exactly today's decisions; only an UNRECOGNISED kind changes
 * (skip-not-misroute), and none exists on the wire today.
 */

import { SWARM_KIND_ASTEROID, SWARM_KIND_DRONE, SWARM_KIND_STRUCTURE } from '../../shared-types/swarmWireFormat.js';

export interface SwarmKindClientProfile {
  readonly kind: number;
  /**
   * Server-static body: LOCKED in predWorld and posed straight from the binary
   * packet (asteroids; future structures). Dynamic kinds (drones) are kinematic
   * followers of the time-interpolated pose written in `updateMirror` and are
   * NOT locked or posed here (the one-pose-per-frame rule).
   */
  readonly staticBody: boolean;
  /** Registered with a `HostileDroneBehaviour` in the hostility ledger (drone
   *  only). A static structure has no AI. */
  readonly hasAiBehaviour: boolean;
  /** Drives the shield-down hull collider swap via `setHullExposed` (drone
   *  only — asteroids/structures have no shield layer client-side). */
  readonly hasShield: boolean;
}

const ASTEROID: SwarmKindClientProfile = {
  kind: SWARM_KIND_ASTEROID,
  staticBody: true,
  hasAiBehaviour: false,
  hasShield: false,
};

const DRONE: SwarmKindClientProfile = {
  kind: SWARM_KIND_DRONE,
  staticBody: false,
  hasAiBehaviour: true,
  hasShield: true,
};

// P4 "structure for free": a static, damageable structure is asteroid-like
// client-side (locked + posed from the packet, no AI brain, no shield layer)
// — but unlike an asteroid the SERVER seeds its `swarmHealth`, so the existing
// DamageRouter 'swarm' strategy makes it damageable with ZERO new dispatch.
const STRUCTURE: SwarmKindClientProfile = {
  kind: SWARM_KIND_STRUCTURE,
  staticBody: true,
  hasAiBehaviour: false,
  hasShield: false,
};

/**
 * The client profile for a pose-core kind byte, or `null` for an unrecognised
 * kind (a future pose-core type not yet wired client-side). Callers MUST treat
 * `null` as "do not construct" (skip) — NEVER fall through to the drone path
 * (the HC#2 mis-route). Append a `case` to wire a new kind (P4 structure = 2).
 */
export function swarmKindClientProfile(kind: number): SwarmKindClientProfile | null {
  switch (kind) {
    case SWARM_KIND_ASTEROID:
      return ASTEROID;
    case SWARM_KIND_DRONE:
      return DRONE;
    case SWARM_KIND_STRUCTURE:
      return STRUCTURE;
    default:
      return null;
  }
}

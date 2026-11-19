/**
 * Constants and small helpers shared by the SectorRoom join path
 * (`JoinHandler`, `joinFreshSpawn`) and the rest of the room. Moved verbatim
 * out of SectorRoom.ts with the JoinHandler split.
 */

import type { WelcomeMessage } from '../../../shared-types/messages.js';
import { stampShipScale } from '../../../shared-types/shipScale/welcomeScale.js';
import { stampNavalRange } from '../../../shared-types/combat/navalRange.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { tuningFor } from '../../../shared-types/shipScale/lookup.js';
import type { SiteCircle } from '../../../core/bases/baseSite.js';

// Dev-only override gate. When set, `testMode`-only join options
// (`initialHull`, `initialShield`, `startHostile`) ALSO apply on
// galaxy rooms — required by the phone-stall repro spec
// (tests/mobile-perf/phone-galaxy-stall-repro.spec.ts) to harden test
// conditions (near-invulnerable ship under heavy combat). Off in
// production; set via `EQX_ALLOW_DEV_OVERRIDES=1` for E2E only.
export const ALLOW_DEV_OVERRIDES = process.env['EQX_ALLOW_DEV_OVERRIDES'] === '1';

/** Welcome extras for a room that breaks capitals into wrecks (shared, frozen). */
export type WreckWelcomeFields = {
  capitalWrecks?: true;
  subcapWrecks?: true;
  wrecks?: import('../../../shared-types/messages.js').WreckDescriptor[];
};

/** Stamp the ship scale and the naval range mode onto a welcome (shared
 *  contracts: shipScale/welcomeScale.ts, combat/navalRange.ts). */
export const withShipScale = (w: WelcomeMessage): WelcomeMessage => stampNavalRange(stampShipScale(w));

export const NO_SITE_CIRCLES: readonly SiteCircle[] = [];

/** A hull's extent for spawn clearance against other hulls: its radius plus
 *  its shield pad (#18, both from the kind's size). */
export function hullExtent(kind: string): number {
  return getShipKind(kind).radius + tuningFor(kind).shieldPad;
}

/** Ticks after ANY player join/spawn during which snapshot broadcasts
 *  are forced ON regardless of sector idle state. 300 ticks = 5 s at
 *  60 Hz.
 *
 *  Why: a player who joins a quiet sector (initial join, sector
 *  transit, reconnect) spawns stationary. With no motion the idle
 *  tracker never fires, so after `IDLE_THRESHOLD_TICKS` the broadcast
 *  loop short-circuits — and the freshly-joined client NEVER receives
 *  a snapshot to reconcile its prediction world against the real
 *  spawn pose. It free-runs its (stale, post-transit) prediction,
 *  renders the ship at the wrong place, and the moment the player
 *  moves the sector un-idles, the first snapshot lands, and the
 *  reconciler snaps the ship hundreds of units (the user-reported
 *  "warp in → stay still → move → teleport" bug, capture
 *  2026-05-15T20-35-04-862Z-0ibj77 showed an 803-unit correction
 *  after a 5.25 s snapshot blackout). The grace window guarantees the
 *  new client gets a steady snapshot stream long enough to reconcile;
 *  once reconciled a stationary ship's prediction matches the server
 *  so subsequent idle-suppression is harmless. 5 s also matches the
 *  client's `joinMinimumElapsed` curtain floor. */
export const JOIN_BROADCAST_GRACE_TICKS = 300;

/**
 * Plan: crispy-kazoo, Commit 2 — `client_ready` watchdog.
 *
 * If the client never sends `client_ready` (broken bootstrap, network
 * drop mid-load) the watchdog force-activates the ship at this tick
 * so the player appears even if their client is wedged. 30 s at
 * 60 Hz = 1800 ticks. Better than an invisible ghost; the Limbo
 * 15 min TTL eventually catches truly-dead sessions.
 */
export const CLIENT_READY_TIMEOUT_TICKS = 1800;

/**
 * Per-pending-join record. Lives in `pendingJoin: Map<playerId, ...>`
 * on the room. Removed when the ship activates (normal or watchdog).
 */
export interface PendingJoinRecord {
  joinTick: number;
  watchdogTick: number;
  /** Set when `client_ready` is received and the server picks the
   *  activation tick. `null` while waiting for client_ready. */
  arrivalTick: number | null;
  spawnX: number;
  spawnY: number;
  sessionId: string;
  /** Equinox Phase 5 (WS-3) — join-as-spectator. When `true`, `drainPendingJoin`
   *  PARKS the hull as a lingering hull at the arrival flip (via
   *  `displaceActiveHullToLingering`) instead of flipping `isActive = true`, so
   *  the player arrives with no active hull. Only set on a galaxy-room fresh
   *  spawn whose join carried `spectator: true`. */
  spectator?: boolean;
  /** RTS Part A seamless take controls — the hull was ALREADY in the world
   *  (a parked hull reclaimed by `pilot_ship`). Others keep receiving it
   *  through the handshake (as the parked hull it still is) instead of it
   *  vanishing and coming back active: their clients move it to its pilot's
   *  key without a flicker. A fresh spawn stays hidden until it arrives. */
  inWorld?: boolean;
}

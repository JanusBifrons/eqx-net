/**
 * Stage 5 — snapshot cadence & priority scheduler.
 *
 * Pure module — no Colyseus, no DOM, no Node-only APIs. Replaces the
 * pre-Stage-5 "every 3 ticks the broadcast loop runs" pattern (driven by
 * `broadcastCounter` in `SectorRoom.update()`) with per-client decision
 * functions:
 *
 *   - {@link computePhaseOffset} — deterministic 0..modulus-1 hash from a
 *     `playerId`, used so multi-client snapshot broadcasts stagger across
 *     ticks instead of all firing on the same tick. Smooths server CPU
 *     load and incidentally narrows perceived snapshot jitter at the
 *     client.
 *
 * Subsequent cycles (close-tier predicate, hysteresis, idle suppression,
 * lastInput omission) extend this module.
 *
 * Tested directly — see `snapshotScheduler.test.ts`. The original Stage 5
 * test-infra plan called for a `MockSectorRoom` harness; in practice the
 * pure-module discipline lets us cover every cycle with primitive-input
 * vitest tests, no harness needed.
 */

/**
 * FNV-1a 32-bit hash over a UTF-16 string, modulo the requested modulus.
 *
 * Deterministic, fast, well-distributed for short string keys (UUIDs,
 * Colyseus session ids, durable playerIds). The hash is stable across
 * processes, so a returning client gets the same offset on rejoin —
 * useful for "is this client already in the snapshot rotation?" checks.
 *
 * @param playerId  durable id used as the hash key. Empty string is valid
 *                  and returns 0 deterministically.
 * @param modulus   bucket count (e.g. 2 for close-tier 30 Hz cadence,
 *                  3 for far-tier 20 Hz cadence). Must be >= 1.
 */
export function computePhaseOffset(playerId: string, modulus: number): number {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < playerId.length; i++) {
    h ^= playerId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime, kept unsigned
  }
  return h % modulus;
}

/** Far-tier broadcast cadence — 20 Hz (every 3 server ticks at 60 Hz),
 *  with the per-client phase offset hashed from `playerId`. The
 *  predicate returns true on the ticks where this client should
 *  receive a far-tier snapshot.
 *
 *  The pre-Stage-5 implementation was a global `broadcastCounter` that
 *  hit threshold every 3 ticks, broadcasting to every client at once.
 *  Stage 5 makes this per-client so two clients with different ids
 *  almost never broadcast on the same tick — 33% chance of collision
 *  per tick instead of 100%, smoothing CPU and serialization spikes
 *  across the broadcast wall-clock window. */
export function shouldBroadcastFar(serverTick: number, playerId: string): boolean {
  const offset = computePhaseOffset(playerId, 3);
  return (serverTick + offset) % 3 === 0;
}

/** Close-tier broadcast cadence — 30 Hz (every 2 server ticks at 60 Hz).
 *  Used for ships within the recipient's close-tier cell window
 *  (1-cell radius); they receive twice the snapshot rate of far-tier
 *  ships, halving the perceived correction window during dogfights. */
export function shouldBroadcastClose(serverTick: number, playerId: string): boolean {
  const offset = computePhaseOffset(playerId, 2);
  return (serverTick + offset) % 2 === 0;
}

/**
 * Per-recipient tier-membership state. Each Colyseus client holds one of
 * these; the SectorRoom calls {@link classifyShipTier} per ship per
 * scheduler decision, threading this state through so hysteresis works.
 *
 * Internal map: `shipId → { tier, lastTransitionTick }`. The
 * `lastTransitionTick` field exists for future telemetry / debug
 * overlays — the classifier itself only reads `tier`.
 */
export interface TierStateForRecipient {
  membership: Map<string, { tier: 'close' | 'far'; lastTransitionTick: number }>;
}

export function createTierState(): TierStateForRecipient {
  return { membership: new Map() };
}

/**
 * Decide whether a ship is in the recipient's close-tier or far-tier
 * window. Stateful: the previous classification (if any) is read from
 * `state.membership` and the result is written back, so hysteresis
 * holds across calls.
 *
 * Hysteresis band: `[closeRadius - margin, closeRadius + margin]`. Inside
 * that band the tier is whatever it was last set to. Outside the band
 * (clearly inside or clearly outside the close radius) the tier is
 * recomputed unconditionally. First-time classification (no membership
 * entry) uses the strict `distance < closeRadius` test — no hysteresis
 * applied.
 *
 * Why hysteresis: a ship oscillating across the close-radius boundary
 * (e.g. due to thrust/drift jitter at the edge of one screen) would
 * otherwise flip tier every tick, alternating between 30 Hz and 20 Hz
 * snapshot cadence — visible to the player as periodic jitter on that
 * ship. The 1-cell margin (typically ~256 u against a 2048 u cell)
 * pins the tier across normal motion at the boundary.
 */
export function classifyShipTier(
  state: TierStateForRecipient,
  shipId: string,
  shipPose: { x: number; y: number },
  recipientPose: { x: number; y: number },
  closeRadius: number,
  hysteresisMargin: number,
  currentTick: number,
): 'close' | 'far' {
  const dx = shipPose.x - recipientPose.x;
  const dy = shipPose.y - recipientPose.y;
  const distSq = dx * dx + dy * dy;
  const innerSq = (closeRadius - hysteresisMargin) ** 2;
  const outerSq = (closeRadius + hysteresisMargin) ** 2;

  const prior = state.membership.get(shipId);
  let tier: 'close' | 'far';
  if (prior === undefined) {
    // First classification — strict radius test, no hysteresis.
    tier = distSq < closeRadius * closeRadius ? 'close' : 'far';
  } else if (prior.tier === 'close') {
    // Stay close while inside `closeRadius + margin`.
    tier = distSq <= outerSq ? 'close' : 'far';
  } else {
    // Stay far until clearly inside `closeRadius - margin`.
    tier = distSq < innerSq ? 'close' : 'far';
  }

  if (prior === undefined || prior.tier !== tier) {
    state.membership.set(shipId, { tier, lastTransitionTick: currentTick });
  }
  return tier;
}

/**
 * Idle-sector tracking. The room calls {@link noteSectorEvent} whenever
 * any ship has moved more than the motion epsilon, a projectile is in
 * flight, or any other "this sector is busy" signal fires. The
 * scheduler then suppresses snapshot broadcasts when the sector has
 * been quiet for `idleThresholdTicks` consecutive ticks.
 *
 * Why this matters: an empty (or motionless) sector still pays the
 * full per-tick snapshot CPU cost (state assembly, per-client
 * serialisation, broadcast). Suppressing during idle frees the budget
 * for active sectors and reduces wire traffic for clients sitting in
 * a docked / parked state. Re-arms instantly on the next event so the
 * first frame of motion still ships.
 *
 * Stateful by design — the room owns one tracker per sector. The
 * tracker initial state reports "idle" so a brand-new sector with no
 * activity stays quiet until the first event fires.
 */
export interface IdleTracker {
  /** Server tick of the most recent event. -Infinity = "no events ever",
   *  which makes the first {@link isSectorIdle} call return true under
   *  any positive threshold. */
  lastEventTick: number;
}

export function createIdleTracker(): IdleTracker {
  return { lastEventTick: -Infinity };
}

/** Mark this tick as having activity (motion above epsilon, projectile
 *  spawn, etc.). Subsequent {@link isSectorIdle} calls within
 *  `idleThresholdTicks` of this point return false. */
export function noteSectorEvent(tracker: IdleTracker, currentTick: number): void {
  tracker.lastEventTick = currentTick;
}

/** True iff at least `idleThresholdTicks` ticks have elapsed since the
 *  last {@link noteSectorEvent}. The room uses this to short-circuit
 *  the snapshot broadcast loop entirely on quiet sectors. */
export function isSectorIdle(
  tracker: IdleTracker,
  currentTick: number,
  idleThresholdTicks: number,
): boolean {
  return currentTick - tracker.lastEventTick >= idleThresholdTicks;
}

/**
 * The 5-bit input vector each remote client uses to forward-predict
 * a ship between snapshots. Mirrors the SAB FLAG_INPUT_* layout.
 *
 * `lastInput` is included on every ship in every snapshot today —
 * 5 booleans per ship per 50 ms. For idle ships that's pure waste:
 * the bits don't change for seconds at a time. Stage 5 omits the
 * field when it matches the last-sent value for this recipient.
 */
export type ShipInputBits = {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  boost: boolean;
  reverse: boolean;
};

/** Per-recipient cache of the last `lastInput` bits sent for each ship.
 *  The room holds one of these per Colyseus client. */
export interface LastInputCache {
  perShip: Map<string, ShipInputBits>;
}

export function createLastInputCache(): LastInputCache {
  return { perShip: new Map() };
}

/** Returns true iff `current` differs from the cached value (or no
 *  cache entry exists yet). Updates the cache when it returns true.
 *
 *  Caller wires this into the snapshot builder: include `lastInput` on
 *  the outbound state record only when this function returns true.
 *  When it returns false, the field is omitted and the client falls
 *  back to its previously-cached value — wire bytes saved without
 *  any change to the predicted-pose contract. */
export function shouldIncludeLastInput(
  cache: LastInputCache,
  shipId: string,
  current: ShipInputBits,
): boolean {
  const prev = cache.perShip.get(shipId);
  if (
    prev !== undefined &&
    prev.thrust === current.thrust &&
    prev.turnLeft === current.turnLeft &&
    prev.turnRight === current.turnRight &&
    prev.boost === current.boost &&
    prev.reverse === current.reverse
  ) {
    return false;
  }
  // Clone — caller passes a transient object that may be reused next tick.
  cache.perShip.set(shipId, { ...current });
  return true;
}

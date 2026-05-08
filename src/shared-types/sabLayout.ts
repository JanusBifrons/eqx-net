/**
 * SharedArrayBuffer layout for physics state.
 *
 * Memory map (all offsets in 4-byte words; u32 and f32 share the same byte position):
 *
 * Header (words 0-4):
 *   [0] seqlock      Uint32  — even = idle, odd = write in progress
 *   [1] tick         Uint32  — physics tick counter
 *   [2] count        Uint32  — active entity count
 *   [3] clockRate    Uint32  — TiDi simulation rate × 1e6 (Phase 6).
 *                              0 means "not initialised" → worker treats as 1.0.
 *                              Single-writer: only the worker writes this slot,
 *                              in response to a CLOCK_RATE postMessage from main.
 *   [4] workerTickUs Uint32  — Phase 6 — most recent worker step() wall-clock
 *                              in microseconds. Single-writer (worker), single-
 *                              reader (server). Drives the SimulationClock when
 *                              the bottleneck is physics-side, not server-side.
 *
 * Per-entity slots (words 5 onwards, SLOT_WORDS = 9 per slot):
 *   [base+0] slotId       Uint32   — slot index + 1; 0 means empty
 *   [base+1] x            Float32
 *   [base+2] y            Float32
 *   [base+3] vx           Float32
 *   [base+4] vy           Float32
 *   [base+5] angle        Float32
 *   [base+6] angvel       Float32  — angular velocity (rad/s)
 *   [base+7] appliedTick  Uint32   — last client input tick applied by the worker + 1
 *                                    (0 = no input applied yet; N+1 = tick N was applied)
 *   [base+8] flags        Uint32   — bit 0 = SLEEPING, bit 1 = IS_SWARM, bit 2 = KIND_DRONE
 *                                    (Phase 5: sleep handshake + swarm classification)
 */

export const SEQLOCK_IDX = 0; // Uint32Array index
export const TICK_IDX = 1;
export const COUNT_IDX = 2;
export const CLOCK_RATE_IDX = 3; // Phase 6 — TiDi rate × 1e6 (0 ↔ uninitialised)
export const WORKER_TICK_US_IDX = 4; // Phase 6 — most recent worker step() wall-clock in µs
export const HEADER_WORDS = 5; // header size in 4-byte words

/** Encode/decode constants for the SAB clockRate slot.
 *  Storing rate × 1e6 in a u32 gives 6 decimal digits of precision in [0, 4 294.97],
 *  which is plenty for a [0.7, 1.0] dilation range. */
export const CLOCK_RATE_SCALE = 1_000_000;

export const SLOT_WORDS = 9; // slot size in 4-byte words (36 bytes)
// Word offsets within a slot:
export const SLOT_ID_OFF = 0;
export const SLOT_X_OFF = 1;
export const SLOT_Y_OFF = 2;
export const SLOT_VX_OFF = 3;
export const SLOT_VY_OFF = 4;
export const SLOT_ANGLE_OFF = 5;
export const SLOT_ANGVEL_OFF = 6;
export const SLOT_APPLIED_TICK_OFF = 7;
export const SLOT_FLAGS_OFF = 8;

/** Flag bits stored in `SLOT_FLAGS_OFF` (Phase 5). */
export const FLAG_SLEEPING = 1 << 0;
export const FLAG_IS_SWARM = 1 << 1;
export const FLAG_KIND_DRONE = 1 << 2; // 0 = asteroid, 1 = drone (only meaningful with FLAG_IS_SWARM)

/** Stage 3 (network-feel roadmap) — last-applied input flags. The worker
 *  writes these into the slot's FLAGS u32 each tick alongside FLAG_SLEEPING;
 *  the main thread reads them into `SnapshotMessage.states[*].lastInput` so
 *  remote clients can forward-predict the body's pose using the same input
 *  intent the server is applying. */
export const FLAG_INPUT_THRUST     = 1 << 3;
export const FLAG_INPUT_TURN_LEFT  = 1 << 4;
export const FLAG_INPUT_TURN_RIGHT = 1 << 5;
export const FLAG_INPUT_BOOST      = 1 << 6;
export const FLAG_INPUT_REVERSE    = 1 << 7;
/** Mask of all 5 input bits — convenient for clearing the input portion of
 *  the FLAGS word before re-writing. */
export const INPUT_FLAGS_MASK =
  FLAG_INPUT_THRUST |
  FLAG_INPUT_TURN_LEFT |
  FLAG_INPUT_TURN_RIGHT |
  FLAG_INPUT_BOOST |
  FLAG_INPUT_REVERSE;

export const MAX_ENTITIES = 5120;
/** Total SAB size in bytes: 5-word header + 5120 slots × 36 bytes ≈ 184 KB.
 *  Sized for the Phase 6 TiDi acceptance gate (~4000 swarm + headroom for
 *  human ships, projectiles, and shed/respawn churn). 10 000 dynamic Rapier
 *  bodies is past `rapier2d-compat`'s WASM pool design point and crashed the
 *  worker; 4000 is well within the safe envelope. */
export const SAB_TOTAL_BYTES = (HEADER_WORDS + MAX_ENTITIES * SLOT_WORDS) * 4;

/** Returns the Uint32Array / Float32Array base index for slot `n`. */
export function slotBase(n: number): number {
  return HEADER_WORDS + n * SLOT_WORDS;
}

/**
 * SharedArrayBuffer layout for physics state.
 *
 * Memory map (all offsets in 4-byte words; u32 and f32 share the same byte position):
 *
 * Header (words 0-2):
 *   [0] seqlock  Uint32  — even = idle, odd = write in progress
 *   [1] tick     Uint32  — physics tick counter
 *   [2] count    Uint32  — active entity count
 *
 * Per-entity slots (words 3 onwards, SLOT_WORDS = 7 per slot):
 *   [base+0] slotId   Uint32   — slot index + 1; 0 means empty
 *   [base+1] x        Float32
 *   [base+2] y        Float32
 *   [base+3] vx       Float32
 *   [base+4] vy       Float32
 *   [base+5] angle    Float32
 *   [base+6] flags    Uint32   — reserved
 */

export const SEQLOCK_IDX = 0; // Uint32Array index
export const TICK_IDX = 1;
export const COUNT_IDX = 2;
export const HEADER_WORDS = 3; // header size in 4-byte words

export const SLOT_WORDS = 7; // slot size in 4-byte words (28 bytes)
// Word offsets within a slot:
export const SLOT_ID_OFF = 0;
export const SLOT_X_OFF = 1;
export const SLOT_Y_OFF = 2;
export const SLOT_VX_OFF = 3;
export const SLOT_VY_OFF = 4;
export const SLOT_ANGLE_OFF = 5;
export const SLOT_FLAGS_OFF = 6;

export const MAX_ENTITIES = 1024;
/** Total SAB size in bytes: header + 1024 slots × 28 bytes = 28 684 bytes. */
export const SAB_TOTAL_BYTES = (HEADER_WORDS + MAX_ENTITIES * SLOT_WORDS) * 4;

/** Returns the Uint32Array / Float32Array base index for slot `n`. */
export function slotBase(n: number): number {
  return HEADER_WORDS + n * SLOT_WORDS;
}

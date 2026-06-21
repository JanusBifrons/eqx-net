/**
 * Equinox Phase-5 audit (2026-06-21) — the SHIPLESS-SPECTATOR join hang.
 *
 * `firstFrameRendered` gates `client_ready` (→ the load curtain). A
 * join-as-spectator player has NO ship in the mirror, so the old
 * `mirror.ships.has(localPlayerId)` latch never flipped → the curtain hung on
 * "connecting → taking longer than expected" (confirmed from diag capture
 * 2026-06-21T15-54-13Z-7t3dm1: `pixi_first_frame` fired with `hasLocal:true`
 * ONLY for the ship join, never the spectator join).
 *
 * Failing-first (Invariant #13): the `spectator → latch true with no ship` case
 * FAILS against the pre-fix logic (which had no spectator branch — drop `||
 * spectator` and that case returns false).
 */
import { describe, it, expect } from 'vitest';
import { shouldLatchFirstFrame } from './firstFrameLatch.js';

describe('shouldLatchFirstFrame', () => {
  it('SHIPLESS SPECTATOR latches once welcomed — the join-hang fix', () => {
    // localPlayerId set (welcomed), NO local ship, spectating → latch.
    expect(shouldLatchFirstFrame(false, 'p1', false, true)).toBe(true);
  });

  it('piloting latches only once the OWN ship is painted', () => {
    expect(shouldLatchFirstFrame(false, 'p1', true, false)).toBe(true);
  });

  it('piloting does NOT latch while the own ship is absent (idle sector, only remotes)', () => {
    expect(shouldLatchFirstFrame(false, 'p1', false, false)).toBe(false);
  });

  it('never latches before the welcome sets localPlayerId', () => {
    expect(shouldLatchFirstFrame(false, null, false, true)).toBe(false);
    expect(shouldLatchFirstFrame(false, null, true, false)).toBe(false);
  });

  it('is idempotent — never re-latches once already latched', () => {
    expect(shouldLatchFirstFrame(true, 'p1', true, true)).toBe(false);
    expect(shouldLatchFirstFrame(true, 'p1', false, true)).toBe(false);
  });
});

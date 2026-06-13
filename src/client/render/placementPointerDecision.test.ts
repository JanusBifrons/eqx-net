import { describe, it, expect } from 'vitest';
import { decidePlacementPointer } from './placementPointerDecision.js';

/**
 * P3.5 (follow STILL broken) regression lock. The headline contract: a
 * `pointerleave` must NOT park the placement follow — desktop hover-follow has
 * no pointer capture, so the canvas fires `pointerleave` the moment the cursor
 * crosses the speed-dial / leaves the edge, and parking there (the pre-fix
 * behaviour) broke the lock permanently ("won't reconnect until you place
 * again"). The rest of the suite locks the desktop one-click vs touch-park
 * split that the pure state machine encodes.
 */
describe('decidePlacementPointer', () => {
  it('pointerleave is a NO-OP — it does NOT park the follow (P3.5 fix)', () => {
    // The bug: leaving the canvas set following=false; here it must stay live.
    const whileFollowing = decidePlacementPointer('pointerleave', 'mouse', -1, true);
    expect(whileFollowing.following).toBeNull(); // unchanged → stays true
    expect(whileFollowing.updateChosen).toBe(false);
    expect(whileFollowing.commit).toBe(false);
    // Even if (somehow) not following, leave never flips it on either.
    expect(decidePlacementPointer('pointerleave', 'mouse', -1, false).following).toBeNull();
  });

  it('pointermove tracks the ghost while following (desktop hover keeps it true)', () => {
    expect(decidePlacementPointer('pointermove', 'mouse', -1, true).updateChosen).toBe(true);
    // After a touch park (following=false), a move does NOT move the ghost.
    expect(decidePlacementPointer('pointermove', 'touch', -1, false).updateChosen).toBe(false);
    // pointermove never changes the follow flag itself.
    expect(decidePlacementPointer('pointermove', 'mouse', -1, true).following).toBeNull();
  });

  it('pointerdown starts the follow and anchors the chosen point', () => {
    const d = decidePlacementPointer('pointerdown', 'touch', 0, false);
    expect(d.following).toBe(true);
    expect(d.updateChosen).toBe(true);
    expect(d.commit).toBe(false);
  });

  it('DESKTOP mouse left-release commits (one-click place)', () => {
    const up = decidePlacementPointer('pointerup', 'mouse', 0, true);
    expect(up.commit).toBe(true);
    expect(up.updateChosen).toBe(true);
    expect(up.following).toBe(false);
  });

  it('TOUCH release PARKS (no commit) — the two-step Confirm-banner flow', () => {
    const up = decidePlacementPointer('pointerup', 'touch', 0, true);
    expect(up.commit).toBe(false);
    expect(up.following).toBe(false); // parked → Confirm banner stable
    expect(up.updateChosen).toBe(true);
  });

  it('a non-left mouse release does NOT commit', () => {
    expect(decidePlacementPointer('pointerup', 'mouse', 2, true).commit).toBe(false);
  });

  it('pointercancel parks the follow (genuine OS/browser cancellation)', () => {
    const c = decidePlacementPointer('pointercancel', 'touch', -1, true);
    expect(c.following).toBe(false);
    expect(c.commit).toBe(false);
  });
});

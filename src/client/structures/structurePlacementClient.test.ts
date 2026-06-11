import { describe, it, expect } from 'vitest';
import {
  computePlacementPose,
  computePlacementPreview,
  PLACEMENT_AHEAD_GAP,
  PENDING_PLACEMENT_TIMEOUT_MS,
  pendingPlacementResolved,
  resolvePlacementPreviewStatus,
  type PendingPlacement,
  type PlacementPreview,
} from './structurePlacementClient.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';

describe('computePlacementPose', () => {
  it('drops the structure straight ahead (+y) at angle 0', () => {
    const pos = computePlacementPose({ x: 0, y: 0, angle: 0 }, 'connector');
    const expectedDist = 12 + getStructureKind('connector').radius + PLACEMENT_AHEAD_GAP;
    expect(pos.x).toBeCloseTo(0, 5);
    expect(pos.y).toBeCloseTo(expectedDist, 5);
  });

  it('uses the (-sin, cos) forward convention — angle π/2 points -x', () => {
    const pos = computePlacementPose({ x: 100, y: 50, angle: Math.PI / 2 }, 'solar');
    const dist = 12 + getStructureKind('solar').radius + PLACEMENT_AHEAD_GAP;
    // forward = (-sin(π/2), cos(π/2)) = (-1, 0)
    expect(pos.x).toBeCloseTo(100 - dist, 5);
    expect(pos.y).toBeCloseTo(50, 5);
  });

  it('scales clearance with the kind radius (capital lands further out than a connector)', () => {
    const cap = computePlacementPose({ x: 0, y: 0, angle: 0 }, 'capital');
    const con = computePlacementPose({ x: 0, y: 0, angle: 0 }, 'connector');
    expect(cap.y).toBeGreaterThan(con.y);
  });
});

describe('computePlacementPreview (Issue 5 — render-mirror ghost pose)', () => {
  it('returns null when no kind is selected (no preview)', () => {
    expect(computePlacementPreview({ x: 0, y: 0, angle: 0 }, null)).toBeNull();
  });

  it('lands at EXACTLY the computePlacementPose spot (no preview/commit drift)', () => {
    const ship = { x: 100, y: 50, angle: Math.PI / 3 };
    const pose = computePlacementPose(ship, 'turret');
    const preview = computePlacementPreview(ship, 'turret');
    expect(preview).not.toBeNull();
    expect(preview!.kind).toBe('turret');
    expect(preview!.x).toBeCloseTo(pose.x, 6);
    expect(preview!.y).toBeCloseTo(pose.y, 6);
    // Structures render as regular polygons — angle is 0 (no facing).
    expect(preview!.angle).toBe(0);
  });
});

// ── Pending placement ghost (playtest 2026-06-10 Issue 7) ────────────────────
// "when you place a structure it just kinda vanishes then appears after a
// second or two." The fix keeps a dim ghost at the sent point until the
// structure lands (slice count grows) or a timeout elapses.

const SENT: PendingPlacement = { kind: 'capital', x: 200, y: -150, sentAtMs: 1000, baselineStructureCount: 3 };

describe('pendingPlacementResolved', () => {
  it('stays UNRESOLVED while the structure has not appeared and within the window', () => {
    expect(pendingPlacementResolved(SENT, 1000, 3)).toBe(false);
    expect(pendingPlacementResolved(SENT, 1000 + PENDING_PLACEMENT_TIMEOUT_MS - 1, 3)).toBe(false);
  });

  it('resolves the instant a new structure appears (count grows past baseline)', () => {
    expect(pendingPlacementResolved(SENT, 1100, 4)).toBe(true);
  });

  it('resolves on timeout even if no structure ever appears (rejected / lost)', () => {
    expect(pendingPlacementResolved(SENT, 1000 + PENDING_PLACEMENT_TIMEOUT_MS, 3)).toBe(true);
  });
});

describe('resolvePlacementPreviewStatus', () => {
  const scratch = (): PlacementPreview => ({ kind: 'connector', x: 0, y: 0, angle: 0, pending: false });

  it('ACTIVE: a live placementKind shows the ahead-of-ship positioning ghost', () => {
    const out = scratch();
    const ship = { x: 0, y: 0, angle: 0 };
    const status = resolvePlacementPreviewStatus('solar', ship, null, 1000, 3, out);
    expect(status).toBe('active');
    expect(out.pending).toBe(false);
    const pose = computePlacementPose(ship, 'solar');
    expect(out.x).toBeCloseTo(pose.x, 6);
    expect(out.y).toBeCloseTo(pose.y, 6);
  });

  it('PENDING: after Confirm (placementKind cleared) the dim ghost stays at the sent point — the gap fix', () => {
    const out = scratch();
    // No placementKind, but a pending placement that has not landed yet + within window.
    const status = resolvePlacementPreviewStatus(null, null, SENT, 1500, 3, out);
    expect(status).toBe('pending');
    expect(out.pending).toBe(true);
    expect(out.kind).toBe('capital');
    expect(out.x).toBe(200);
    expect(out.y).toBe(-150);
  });

  it('CLEARED: once the structure lands, the pending ghost resolves (caller drops it)', () => {
    const out = scratch();
    const status = resolvePlacementPreviewStatus(null, null, SENT, 1500, 4, out);
    expect(status).toBe('cleared');
  });

  it('ACTIVE beats PENDING: a fresh placement takes priority over a stale pending ghost', () => {
    const out = scratch();
    const status = resolvePlacementPreviewStatus('turret', { x: 0, y: 0, angle: 0 }, SENT, 1500, 3, out);
    expect(status).toBe('active');
    expect(out.kind).toBe('turret');
  });

  it('NONE: nothing to show with no placementKind and no pending', () => {
    const out = scratch();
    expect(resolvePlacementPreviewStatus(null, null, null, 1500, 3, out)).toBe('none');
  });
});

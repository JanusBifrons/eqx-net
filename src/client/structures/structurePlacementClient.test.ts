import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computePlacementPose,
  computePlacementPreview,
  commitChosenPlacement,
  PLACEMENT_AHEAD_GAP,
  PENDING_PLACEMENT_TIMEOUT_MS,
  pendingPlacementResolved,
  resolvePlacementPreviewStatus,
  type PendingPlacement,
  type PlacementPreview,
} from './structurePlacementClient.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { placementChosen, resetPlacementChosen } from './placementChosen.js';

// Mock the game-client singleton so commitChosenPlacement's send path is
// observable (placeStructureAt → room.send; placeStructureAhead → mirror pose).
const send = vi.fn();
const notePendingPlacement = vi.fn();
let mockLocalId: string | null = 'p1';
const mockShips = new Map<string, { x: number; y: number; angle: number }>();
vi.mock('../net/clientSingleton.js', () => ({
  getGameClient: () => ({
    mirror: { localPlayerId: mockLocalId, ships: mockShips },
    getRoom: () => ({ send }),
    notePendingPlacement,
  }),
}));

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
    expect(pendingPlacementResolved(SENT, 1000, 3, true)).toBe(false);
    expect(pendingPlacementResolved(SENT, 1000 + PENDING_PLACEMENT_TIMEOUT_MS - 1, 3, true)).toBe(false);
  });

  it('resolves when a new structure appears AND it is renderable (count grew + swarm pose present)', () => {
    expect(pendingPlacementResolved(SENT, 1100, 4, true)).toBe(true);
  });

  // R2.1 regression lock — the vanish-then-reappear race. The JSON structures
  // slice (count) grows on a SEPARATE channel from the binary swarm pose the
  // sprite needs. Clearing the ghost on count-grew alone left a window where the
  // slice had grown but no sprite existed yet → vanish. Gating on renderability
  // keeps the ghost up until the structure can actually draw. Pre-fix code
  // (count-only) returned true here → the bug.
  it('STAYS UNRESOLVED when the count grew but the structure is NOT renderable yet (no swarm pose)', () => {
    expect(pendingPlacementResolved(SENT, 1100, 4, false)).toBe(false);
  });

  it('resolves on timeout even if never renderable (rejected / AOI-evicted) — no permanent stuck', () => {
    expect(pendingPlacementResolved(SENT, 1000 + PENDING_PLACEMENT_TIMEOUT_MS, 3, false)).toBe(true);
  });
});

describe('resolvePlacementPreviewStatus', () => {
  const scratch = (): PlacementPreview => ({ kind: 'connector', x: 0, y: 0, angle: 0, pending: false });

  it('ACTIVE: a live placementKind shows the ahead-of-ship positioning ghost', () => {
    const out = scratch();
    const ship = { x: 0, y: 0, angle: 0 };
    const status = resolvePlacementPreviewStatus('solar', ship, null, 1000, 3, true, out);
    expect(status).toBe('active');
    expect(out.pending).toBe(false);
    const pose = computePlacementPose(ship, 'solar');
    expect(out.x).toBeCloseTo(pose.x, 6);
    expect(out.y).toBeCloseTo(pose.y, 6);
  });

  it('PENDING: after Confirm (placementKind cleared) the dim ghost stays at the sent point — the gap fix', () => {
    const out = scratch();
    // No placementKind, but a pending placement that has not landed yet + within window.
    const status = resolvePlacementPreviewStatus(null, null, SENT, 1500, 3, true, out);
    expect(status).toBe('pending');
    expect(out.pending).toBe(true);
    expect(out.kind).toBe('capital');
    expect(out.x).toBe(200);
    expect(out.y).toBe(-150);
  });

  it('CLEARED: once the structure lands AND is renderable, the pending ghost resolves (caller drops it)', () => {
    const out = scratch();
    const status = resolvePlacementPreviewStatus(null, null, SENT, 1500, 4, true, out);
    expect(status).toBe('cleared');
  });

  // R2.1 — the count grew but the swarm pose hasn't landed: the ghost must STAY
  // (status 'pending'), not clear, or the blueprint vanishes for the channel gap.
  it('PENDING (not cleared) when the count grew but the structure is NOT renderable yet', () => {
    const out = scratch();
    const status = resolvePlacementPreviewStatus(null, null, SENT, 1500, 4, false, out);
    expect(status).toBe('pending');
    expect(out.pending).toBe(true);
  });

  it('ACTIVE beats PENDING: a fresh placement takes priority over a stale pending ghost', () => {
    const out = scratch();
    const status = resolvePlacementPreviewStatus('turret', { x: 0, y: 0, angle: 0 }, SENT, 1500, 3, true, out);
    expect(status).toBe('active');
    expect(out.kind).toBe('turret');
  });

  it('NONE: nothing to show with no placementKind and no pending', () => {
    const out = scratch();
    expect(resolvePlacementPreviewStatus(null, null, null, 1500, 3, true, out)).toBe('none');
  });
});

// ── commitChosenPlacement (WS-10 R2.5 + kuytvy regression) ───────────────────
// The SHARED commit path used by BOTH the touch Confirm banner AND the desktop
// one-click place. It MUST send at the production `placementChosen` point (not
// the webdriver-gated dataset — smoke 2026-06-07 capture kuytvy), falling back
// to the ahead-of-ship pose only when the ghost was never positioned.
describe('commitChosenPlacement', () => {
  beforeEach(() => {
    send.mockClear();
    notePendingPlacement.mockClear();
    resetPlacementChosen();
    mockLocalId = 'p1';
    mockShips.clear();
    mockShips.set('p1', { x: 0, y: 0, angle: 0 });
  });

  it('sends place_structure at the CHOSEN world point (production channel)', () => {
    placementChosen.worldX = 1234.5;
    placementChosen.worldY = -678.25;
    placementChosen.stuck = true;

    commitChosenPlacement('capital');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('place_structure', {
      type: 'place_structure',
      kind: 'capital',
      x: 1234.5,
      y: -678.25,
    });
    // The dim pending ghost is recorded so it bridges the render gap (R2.1).
    expect(notePendingPlacement).toHaveBeenCalledWith('capital', 1234.5, -678.25);
  });

  it('falls back to ahead-of-ship only when the ghost was never positioned', () => {
    // placementChosen left null by resetPlacementChosen() in beforeEach.
    commitChosenPlacement('connector');

    const ahead = computePlacementPose({ x: 0, y: 0, angle: 0 }, 'connector');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('place_structure', {
      type: 'place_structure',
      kind: 'connector',
      x: ahead.x,
      y: ahead.y,
    });
  });
});

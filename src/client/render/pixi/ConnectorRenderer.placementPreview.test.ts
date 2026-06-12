/**
 * Connection-range PREVIEW lock (structures follow-up Item C, plan:
 * i-want-you-to-majestic-pie; Invariant #9/#13 — failing test FIRST).
 *
 * While the player positions a blueprint ghost (`mirror.pendingPlacementPreview`
 * set), the ConnectorRenderer draws preview lines from the ghost to the hubs it
 * WOULD connect to, using the SAME obstacle-aware `canConnect` the server runs
 * on placement. This test reads the REAL computed count the renderer publishes
 * (`placementPreviewConnectionCount`) — NOT a recompute (feedback-test-observable
 * lesson) — and asserts:
 *
 *   1. ghost in-range of a hub, asteroid OFF the segment  → count >= 1
 *   2. an asteroid sitting ON the only segment            → count === 0 (blocked,
 *      same as the server's obstacle-aware autoConnect)
 *   3. no preview (pendingPlacementPreview null)          → count === 0
 *
 * Before the feature exists this FAILS: `ConnectorRenderer` has no preview pass
 * and `placementPreviewConnectionCount` is undefined.
 *
 * Harness mirrors swarmSpriteUpdater.structureMounts.test.ts: a headless
 * RenderMirror + Pixi Graphics (no GL needed for `clear()`/`moveTo`/`stroke`).
 */
import { describe, it, expect } from 'vitest';
import { ConnectorRenderer } from './ConnectorRenderer.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import type {
  RenderMirror,
  SwarmRenderState,
  StructureRenderState,
} from '../../../core/contracts/IRenderer.js';

function structureEntry(shipKind: string, x: number, y: number): SwarmRenderState {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    angvel: 0,
    prevX: x,
    prevY: y,
    prevAngle: 0,
    prevArrivalMs: 0,
    latestArrivalMs: 0,
    poseRing: [],
    ringHead: 0,
    radius: getStructureKind(shipKind).radius,
    kind: 2,
    shipKind,
    sleeping: true,
    lastUpdateTick: 0,
  };
}

function asteroidEntry(x: number, y: number, radius: number): SwarmRenderState {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    angvel: 0,
    prevX: x,
    prevY: y,
    prevAngle: 0,
    prevArrivalMs: 0,
    latestArrivalMs: 0,
    poseRing: [],
    ringHead: 0,
    radius,
    kind: 0,
    sleeping: true,
    lastUpdateTick: 0,
  };
}

function structureState(over: Partial<StructureRenderState> = {}): StructureRenderState {
  return {
    powered: true,
    netPower: 50,
    connTo: [],
    built: true,
    buildPct: 1,
    deconstructPct: 0,
    ...over,
  };
}

describe('ConnectorRenderer — placement connection preview', () => {
  it('counts >= 1 when the ghost would connect to an in-range hub (asteroid off the segment)', () => {
    const capitalId = 1;
    const swarm = new Map<number, SwarmRenderState>([
      // Capital hub at origin (built, has a free slot).
      [capitalId, structureEntry('capital', 0, 0)],
      // Asteroid far off to the side — does NOT block the ghost→capital segment.
      [2, asteroidEntry(0, 5000, 40)],
    ]);
    const structures = new Map<number, StructureRenderState>([
      [capitalId, structureState({ connTo: [] })],
    ]);
    // Ghost connector 300 u above the capital (edge distance well within 600).
    const mirror: RenderMirror = {
      swarm,
      structures,
      pendingPlacementPreview: { kind: 'connector', x: 0, y: 300, angle: 0 },
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.placementPreviewConnectionCount).toBeGreaterThanOrEqual(1);
  });

  it('counts 0 when an asteroid sits ON the only ghost→hub segment (blocked, server-faithful)', () => {
    const capitalId = 1;
    const swarm = new Map<number, SwarmRenderState>([
      [capitalId, structureEntry('capital', 0, 0)],
      // Asteroid squarely between the ghost (0,300) and the capital (0,0).
      [2, asteroidEntry(0, 150, 60)],
    ]);
    const structures = new Map<number, StructureRenderState>([
      [capitalId, structureState({ connTo: [] })],
    ]);
    const mirror: RenderMirror = {
      swarm,
      structures,
      pendingPlacementPreview: { kind: 'connector', x: 0, y: 300, angle: 0 },
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.placementPreviewConnectionCount).toBe(0);
  });

  it('counts 0 when there is no placement preview', () => {
    const capitalId = 1;
    const swarm = new Map<number, SwarmRenderState>([[capitalId, structureEntry('capital', 0, 0)]]);
    const structures = new Map<number, StructureRenderState>([
      [capitalId, structureState({ connTo: [] })],
    ]);
    const mirror: RenderMirror = {
      swarm,
      structures,
      pendingPlacementPreview: null,
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.placementPreviewConnectionCount).toBe(0);
  });

  it('counts 0 when the only hub is out of range (ghost too far)', () => {
    const capitalId = 1;
    const swarm = new Map<number, SwarmRenderState>([[capitalId, structureEntry('capital', 0, 0)]]);
    const structures = new Map<number, StructureRenderState>([
      [capitalId, structureState({ connTo: [] })],
    ]);
    // 5000 u away — edge distance far beyond CONNECTION_MAX_RANGE (600).
    const mirror: RenderMirror = {
      swarm,
      structures,
      pendingPlacementPreview: { kind: 'connector', x: 0, y: 5000, angle: 0 },
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.placementPreviewConnectionCount).toBe(0);
  });

  it('caps green preview lines at 6 and classes the 7th+ as RED overflow (WS-5 R2.17)', () => {
    // 8 in-range, legal connector hubs around the ghost on distinct 45° angles
    // (radial spokes never cross another hub; edge distances well within 600).
    // The placement cap is PLACEMENT_MAX_CONNECTIONS = 6, so the preview must
    // class exactly 6 as green (counted) and the remaining 2 as overflow.
    const swarm = new Map<number, SwarmRenderState>();
    const structures = new Map<number, StructureRenderState>();
    const HUB_COUNT = 8;
    for (let i = 0; i < HUB_COUNT; i++) {
      const angle = (i / HUB_COUNT) * Math.PI * 2;
      const id = i + 1; // entityIds 1..8
      swarm.set(id, structureEntry('connector', Math.cos(angle) * 200, Math.sin(angle) * 200));
      structures.set(id, structureState({ connTo: [] }));
    }
    const mirror: RenderMirror = {
      swarm,
      structures,
      // Ghost connector at the origin — equidistant-ish to all 8 hubs, all legal.
      pendingPlacementPreview: { kind: 'connector', x: 0, y: 0, angle: 0 },
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    // Read the REAL published counts (not a recompute — feedback-test-observable
    // lesson): 6 green + 2 overflow.
    expect(r.placementPreviewConnectionCount).toBe(6);
    expect(r.placementPreviewOverflowCount).toBe(2);
  });

  // ── WS-10 (R2.3) — connection-range ring radius ──────────────────────────
  // The ring radius is the kind's per-kind connectionRange (capped at the
  // global 600) PLUS the ghost's own radius (centre-out reach to a zero-radius
  // partner edge). Reads the REAL renderer field, not a recompute.
  it('draws the range ring at the per-kind connectionRange + ghost radius (capital = 300+80)', () => {
    const swarm = new Map<number, SwarmRenderState>([[1, structureEntry('capital', 0, 0)]]);
    const structures = new Map<number, StructureRenderState>([[1, structureState({ connTo: [] })]]);
    const mirror: RenderMirror = {
      swarm,
      structures,
      // Capital has connectionRange 300 + radius 80.
      pendingPlacementPreview: { kind: 'capital', x: 0, y: 1000, angle: 0 },
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.lastRangeCircleRadius).toBe(300 + getStructureKind('capital').radius);
  });

  it('falls back to the global CONNECTION_MAX_RANGE (600) + radius for a kind with no per-kind range (solar = 600+40)', () => {
    const swarm = new Map<number, SwarmRenderState>([[1, structureEntry('capital', 0, 0)]]);
    const structures = new Map<number, StructureRenderState>([[1, structureState({ connTo: [] })]]);
    const mirror: RenderMirror = {
      swarm,
      structures,
      // Solar has no connectionRange → global 600 + radius 40.
      pendingPlacementPreview: { kind: 'solar', x: 0, y: 1000, angle: 0 },
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.lastRangeCircleRadius).toBe(600 + getStructureKind('solar').radius);
  });

  it('range ring radius is 0 when there is no placement preview', () => {
    const swarm = new Map<number, SwarmRenderState>([[1, structureEntry('capital', 0, 0)]]);
    const structures = new Map<number, StructureRenderState>([[1, structureState({ connTo: [] })]]);
    const mirror: RenderMirror = {
      swarm,
      structures,
      pendingPlacementPreview: null,
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.lastRangeCircleRadius).toBe(0);
  });

  it('no overflow when in-range hubs are at or below the 6 cap', () => {
    // 4 legal hubs → all green, zero overflow.
    const swarm = new Map<number, SwarmRenderState>();
    const structures = new Map<number, StructureRenderState>();
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2;
      const id = i + 1;
      swarm.set(id, structureEntry('connector', Math.cos(angle) * 200, Math.sin(angle) * 200));
      structures.set(id, structureState({ connTo: [] }));
    }
    const mirror: RenderMirror = {
      swarm,
      structures,
      pendingPlacementPreview: { kind: 'connector', x: 0, y: 0, angle: 0 },
    } as unknown as RenderMirror;

    const r = new ConnectorRenderer();
    r.update(mirror, 1, 0);

    expect(r.placementPreviewConnectionCount).toBe(4);
    expect(r.placementPreviewOverflowCount).toBe(0);
  });
});

/**
 * Minimum cable length in the build preview (owner: a too-short link still
 * DRAWS its line, stud to stud, red like other refused links, and the player
 * sees "Can't connect: too close" when it is the only link the ghost would
 * make). Reads the real preview pass, the same `canConnect` the server runs.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConnectorRenderer } from './ConnectorRenderer.js';
import { countPreviewRefusals } from './previewLinkRefusals.js';
import { showTooCloseHint, TOO_CLOSE_LINK_TEXT } from '../../structures/placementHints.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { CABLE_NO_SOCKET } from '../../../core/structures/cableCurve.js';
import { MIN_CABLE_LENGTH } from '../../../core/structures/structureGridConstants.js';
import type { RenderMirror, SwarmRenderState, StructureRenderState } from '../../../core/contracts/IRenderer.js';

function structureEntry(shipKind: string, x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0,
    latestArrivalMs: 0, poseRing: [], ringHead: 0, radius: getStructureKind(shipKind).radius,
    kind: 2, shipKind, sleeping: true, lastUpdateTick: 0,
  };
}
const built: StructureRenderState = { powered: true, netPower: 50, connTo: [], built: true, buildPct: 1, deconstructPct: 0 };

function mirrorWithGhostAt(gx: number): RenderMirror {
  return {
    swarm: new Map([[1, structureEntry('battery', 0, 0)]]),
    structures: new Map([[1, built]]),
    pendingPlacementPreview: { kind: 'connector', x: gx, y: 0, angle: 0 },
  } as unknown as RenderMirror;
}

describe('ConnectorRenderer: too-short preview link', () => {
  // Ghost connector centre for an edge gap `gap` east of the battery.
  const at = (gap: number): number => getStructureKind('battery').footprint.w / 2 + gap + getStructureKind('connector').footprint.w / 2;

  it('draws the refused line red stud to stud and raises the too-close message', () => {
    const r = new ConnectorRenderer();
    const draw = vi.spyOn(r as unknown as { drawPreviewSegment: (...a: unknown[]) => void }, 'drawPreviewSegment');
    r.update(mirrorWithGhostAt(at(10)), 1, 0);

    expect(r.placementPreviewConnectionCount).toBe(0);
    expect(r.previewVerdictCount).toBe(1);
    expect(r.previewVerdicts[0]!.reason).toBe('too-short');
    // One red ('blocked' style) segment between real studs, not centres.
    expect(draw).toHaveBeenCalledTimes(1);
    const [, , , sockA, , sockB, style] = draw.mock.calls[0]!;
    expect(style).toBe('blocked');
    expect(sockA).not.toBe(CABLE_NO_SOCKET);
    expect(sockB).not.toBe(CABLE_NO_SOCKET);
    // The message: the renderer's count (RendererFeedback.placementPreviewTooShortCount).
    const tooShort = countPreviewRefusals(r, 'too-short');
    expect(tooShort).toBe(1);
    expect(showTooCloseHint(r.placementPreviewConnectionCount, tooShort)).toBe(true);
    expect(TOO_CLOSE_LINK_TEXT).toBe("Can't connect: too close");
  });

  it('a ghost past the minimum links normally: no red line, no message', () => {
    const r = new ConnectorRenderer();
    const draw = vi.spyOn(r as unknown as { drawPreviewSegment: (...a: unknown[]) => void }, 'drawPreviewSegment');
    r.update(mirrorWithGhostAt(at(MIN_CABLE_LENGTH + 20)), 1, 0);
    expect(r.placementPreviewConnectionCount).toBe(1);
    expect(countPreviewRefusals(r, 'too-short')).toBe(0);
    for (const c of draw.mock.calls) expect(c[6]).not.toBe('blocked');
    expect(showTooCloseHint(r.placementPreviewConnectionCount, 0)).toBe(false);
  });

  it('no message while some other link still forms', () => {
    expect(showTooCloseHint(1, 2)).toBe(false);
    expect(showTooCloseHint(0, 0)).toBe(false);
  });
});

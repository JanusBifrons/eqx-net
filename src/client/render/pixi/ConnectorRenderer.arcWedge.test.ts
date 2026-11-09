/**
 * Coastal defences — the placement ghost draws a faint FIRING-ARC wedge for
 * each arc-limited mount (casemates), out to the weapon range; all-round guns
 * and non-gun kinds draw none. Reads the renderer's own test hooks.
 */
import { describe, it, expect } from 'vitest';
import { ConnectorRenderer } from './ConnectorRenderer.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import type { RenderMirror } from '../../../core/contracts/IRenderer.js';

function previewMirror(kind: string, angle = 0, pending = false): RenderMirror {
  return {
    swarm: new Map(),
    structures: new Map(),
    pendingPlacementPreview: { kind, x: 0, y: 0, angle, pending },
  } as unknown as RenderMirror;
}

describe('ConnectorRenderer — placement firing-arc wedge', () => {
  it('a 16" barbette ghost draws one wedge at its weapon range', () => {
    const r = new ConnectorRenderer();
    r.update(previewMirror('coastal_barbette_16in', Math.PI / 2), 1, 0);
    expect(r.lastArcWedgeCount).toBe(1);
    expect(r.lastArcWedgeRadius).toBe(getStructureKind('coastal_barbette_16in').weaponRange);
  });

  it('an all-round gun (5" DP) and a connector draw no wedge', () => {
    const r = new ConnectorRenderer();
    r.update(previewMirror('dp_mount_5in'), 1, 0);
    expect(r.lastArcWedgeCount).toBe(0);
    r.update(previewMirror('connector'), 1, 0);
    expect(r.lastArcWedgeCount).toBe(0);
  });

  it('the wedge clears with the preview and on a pending (committed) ghost', () => {
    const r = new ConnectorRenderer();
    r.update(previewMirror('coastal_casemate_8in'), 1, 0);
    expect(r.lastArcWedgeCount).toBe(1);
    r.update(previewMirror('coastal_casemate_8in', 0, true), 1, 0);
    expect(r.lastArcWedgeCount).toBe(0);
    r.update({ swarm: new Map(), structures: new Map() } as unknown as RenderMirror, 1, 0);
    expect(r.lastArcWedgeCount).toBe(0);
  });
});

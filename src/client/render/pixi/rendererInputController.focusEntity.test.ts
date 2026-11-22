/**
 * Contacts row tap (UI plan D10 T5): `focusEntity` focuses an entity by id
 * through the same `setFocus` path a map tap takes, so the left strip shows
 * it. Unlike a map re-tap it never toggles the focus off.
 */
import { describe, it, expect, vi } from 'vitest';
import { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { RenderMirror } from '@core/contracts/render/RenderMirror';

function setup(): RendererInputController {
  const feedback = { helmCourseSeq: 0, orderSeq: 0, placementConfirmSeq: 0, fleetSelSeq: 0 } as unknown as RendererFeedback;
  return new RendererInputController({
    camera: { screenToWorld: vi.fn() } as unknown as Camera,
    lastMirror: null as RenderMirror | null,
    galaxyLayer: null, feedback, selectionBracket: null, fleetOverlay: null,
  });
}

describe('RendererInputController.focusEntity', () => {
  it('focuses the entity, and a second call keeps it focused', () => {
    const ctl = setup();
    ctl.focusEntity('swarm-8', 'drone');
    expect(ctl._focusId).toBe('swarm-8');
    expect(ctl._focusKind).toBe('drone');
    ctl.focusEntity('swarm-8', 'drone');
    expect(ctl._focusId).toBe('swarm-8');
  });

  it('like a map tap (tap rule T2), my selected ships stay selected', () => {
    const ctl = setup();
    ctl.selectFleetShips(['ship-2']); // no mirror yet: kept as-is
    ctl.focusEntity('pilot-1', 'ship');
    expect([...ctl._selShips]).toEqual(['ship-2']);
    expect(ctl._focusId).toBe('pilot-1');
  });
});

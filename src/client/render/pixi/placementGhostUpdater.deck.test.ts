/**
 * Base platforms: on a deck room the placement ghost sits on its kind's deck
 * slot (the core `snapPlacementToDeck`, the same call the server's
 * `place_structure` handler makes; the wire parity is
 * `tests/unit/deckPlacementSnapParity.test.ts`) and draws the slot outline,
 * square to the deck whatever the ghost's turn and mirror.
 */
import { describe, it, expect } from 'vitest';
import { Container, Matrix } from 'pixi.js';
import { createPlacementGhostCtx, updatePlacementGhost } from './placementGhostUpdater.js';
import { snapPlacementToDeck } from '../../../core/structures/deckPlacement.js';
import type { DeckSnap } from '../../../core/hex/deckSnap.js';
import { DECK_HEX_FLAT, deckHexCentreInto, plateCentreWorldInto, plateHexes } from '../../../core/hex/plates.js';
import type { RenderMirror, RendererFeedback } from '../../../core/contracts/IRenderer.js';
import type { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera.js';

function harness(chosen: [number, number] | null) {
  const input = {
    _placementActive: false, _placementChosenX: chosen?.[0] ?? null, _placementChosenY: chosen?.[1] ?? null, _placementFollowing: true,
  } as unknown as RendererInputController;
  const feedback = { placementPreviewRejection: null } as unknown as RendererFeedback;
  const ctx = createPlacementGhostCtx({ isTouch: false, input, feedback });
  ctx.camera = { center: { x: 0, y: 0 }, toScreen: (x: number, y: number) => ({ x, y }) } as unknown as Camera;
  ctx.shipContainer = new Container();
  const mirror = (kind: string, x: number, y: number, deck: boolean, angle = 0, mirrored = false): RenderMirror => ({
    swarm: new Map(), structures: new Map(),
    pendingPlacementPreview: { kind, x, y, angle, deck, mirror: mirrored },
  }) as unknown as RenderMirror;
  return { ctx, feedback, input, mirror };
}

const snapOf = (kind: string, x: number, y: number): DeckSnap => snapPlacementToDeck(kind, x, y, { x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 });

describe('placement ghost on a deck room', () => {
  for (const [kind, x, y] of [['connector', 137, -412], ['reactor', -905, 333], ['teleporter_large', 2210, 1777]] as const) {
    it(`${kind}: the ghost and the chosen point sit on the deck slot`, () => {
      const { ctx, feedback, input, mirror } = harness([x, y]);
      updatePlacementGhost(mirror(kind, 0, 0, true), ctx);
      const s = snapOf(kind, x, y);
      expect(feedback.placementChosenWorldX).toBe(s.x);
      expect(feedback.placementChosenWorldY).toBe(s.y);
      expect(input._placementChosenX).toBe(s.x);
      expect(ctx.placementGhost!.x).toBe(s.x);
      expect(ctx.placementGhost!.y).toBeCloseTo(-s.y, 9);
    });
  }

  it('a small building ghost is drawn at the snap facing, live and pending (slice 18)', () => {
    const { ctx, mirror } = harness([137, -412]);
    // The player holds a 90° turn; the small slot overrides it.
    updatePlacementGhost(mirror('cargo_bay', 0, 0, true, Math.PI / 2), ctx);
    const s = snapPlacementToDeck('cargo_bay', 137, -412, { x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 }, 90);
    expect(s.slot).toBe('small');
    expect(s.rot).not.toBe(90);
    expect(ctx.placementGhost!.rotation).toBeCloseTo(-(s.rot * Math.PI) / 180, 9);
    // The sent (pending) ghost at the snapped point keeps the same facing.
    const m = mirror('cargo_bay', s.x, s.y, true, Math.PI / 2);
    m.pendingPlacementPreview!.pending = true;
    updatePlacementGhost(m, ctx);
    expect(ctx.placementGhost!.rotation).toBeCloseTo(-(s.rot * Math.PI) / 180, 9);
  });

  it('the ahead-of-ship pose (no chosen point) snaps too', () => {
    const { ctx, feedback, mirror } = harness(null);
    updatePlacementGhost(mirror('reactor', 501, -77, true), ctx);
    expect(feedback.placementChosenWorldX).toBe(snapOf('reactor', 501, -77).x);
  });

  it('deck off: no snap, no outline', () => {
    const { ctx, feedback, mirror } = harness([137, -412]);
    updatePlacementGhost(mirror('connector', 0, 0, false), ctx);
    expect(feedback.placementChosenWorldX).toBe(137);
    const slot = ctx.placementGhost!.children.find((c) => c !== ctx.placementGhost!.ahead && c !== ctx.placementGhost!.line);
    expect(slot === undefined || slot.visible === false).toBe(true);
  });

  it('the slot outline stays square to the deck under a turn and a mirror', () => {
    for (const [angle, mirrored] of [[0, false], [Math.PI / 2, false], [Math.PI, true], [-Math.PI / 2, true]] as const) {
      const { ctx, mirror } = harness([137, -412]);
      updatePlacementGhost(mirror('reactor', 0, 0, true, angle, mirrored), ctx);
      const g = ctx.placementGhost!;
      const slot = g.children[0]!;
      expect(slot.visible).toBe(true);
      // Compose ghost local × slot local: must be a pure translation.
      const m = new Matrix();
      m.copyFrom(g.localTransform).append(slot.localTransform);
      expect(m.a).toBeCloseTo(1, 9); expect(m.b).toBeCloseTo(0, 9);
      expect(m.c).toBeCloseTo(0, 9); expect(m.d).toBeCloseTo(1, 9);
    }
  });

  it('laying a plate: the Deck plate (connector) outlines the whole 7-hex plate wherever the pointer is', () => {
    const c = plateCentreWorldInto(1, 0, { x: 0, y: 0 });
    const ring = plateHexes(1, 0)[2]!, rp = deckHexCentreInto(ring.q, ring.r, { x: 0, y: 0 });
    const widthAt = (x: number, y: number): number => {
      const { ctx, mirror } = harness([x, y]);
      updatePlacementGhost(mirror('connector', 0, 0, true), ctx);
      const slot = ctx.placementGhost!.children[0]!;
      expect(slot.visible).toBe(true);
      return slot.getLocalBounds().width;
    };
    // The plate spans 5 hexes flat to flat (≈ 3 × 1300), from its middle hex or a ring hex alike.
    expect(widthAt(c.x + 200, c.y - 150)).toBeGreaterThan(3 * DECK_HEX_FLAT);
    expect(widthAt(rp.x + 200, rp.y - 150)).toBeGreaterThan(3 * DECK_HEX_FLAT);
  });
});

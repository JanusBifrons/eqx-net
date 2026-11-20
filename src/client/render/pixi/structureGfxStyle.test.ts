/**
 * The placement ghost and the no-art fallback draw `buildStructureGfx`. With a
 * structure style on (`?restyle=`, on by default with Machined art) they must
 * draw that style's plan, polygons included — before this the ghost of a
 * connector showed the old square hub while the placed one was a hexagon.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { buildStructureGfx } from './spriteBuilders.js';
import { buildStructureVisual } from './structureVisuals.js';
import { createPlacementGhostCtx, updatePlacementGhost } from './placementGhostUpdater.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { DEFAULT_STRUCT_STYLE } from '../art/artMode.js';
import type { RenderMirror, RendererFeedback } from '../../../core/contracts/IRenderer.js';
import type { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera.js';

type Instr = { action: string; data?: { path?: { shapePath?: { shapePrimitives?: { shape: { type?: string } }[] } } } };
const instructions = (g: { context: unknown }): Instr[] => (g.context as { instructions: Instr[] }).instructions;
const polyFills = (g: { context: unknown }): number =>
  instructions(g).filter((i) => i.action === 'fill' && i.data?.path?.shapePath?.shapePrimitives?.some((p) => p.shape.type === 'polygon')).length;

describe('buildStructureGfx with a structure style', () => {
  it('draws the styled plan polygons (the hex hub), not the old square plan', () => {
    const plan = buildStructureVisual('connector', { accent: getStructureKind('connector').color, seed: 1, omitSpans: true, style: DEFAULT_STRUCT_STYLE });
    expect((plan.polys ?? []).length).toBeGreaterThan(0);
    const styled = buildStructureGfx('connector', undefined, 1, DEFAULT_STRUCT_STYLE);
    expect(polyFills(styled)).toBe(plan.polys!.length);
    // Absent style: today's rect plan, no polygons.
    expect(polyFills(buildStructureGfx('connector'))).toBe(0);
  });

  it('the placement ghost uses the renderer\'s structure style', () => {
    const feedback = {} as RendererFeedback;
    const ctx = createPlacementGhostCtx({ isTouch: false, input: {} as RendererInputController, feedback });
    ctx.camera = { toScreen: () => ({ x: 0, y: 0 }) } as unknown as Camera;
    ctx.shipContainer = new Container();
    ctx.structStyle = DEFAULT_STRUCT_STYLE;
    const mirror = { pendingPlacementPreview: { kind: 'connector', x: 0, y: 0, angle: 0 } } as unknown as RenderMirror;
    updatePlacementGhost(mirror, ctx);
    expect(ctx.placementGhost).not.toBeNull();
    expect(polyFills(ctx.placementGhost!)).toBeGreaterThan(0);
  });
});

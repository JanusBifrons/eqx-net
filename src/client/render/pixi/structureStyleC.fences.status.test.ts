/**
 * Shield pylon and territory lock go dark unpowered (style C fences, live
 * body state): the same `BodyStatusHook` overlay as the dry reactor and the
 * battery cells. Powered = the baked lit art (nothing drawn over it);
 * unpowered = dead glass over every emitter / light; the bake never changes.
 */
import { describe, expect, it } from 'vitest';
import { Container, GraphicsContext } from 'pixi.js';
import { bodyStatusCode, hasBodyStatus, socketNubContext, socketNubsOf, updateSocketNubs } from './structureSocketNubs.js';
import { status } from './structureStyleC.fences.js';
import { getStructureKind, type StructureKindId } from '../../../shared-types/structureKinds.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

const EMIT_DEAD = 0x16262a;

function row(powered: boolean, built = true): StructureRenderState {
  return { powered, netPower: powered ? 1 : 0, connTo: [], connSockSelf: [], built, buildPct: built ? 1 : 0.2, deconstructPct: 0 };
}

/** Fill colours a hook draws for `code` (empty when it draws nothing). */
function fills(kind: StructureKindId, code: number): { colors: number[]; ctx: GraphicsContext } {
  const ctx = new GraphicsContext();
  status[kind]!.draw(ctx, code, kind);
  const colors = ctx.instructions
    .filter((i) => i.action === 'fill')
    .map((i) => (i.data as { style: { color: number } }).style.color);
  return { colors, ctx };
}

describe('fences: pylon and lock lights dark unpowered', () => {
  const KINDS = ['shield_pylon', 'territory_lock'] as const;

  it('both kinds have a body state', () => {
    for (const kind of KINDS) expect(hasBodyStatus(kind), kind).toBe(true);
  });

  it('powered is lit (code 0), built + unpowered is dark (1), a blueprint shows none', () => {
    for (const kind of KINDS) {
      expect(bodyStatusCode(kind, row(true)), kind).toBe(0);
      expect(bodyStatusCode(kind, row(false)), kind).toBe(1);
      expect(bodyStatusCode(kind, row(false, false)), kind).toBe(0);
      expect(bodyStatusCode(kind, undefined), kind).toBe(0);
    }
  });

  it('powered draws nothing over the lit bake; unpowered lays dead glass', () => {
    for (const kind of KINDS) {
      expect(fills(kind, 0).colors, kind).toEqual([]);
      const dark = fills(kind, 1).colors;
      expect(dark.length, kind).toBeGreaterThan(0);
      expect(dark, kind).toContain(EMIT_DEAD);
    }
  });

  it('the pylon goes dark only inside its emitter (the body is unchanged)', () => {
    const fp = getStructureKind('shield_pylon').footprint;
    const k = Math.min(fp.w, fp.h) / 120;
    const b = fills('shield_pylon', 1).ctx.bounds;
    // Inside the soot ring (r = 20 k): the collar, rivets and plinth are left.
    expect(b.maxX).toBeLessThanOrEqual(20 * k);
    expect(b.minX).toBeGreaterThanOrEqual(-20 * k);
    expect(b.maxX).toBeGreaterThanOrEqual(13 * k); // covers the whole lens
  });

  it('the lock darkens every light: fin heads out to the outer fins, slots and hub', () => {
    const fp = getStructureKind('territory_lock').footprint;
    const k = Math.min(fp.w / 400, fp.h / 300);
    const { colors, ctx } = fills('territory_lock', 1);
    expect(colors.length).toBe(12 + 2 + 1); // 12 fin heads, 2 tower slots, the hub
    expect(ctx.bounds.maxX).toBeGreaterThanOrEqual(172 * k);
    expect(ctx.bounds.minX).toBeLessThanOrEqual(-172 * k);
    expect(ctx.bounds.maxY).toBeGreaterThanOrEqual(112 * k); // the inner fins' heads
  });

  it('losing power swaps the shared overlay context; repowering swaps back (no re-bake)', () => {
    for (const kind of KINDS) {
      const s = new Container();
      updateSocketNubs(s, kind, row(true));
      const lit = socketNubsOf(s)!.context;
      updateSocketNubs(s, kind, row(false));
      expect(socketNubsOf(s)!.context, kind).toBe(socketNubContext(kind, 0, 1));
      expect(socketNubsOf(s)!.context, kind).not.toBe(lit);
      updateSocketNubs(s, kind, row(true));
      expect(socketNubsOf(s)!.context, kind).toBe(lit);
    }
  });
});

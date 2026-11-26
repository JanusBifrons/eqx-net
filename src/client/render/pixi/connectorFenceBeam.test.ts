/**
 * Base platforms slice 30 — the deck fence beam look (`?fenceLook=new`).
 * Which links draw as a shield beam is core `deckLinkKind` (fence post–post
 * on one seam, gate–post on the gate's seam end); plate anchor links,
 * anchor–post taps and building cables keep the cable. `old` (the default)
 * changes nothing.
 */
import { describe, it, expect } from 'vitest';
import { LinkCableCache } from './connectorCables.js';
import {
  DEFAULT_FENCE_LOOK, FENCE_BEAM_DOWN, FENCE_BEAM_GLOW, FENCE_BEAM_RAIL, drawFenceBeamBody, fenceBeamUp, isDeckFenceLink, readFenceLook,
} from './connectorFenceBeam.js';
import { cableLookWidth, type LinePath } from './connectorLineLooks.js';
import { SHIELD_WALL_CORE_COLOR, SHIELD_WALL_DOWN_COLOR, SHIELD_WALL_GLOW_COLOR } from './connectorVisual.js';
import { DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND } from '../../../core/structures/deckLinks.js';
import { hexCornerInto, HEX_DIRS } from '../../../core/hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto } from '../../../core/hex/plates.js';
import type { StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';

const pose = (kind: string, x: number, y: number): SwarmRenderState =>
  ({ x, y, angle: 0, radius: 40, shipKind: kind }) as unknown as SwarmRenderState;

/** Corner `i` of deck hex (q, r). */
function corner(q: number, r: number, i: number): { x: number; y: number } {
  const c = deckHexCentreInto(q, r, { x: 0, y: 0 });
  return hexCornerInto(c.x, c.y, DECK_HEX_SIZE, i, { x: 0, y: 0 });
}

const c0 = corner(0, 0, 0), c1 = corner(0, 0, 1), c3 = corner(0, 0, 3);
const postA = pose(DECK_FENCE_POST_KIND, c0.x, c0.y);
const postB = pose(DECK_FENCE_POST_KIND, c1.x, c1.y);
const postFar = pose(DECK_FENCE_POST_KIND, c3.x, c3.y);
const gate = pose(DECK_FENCE_GATE_KIND, (c0.x + c1.x) / 2, (c0.y + c1.y) / 2);
const anchor = pose('connector', 0, 0);
const d = HEX_DIRS[2]!;
const p = deckHexCentreInto(d.q, d.r, { x: 0, y: 0 });
const solar = pose('solar', p.x, p.y);

function cache(fenceBeams: boolean, deck = true): LinkCableCache {
  const c = new LinkCableCache();
  c.fenceBeams = fenceBeams;
  c.deck = deck;
  return c;
}

describe('?fenceLook= parse', () => {
  it('old by default; old|new read; anything else = the default', () => {
    expect(DEFAULT_FENCE_LOOK).toBe('old');
    expect(readFenceLook('')).toBe('old');
    expect(readFenceLook('?room=sector&fenceLook=new')).toBe('new');
    expect(readFenceLook('?fenceLook=old&deckTex=a')).toBe('old');
    expect(readFenceLook('?fenceLook=newer')).toBe('old');
    expect(readFenceLook('?xfenceLook=new')).toBe('old');
  });
});

describe('which links draw as a fence beam (new look, on a deck)', () => {
  const on = cache(true);
  it('a post–post seam link and a gate–post link do (either order)', () => {
    expect(isDeckFenceLink(postA, postB)).toBe(true);
    expect(on.isFenceBeam(postA, postB)).toBe(true);
    expect(on.isFenceBeam(postB, postA)).toBe(true);
    expect(on.isFenceBeam(gate, postA)).toBe(true);
    expect(on.isFenceBeam(postB, gate)).toBe(true);
  });

  it('plate anchor links, anchor–post taps, building cables and off-seam pairs never do', () => {
    expect(on.isFenceBeam(anchor, solar)).toBe(false);
    expect(on.isFenceBeam(anchor, postA)).toBe(false);
    expect(on.isFenceBeam(postA, anchor)).toBe(false);
    expect(on.isFenceBeam(solar, pose('solar', p.x + 200, p.y))).toBe(false);
    expect(on.isFenceBeam(postA, postFar)).toBe(false);
    expect(on.isFenceBeam(gate, postFar)).toBe(false);
  });

  it('old look (the default) and off-deck rooms change nothing', () => {
    expect(new LinkCableCache().fenceBeams).toBe(false);
    expect(cache(false).isFenceBeam(postA, postB)).toBe(false);
    expect(cache(false).isFenceBeam(gate, postA)).toBe(false);
    expect(cache(true, false).isFenceBeam(postA, postB)).toBe(false);
  });
});

/** Records strokes and path points. */
function recorder(): LinePath & { strokes: { color: number; alpha: number; width: number }[]; moves: number } {
  const r = {
    strokes: [] as { color: number; alpha: number; width: number }[], moves: 0,
    moveTo() { r.moves++; return r; }, lineTo() { return r; },
    stroke(s: { color: number; alpha: number; width: number }) { r.strokes.push({ ...s }); return r; },
  };
  return r as unknown as LinePath & typeof r;
}

describe('the fence beam body', () => {
  const row = (built: boolean, wallActive: boolean) => ({ built, wallActive }) as StructureRenderState;

  it('up: a shield-glow band + two shield-core rails (two strokes), at the cable width floor', () => {
    const g = recorder();
    const scale = 0.15;
    drawFenceBeamBody(g, 0, 0, 500, 0, scale, 40, 40, true);
    const w = cableLookWidth(scale);
    expect(g.strokes).toEqual([
      { color: SHIELD_WALL_GLOW_COLOR, alpha: 0.3, width: w * FENCE_BEAM_GLOW },
      { color: SHIELD_WALL_CORE_COLOR, alpha: 0.9, width: w * FENCE_BEAM_RAIL },
    ]);
    expect(g.moves).toBe(3);
    // Readable on a phone at the far zoom: rails >= 1 screen px, glow ~ 12 px.
    expect(w * FENCE_BEAM_RAIL * scale).toBeGreaterThanOrEqual(1);
  });

  it('down: one dim red line', () => {
    const g = recorder();
    drawFenceBeamBody(g, 0, 0, 500, 0, 1, 40, 40, false);
    expect(g.strokes).toEqual([{ color: SHIELD_WALL_DOWN_COLOR, alpha: 0.6, width: cableLookWidth(1) * FENCE_BEAM_DOWN }]);
  });

  it('a degenerate link draws nothing', () => {
    const g = recorder();
    drawFenceBeamBody(g, 5, 5, 5, 5, 1, 40, 40, true);
    expect(g.strokes).toHaveLength(0);
  });

  it('up only when both ends are built with their walls up (the derived walls rule)', () => {
    expect(fenceBeamUp(row(true, true), row(true, true))).toBe(true);
    expect(fenceBeamUp(row(true, true), row(true, false))).toBe(false);
    expect(fenceBeamUp(row(false, true), row(true, true))).toBe(false);
    expect(fenceBeamUp(row(true, true), undefined)).toBe(false);
  });
});

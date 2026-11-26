/**
 * Edge feel P2 mock-ups (`?edgeLook=a|b|c`): fence post + shield link looks.
 * Absent / unknown = `off` = today's draw calls, unchanged; each look rides
 * BOOT to the worker; the pylon's body-status code is today's under `off`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Container, GraphicsContext } from 'pixi.js';
import { DEFAULT_EDGE_LOOK, edgeLookIndex, edgeLookOfIndex, edgePost, readEdgeLook, type EdgeLook } from './connectorEdgeLook.js';
import { FENCE_BEAM_DOWN, FENCE_BEAM_GLOW, FENCE_BEAM_RAIL, drawFenceBeamBody } from './connectorFenceBeam.js';
import { cableLookWidth, type LinePath } from './connectorLineLooks.js';
import { LinkCableCache } from './connectorCables.js';
import { SHIELD_WALL_CORE_COLOR, SHIELD_WALL_DOWN_COLOR, SHIELD_WALL_GLOW_COLOR } from './connectorVisual.js';
import { pylonStatusCode, status } from './structureStyleC.fences.js';
import { applyRestyleLook, readRestyleLook } from './rendererSetup/restyleLook.js';
import { rendererArgsFromBoot } from '../worker/bootRenderer.js';
import type { MainToWorkerMsg } from '../worker/protocol.js';
import type { ArtOptions } from '../art/artMode.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

afterEach(() => { edgePost.look = DEFAULT_EDGE_LOOK; });

/** Records every draw call in order. */
function recorder(): LinePath & { calls: string[] } {
  const r = {
    calls: [] as string[],
    moveTo(x: number, y: number) { r.calls.push(`M${x.toFixed(2)},${y.toFixed(2)}`); return r; },
    lineTo(x: number, y: number) { r.calls.push(`L${x.toFixed(2)},${y.toFixed(2)}`); return r; },
    closePath() { r.calls.push('Z'); return r; },
    circle(x: number, y: number, rad: number) { r.calls.push(`C${x.toFixed(2)},${y.toFixed(2)},${rad.toFixed(2)}`); return r; },
    stroke(s: { color: number; alpha: number; width: number }) { r.calls.push(`S${s.color}:${s.alpha}:${s.width}`); return r; },
    fill(s: { color: number; alpha: number }) { r.calls.push(`F${s.color}:${s.alpha}`); return r; },
  };
  return r as unknown as LinePath & typeof r;
}

describe('?edgeLook= parse', () => {
  it('look A by default; off|a|b|c read; anything else = the default', () => {
    expect(DEFAULT_EDGE_LOOK).toBe('a');
    expect(readEdgeLook('')).toBe('a');
    expect(readEdgeLook('?edgeLook=off')).toBe('off');
    expect(readEdgeLook('?room=sector&edgeLook=a')).toBe('a');
    expect(readEdgeLook('?edgeLook=b&deckTex=a')).toBe('b');
    expect(readEdgeLook('?edgeLook=c')).toBe('c');
    expect(readEdgeLook('?edgeLook=d')).toBe('a');
    expect(readEdgeLook('?edgeLook=ab')).toBe('a');
    expect(readEdgeLook('?xedgeLook=off')).toBe('a');
    expect(readRestyleLook('?edgeLook=c').edgeLook).toBe('c');
    for (const l of ['off', 'a', 'b', 'c'] as EdgeLook[]) expect(edgeLookOfIndex(edgeLookIndex(l))).toBe(l);
  });
});

describe('the fence beam body under each look', () => {
  const scale = 0.15, w = cableLookWidth(scale);
  const today = [
    'M36.00,0.00', 'L464.00,0.00', `S${SHIELD_WALL_GLOW_COLOR}:0.3:${w * FENCE_BEAM_GLOW}`,
    `M36.00,${(w * 0.6).toFixed(2)}`, `L464.00,${(w * 0.6).toFixed(2)}`,
    `M36.00,${(-w * 0.6).toFixed(2)}`, `L464.00,${(-w * 0.6).toFixed(2)}`,
    `S${SHIELD_WALL_CORE_COLOR}:0.9:${w * FENCE_BEAM_RAIL}`,
  ];

  it('off (default arg and explicit) = today\'s draw calls exactly', () => {
    const a = recorder(), b = recorder();
    drawFenceBeamBody(a, 0, 0, 500, 0, scale, 40, 40, true);
    drawFenceBeamBody(b, 0, 0, 500, 0, scale, 40, 40, true, 'off');
    expect(a.calls).toEqual(today);
    expect(b.calls).toEqual(today);
    expect(new LinkCableCache().edgeLook).toBe('off');
  });

  it('a|b|c draw their own lit body; down stays today\'s one dim line', () => {
    const seen = new Set<string>();
    for (const look of ['a', 'b', 'c'] as EdgeLook[]) {
      const up = recorder();
      drawFenceBeamBody(up, 0, 0, 500, 0, scale, 40, 40, true, look);
      expect(up.calls.length).toBeGreaterThan(3);
      expect(up.calls).not.toEqual(today);
      expect(up.calls.some((c) => c.includes('NaN'))).toBe(false);
      seen.add(up.calls.join('|'));
      const down = recorder();
      drawFenceBeamBody(down, 0, 0, 500, 0, 1, 40, 40, false, look);
      expect(down.calls.filter((c) => c[0] === 'S')).toEqual([`S${SHIELD_WALL_DOWN_COLOR}:0.6:${cableLookWidth(1) * FENCE_BEAM_DOWN}`]);
    }
    expect(seen.size).toBe(3);
  });

  it('b caps its hex cells on a long link at a close zoom', () => {
    const g = recorder();
    drawFenceBeamBody(g, 0, 0, 100000, 0, 4, 40, 40, true, 'b');
    expect(g.calls.length).toBeLessThan(600);
  });
});

describe('the pylon emitter (body-status overlay)', () => {
  const row = (powered: boolean, built = true): StructureRenderState =>
    ({ powered, netPower: powered ? 1 : 0, connTo: [], built, buildPct: built ? 1 : 0.2, deconstructPct: 0 }) as unknown as StructureRenderState;

  it('off: today\'s codes (0 lit, 1 unpowered, 0 unbuilt)', () => {
    edgePost.look = 'off';
    expect(pylonStatusCode('shield_pylon', row(true))).toBe(0);
    expect(pylonStatusCode('shield_pylon', row(false))).toBe(1);
    expect(pylonStatusCode('shield_pylon', row(false, false))).toBe(0);
  });

  it('a|b|c: a distinct lit / dead code per look, each drawing an emitter', () => {
    const codes = new Set<number>();
    for (const look of ['a', 'b', 'c'] as EdgeLook[]) {
      edgePost.look = look;
      const lit = pylonStatusCode('shield_pylon', row(true)), dead = pylonStatusCode('shield_pylon', row(false));
      expect(lit).toBeGreaterThanOrEqual(2);
      expect(dead).toBe(lit + 1);
      expect(pylonStatusCode('shield_pylon', row(true, false))).toBe(0);
      codes.add(lit); codes.add(dead);
      for (const code of [lit, dead]) {
        const g = new GraphicsContext();
        status.shield_pylon!.draw(g, code, 'shield_pylon');
        expect(g.instructions.length).toBeGreaterThan(0);
      }
    }
    expect(codes.size).toBe(6);
  });
});

describe('edgeLook rides BOOT and init sets the beam + post look', () => {
  it('main-thread art → BOOT → worker art → cache + post look', () => {
    const art: ArtOptions = { mode: 'machined', ...readRestyleLook('?room=sector&edgeLook=b') };
    const boot = {
      type: 'BOOT', canvas: {} as unknown as OffscreenCanvas, width: 800, height: 600, dpr: 1, artMode: art.mode,
      ...(art.edgeLook !== undefined ? { edgeLook: art.edgeLook } : {}),
    } as Extract<MainToWorkerMsg, { type: 'BOOT' }>;
    const [, workerArt] = rendererArgsFromBoot(structuredClone(boot));
    expect(workerArt.edgeLook).toBe('b');
    const conn = { lineLook: null, cables: { fenceBeams: false, edgeLook: 'off' as EdgeLook } };
    applyRestyleLook(conn, {}, new Container(), workerArt, null);
    expect(conn.cables.edgeLook).toBe('b');
    expect(edgePost.look).toBe('b');
    applyRestyleLook(conn, {}, new Container(), { mode: 'machined' }, '');
    expect(conn.cables.edgeLook).toBe(DEFAULT_EDGE_LOOK);
    expect(edgePost.look).toBe(DEFAULT_EDGE_LOOK);
  });
});

/**
 * Structure restyle 1g — `?lineLook=pipe|cable|conduit` line looks on the
 * connector web. Locks: the flag parse, the default (no flag) still draws
 * today's single thin stroke per idle edge, and every look builds its static
 * body and per-frame flow without error.
 */
import { describe, expect, it } from 'vitest';
import { ConnectorRenderer } from './ConnectorRenderer.js';
import { LINE_LOOKS, lineLookScale, mixColor, readLineLook } from './connectorLineLooks.js';
import { CONNECTOR_IDLE_ALPHA, CONNECTOR_IDLE_COLOR } from './connectorVisual.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';

/** Three connector nodes in a row: edges 1–2 and 2–3. */
function row(flowing: boolean): RenderMirror {
  const swarm = new Map<number, SwarmRenderState>();
  const structures = new Map<number, StructureRenderState>();
  for (let i = 1; i <= 3; i++) {
    swarm.set(i, {
      x: (i - 2) * 400, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
      prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
      radius: 46, kind: 2, shipKind: 'connector', sleeping: true, lastUpdateTick: 0,
    } as unknown as SwarmRenderState);
    structures.set(i, { powered: true, netPower: 50, connTo: [], built: true, buildPct: 1, deconstructPct: 0, wallActive: false } as unknown as StructureRenderState);
  }
  structures.get(1)!.connTo.push(2);
  structures.get(2)!.connTo.push(1, 3);
  structures.get(3)!.connTo.push(2);
  const gridFlashes = flowing ? new Map([[1 * 65536 + 2, 1e12]]) : undefined;
  return { swarm, structures, gridFlashes } as unknown as RenderMirror;
}

interface Instr { action: string; data: { style: { color: number; alpha: number; width: number } } }
const instructions = (g: { context: unknown }): Instr[] => (g.context as { instructions: Instr[] }).instructions;

describe('readLineLook (structure restyle 1g)', () => {
  it('parses the three looks and nothing else', () => {
    expect(readLineLook('?lineLook=pipe')).toBe('pipe');
    expect(readLineLook('?style=machined&lineLook=cable&dpr=1')).toBe('cable');
    expect(readLineLook('&lineLook=conduit')).toBe('conduit');
    expect(readLineLook('')).toBeNull();
    expect(readLineLook('?lineLook=')).toBeNull();
    expect(readLineLook('?lineLook=rope')).toBeNull();
    expect(readLineLook('?lineLook=piped')).toBeNull();
    expect(readLineLook('?xlineLook=pipe')).toBeNull();
  });

  it('blends colours and floors the size when zoomed out', () => {
    expect(mixColor(0x000000, 0xffffff, 0)).toBe(0);
    expect(mixColor(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(lineLookScale('pipe', 1)).toBe(1);
    expect(lineLookScale('pipe', 0.05)).toBeGreaterThan(1);
  });
});

describe('ConnectorRenderer line looks (structure restyle 1g)', () => {
  it('default (no flag) draws one thin idle stroke per edge, as before', () => {
    const r = new ConnectorRenderer();
    expect(r.lineLook).toBeNull();
    r.update(row(false), 0.5, 0);
    const strokes = instructions(r.staticGfx).filter((i) => i.action === 'stroke');
    expect(strokes).toHaveLength(2);
    for (const s of strokes) {
      expect(s.data.style.color).toBe(CONNECTOR_IDLE_COLOR);
      expect(s.data.style.alpha).toBeCloseTo(CONNECTOR_IDLE_ALPHA);
      expect(s.data.style.width).toBe(2); // max(1 / 0.5, 1)
    }
  });

  it('default flowing edge keeps glow + core + comet on the per-frame layer', () => {
    const r = new ConnectorRenderer();
    r.update(row(true), 0.5, 100);
    expect(instructions(r.gfx).filter((i) => i.action === 'stroke')).toHaveLength(3);
  });

  for (const look of LINE_LOOKS) {
    it(`${look}: builds a richer static body and a per-frame flow`, () => {
      const r = new ConnectorRenderer();
      r.lineLook = look;
      expect(() => r.update(row(true), 0.5, 100)).not.toThrow();
      const body = instructions(r.staticGfx).filter((i) => i.action === 'stroke');
      expect(body.length).toBeGreaterThan(2 * 3);
      for (const s of body) {
        expect(Number.isFinite(s.data.style.width) && s.data.style.width > 0).toBe(true);
      }
      expect(instructions(r.gfx).filter((i) => i.action === 'stroke').length).toBeGreaterThan(0);
      // Idle web: no flow drawn per frame.
      const idle = new ConnectorRenderer();
      idle.lineLook = look;
      idle.update(row(false), 0.05, 0);
      expect(instructions(idle.gfx).filter((i) => i.action === 'stroke')).toHaveLength(0);
      expect(instructions(idle.staticGfx).length).toBeGreaterThan(0);
    });
  }

  /** Stroke-sequence digest of one look's static body + flow (idle and flowing). */
  function digest(look: 'pipe' | 'conduit'): string {
    const out: string[] = [];
    for (const [flowing, scale] of [[false, 0.5], [true, 0.5], [false, 0.05]] as const) {
      const r = new ConnectorRenderer();
      r.lineLook = look;
      r.update(row(flowing), scale, 100);
      for (const g of [r.staticGfx, r.gfx]) {
        for (const i of instructions(g)) {
          if (i.action !== 'stroke') continue;
          const s = i.data.style;
          out.push(`${s.color.toString(16)}/${s.alpha.toFixed(4)}/${s.width.toFixed(4)}`);
        }
      }
    }
    return out.join(' ');
  }

  it('pipe and conduit strokes are unchanged by the cable upgrade (1i)', () => {
    expect(digest('pipe')).toMatchSnapshot();
    expect(digest('conduit')).toMatchSnapshot();
  });
});

describe('cable look upgrade (structure restyle 1i)', () => {
  it('builds at every zoom: shadow, cradles, strands, lashings, collars, flow', () => {
    for (const scale of [0.02, 0.05, 0.2, 0.5, 1, 2]) {
      const r = new ConnectorRenderer();
      r.lineLook = 'cable';
      expect(() => r.update(row(true), scale, 100)).not.toThrow();
      const body = instructions(r.staticGfx).filter((i) => i.action === 'stroke');
      for (const s of body) {
        expect(Number.isFinite(s.data.style.width) && s.data.style.width > 0).toBe(true);
        expect(Number.isFinite(s.data.style.alpha)).toBe(true);
      }
      const flow = instructions(r.gfx).filter((i) => i.action === 'stroke');
      expect(flow.length).toBeGreaterThanOrEqual(3); // bleed, lit core, band
    }
  });

  it('a long run gets cradles, lashings and collars; the body is much heavier than the old 7 strokes', () => {
    const r = new ConnectorRenderer();
    r.lineLook = 'cable';
    r.update(row(false), 0.5, 0);
    const perEdge = instructions(r.staticGfx).filter((i) => i.action === 'stroke').length / 2;
    // 2 shadows + 6 cradle + 9 strand + 2 lashing + 4 clamp + 4 collar.
    expect(perEdge).toBe(27);
    // The bundle is wider on screen than the old cable (~12 world units).
    const widest = Math.max(...instructions(r.staticGfx).filter((i) => i.action === 'stroke').map((i) => i.data.style.width));
    expect(widest).toBeGreaterThan(16);
  });

  it('a run too short for stations still draws strands, no stations', () => {
    const mirror = row(false);
    for (const [id, s] of (mirror.swarm as Map<number, SwarmRenderState>)) (s as { x: number }).x = (id - 2) * 30;
    const r = new ConnectorRenderer();
    r.lineLook = 'cable';
    r.update(mirror, 0.5, 0);
    const perEdge = instructions(r.staticGfx).filter((i) => i.action === 'stroke').length / 2;
    expect(perEdge).toBe(1 + 9);
  });
});

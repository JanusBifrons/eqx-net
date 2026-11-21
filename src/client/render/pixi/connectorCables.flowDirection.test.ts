/**
 * Owner report 2026-11-21: the socket cable's flow runs FROM the source TO
 * the receiver, and its colour is the resource it carries.
 *
 *  - Direction: once the first comet has arrived, the train kept being
 *    drawn from `leadCometArc`, which slid BACKWARD (receiver -> source) as
 *    game time advanced. Every comet must move away from the source at the
 *    material's speed, on every frame, for a source at either end.
 *  - Colour: comets, sparks and the collar flash were one gold for every
 *    material; they now wear the material's colour (lightened), the glow the
 *    material colour, and an idle link (no flow) keeps the idle colour.
 */
import { describe, expect, it } from 'vitest';
import { drawSocketCableFlow, fillStraight, flowTrainInto, leadCometArc, makeLinkCable, type FlowTrain } from './connectorCables.js';
import {
  CONNECTOR_CONSTRUCTION_COLOR, CONNECTOR_FLOW_PULSE_COLOR, CONNECTOR_IDLE_COLOR, CONNECTOR_MINERAL_COLOR,
  CONNECTOR_POWER_COLOR, CONNECTOR_REPAIR_COLOR, connectorVisualInto, flowMaterialColor, flowPulseColor,
  type ConnectorFlowMaterial, type ConnectorVisual,
} from './connectorVisual.js';
import { cableLookWidth, cablePulseWidth, type LinePath } from './connectorLineLooks.js';

class FakePath {
  readonly paths: Array<{ pts: number[]; color: number; alpha: number; width: number }> = [];
  private pts: number[] = [];
  moveTo(x: number, y: number): this { this.pts.push(NaN, NaN, x, y); return this; }
  lineTo(x: number, y: number): this { this.pts.push(x, y); return this; }
  stroke(s: { color: number; alpha: number; width: number }): this { this.paths.push({ pts: this.pts, color: s.color, alpha: s.alpha, width: s.width }); this.pts = []; return this; }
  clear(): void { this.paths.length = 0; }
  get g(): LinePath { return this as unknown as LinePath; }
}

function subPaths(pts: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < pts.length; i += 2) {
    if (Number.isNaN(pts[i]!)) out.push([]);
    else out[out.length - 1]!.push(pts[i]!, pts[i + 1]!);
  }
  return out;
}

const blank = (): ConnectorVisual => ({ color: 0, alpha: 0, width: 0, glowAlpha: 0, glowWidth: 0 });
function flowing(material: ConnectorFlowMaterial): ConnectorVisual {
  return connectorVisualInto(blank(), 1e12, 1e12, 1, 0, material);
}

const MATERIALS: ConnectorFlowMaterial[] = ['minerals', 'repair', 'construction', 'power'];

describe('flow runs from the source to the receiver (owner report 2026-11-21)', () => {
  it('the lead comet only ever moves forward, before and after the first arrival', () => {
    const len = 400;
    const t: FlowTrain = { speed: 0, spacing: 0, d: 0 };
    const dt = 16;
    for (const m of MATERIALS) {
      let prev = leadCometArc(flowTrainInto(t, len, 0, m), len);
      for (let e = dt; e < 20_000; e += dt) {
        const s = leadCometArc(flowTrainInto(t, len, e, m), len);
        const step = s - prev;
        // Forward by speed*dt, or (a comet left at the receiver) the next one
        // behind it, a spacing back, forward by the same step.
        const fwd = (t.speed * dt) / 1000;
        const ok = Math.abs(step - fwd) < 1e-6 || Math.abs(step - (fwd - t.spacing)) < 1e-6;
        if (!ok) throw new Error(`${m} at ${e} ms: lead moved ${step}, want ${fwd} (or ${fwd - t.spacing})`);
        prev = s;
      }
    }
  });

  for (const sourceIsLo of [true, false]) {
    it(`every comet travels toward the receiver over time (source at the ${sourceIsLo ? 'first' : 'last'} point)`, () => {
      const c = makeLinkCable();
      fillStraight(c, 0, 0, 600, 0);
      c.socketed = true;
      const v = flowing('minerals');
      const comets = (f: FakePath): number[] => {
        const s = f.paths.find((p) => p.width === cablePulseWidth(1));
        return s ? subPaths(s.pts).map((sp) => (sp[0]! + sp[sp.length - 2]!) / 2) : [];
      };
      const f = new FakePath();
      const dt = 20;
      let prev: number[] = [];
      let checked = 0;
      for (let now = 1000; now < 9000; now += dt) {
        f.clear();
        drawSocketCableFlow(f.g, c, v, sourceIsLo, 1, now, 'minerals');
        const cur = comets(f);
        const step = (flowTrainInto({ speed: 0, spacing: 0, d: 0 }, 600, 0, 'minerals').speed * dt) / 1000;
        const dir = sourceIsLo ? 1 : -1;
        for (const x of cur) {
          // Only comets well inside the cable (not clipped at an end).
          if (x < 40 || x > 560) continue;
          const from = x - dir * step;
          expect(prev.some((p) => Math.abs(p - from) < 0.5), `comet at ${x} came from ${from} (t=${now})`).toBe(true);
          checked++;
        }
        prev = cur;
      }
      expect(checked).toBeGreaterThan(100);
    });
  }

  it('the collar flash fires at the receiving end (source = last point -> flash at the first)', () => {
    const c = makeLinkCable();
    fillStraight(c, 0, 0, 600, 0);
    c.socketed = true;
    const v = flowing('repair');
    const w = cableLookWidth(1);
    const f = new FakePath();
    let seen = 0;
    for (let now = 0; now < 8000; now += 10) {
      f.clear();
      drawSocketCableFlow(f.g, c, v, false, 1, now, 'repair');
      const flash = f.paths.filter((p) => p.color === v.color && p.width === w * 1.4);
      for (const p of flash) {
        const [bar] = subPaths(p.pts);
        expect(bar![0]!).toBeLessThan(60); // at A (x = 0), never at B (x = 600)
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('cable colour = the resource it carries (owner report 2026-11-21)', () => {
  it('maps each material to its palette colour; no material = the idle colour', () => {
    expect(flowMaterialColor('minerals')).toBe(CONNECTOR_MINERAL_COLOR);
    expect(flowMaterialColor('repair')).toBe(CONNECTOR_REPAIR_COLOR);
    expect(flowMaterialColor('construction')).toBe(CONNECTOR_CONSTRUCTION_COLOR);
    expect(flowMaterialColor('power')).toBe(CONNECTOR_POWER_COLOR);
    expect(flowMaterialColor(undefined)).toBe(CONNECTOR_IDLE_COLOR);
    // Pulses are the material's colour lightened: distinct per material, never the shared gold.
    const pulses = new Set(MATERIALS.map(flowPulseColor));
    expect(pulses.size).toBe(MATERIALS.length);
    expect(pulses.has(CONNECTOR_FLOW_PULSE_COLOR)).toBe(false);
  });

  it('an idle link keeps the idle colour', () => {
    const v = connectorVisualInto(blank(), 0, 1000, 1, 0, 'repair');
    expect(v.color).toBe(CONNECTOR_IDLE_COLOR);
  });

  for (const m of MATERIALS) {
    it(`a flowing ${m} link draws its glow, comets and flash in the ${m} colour`, () => {
      const c = makeLinkCable();
      fillStraight(c, 0, 0, 600, 0);
      c.socketed = true;
      const v = flowing(m);
      expect(v.color).toBe(flowMaterialColor(m));
      expect(v.pulseColor).toBe(flowPulseColor(m));
      const f = new FakePath();
      const colours = new Set<number>();
      for (let now = 0; now < 6000; now += 50) {
        f.clear();
        drawSocketCableFlow(f.g, c, v, true, 1, now, m);
        for (const p of f.paths) colours.add(p.color);
      }
      expect([...colours].sort()).toEqual([flowMaterialColor(m), flowPulseColor(m)].sort());
    });
  }
});

/**
 * Time scale (#20): a `grid_pulse` lights its connector for one pulse window of
 * GAME time on the renderer's own clock (`fxNow`), at every sector speed. The
 * old handler stamped `until` on the network (wall) clock while the renderer
 * read it against `fxNow`, so at 0.5x a flash lingered and at 2x it never showed.
 * Drives the real stamp (handler) + read (ConnectorRenderer) path.
 */
import { describe, expect, it } from 'vitest';
import type { Room } from 'colyseus.js';
import { registerGridPulseHandlers } from './gridPulseHandlers.js';
import { ConnectorRenderer } from '../../render/pixi/ConnectorRenderer.js';
import { GameClock } from '../../../core/clock/GameClock.js';
import { TRANSFER_PULSE_MS } from '../../../core/structures/structureGridConstants.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';

/** Two connected connector nodes (edge 1-2), nothing flowing yet. */
function pair(): RenderMirror {
  const swarm = new Map<number, SwarmRenderState>();
  const structures = new Map<number, StructureRenderState>();
  for (let i = 1; i <= 2; i++) {
    swarm.set(i, {
      x: (i - 1.5) * 400, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
      prevX: 0, prevY: 0, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
      radius: 46, kind: 2, shipKind: 'connector', sleeping: true, lastUpdateTick: 0,
    } as unknown as SwarmRenderState);
    structures.set(i, { powered: true, netPower: 50, connTo: [3 - i], built: true, buildPct: 1, deconstructPct: 0, wallActive: false } as unknown as StructureRenderState);
  }
  return { swarm, structures } as unknown as RenderMirror;
}

/** Strokes on the per-frame layer: 3 (glow, core, comet) while flowing, 0 idle. */
const flowStrokes = (r: ConnectorRenderer): number =>
  (r.gfx.context as unknown as { instructions: { action: string }[] }).instructions.filter((i) => i.action === 'stroke').length;

function rig(speed: number) {
  let wall = 10_000;
  const fx = new GameClock(() => wall); // the renderer's presentation clock
  wall += 10_000;
  fx.setScale(speed);
  wall += 10_000; // game time has now drifted from wall time
  const mirror = pair();
  let onPulse: ((msg: unknown) => void) | null = null;
  const room = { onMessage: (type: string, cb: (msg: unknown) => void) => { if (type === 'grid_pulse') onPulse = cb; } } as unknown as Room;
  // `now` is the wall clock the old handler stamped with; the fix ignores it.
  const ctx = { mirror, now: () => wall };
  registerGridPulseHandlers(room, ctx);
  const r = new ConnectorRenderer();
  return {
    pulse: () => onPulse!({ flashed: [[1, 2, 'power']] }),
    /** Advance `gameMs` of game time (gameMs / speed of wall) and draw a frame. */
    frame: (gameMs: number): number => { wall += gameMs / speed; r.update(mirror, 0.5, fx.now()); return flowStrokes(r); },
  };
}

describe('grid pulse flashes follow the sector time scale (#20)', () => {
  for (const speed of [0.5, 2]) {
    it(`${speed}x: lit for one pulse window of game time, then idle`, () => {
      const t = rig(speed);
      expect(t.frame(0)).toBe(0); // nothing flowing before the pulse
      t.pulse();
      expect(t.frame(0)).toBe(3); // lit the frame it arrives
      expect(t.frame(TRANSFER_PULSE_MS * 0.9)).toBe(3); // still lit inside the window (game ms 900)
      expect(t.frame(TRANSFER_PULSE_MS * 0.5)).toBe(3); // 1400: past the window, inside the 600 ms jitter grace
      expect(t.frame(TRANSFER_PULSE_MS * 0.3)).toBe(0); // 1700: idle once flow stops (window + grace)
    });

    it(`${speed}x: a steady 1 Hz game-time pulse reads as continuous flow`, () => {
      const t = rig(speed);
      for (let n = 0; n < 6; n++) {
        t.pulse();
        for (let k = 0; k < 4; k++) expect(t.frame(TRANSFER_PULSE_MS / 4)).toBe(3);
      }
    });
  }
});

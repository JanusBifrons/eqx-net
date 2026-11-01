import { describe, expect, it } from 'vitest';
import { ScriptedPathBehaviour } from './ScriptedPathBehaviour.js';
import type { AiWorldView } from '../contracts/IAiBehaviour.js';

const VIEW = {} as AiWorldView;

/** Integrate a unit-mass point with light damping under the behaviour. */
function simulate(b: ScriptedPathBehaviour, ticks: number, mass = 2, damping = 0.02) {
  const s = { id: 'd', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  const xs: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const it = b.tick(s, VIEW);
    s.vx = (s.vx + it.fx / mass) * (1 - damping);
    s.vy = (s.vy + it.fy / mass) * (1 - damping);
    s.x += s.vx / 60;
    s.y += s.vy / 60;
    xs.push(s.x);
  }
  return { s, xs };
}

describe('ScriptedPathBehaviour', () => {
  it('holds roughly the scripted speed toward the far waypoint', () => {
    const b = new ScriptedPathBehaviour({ from: { x: 0, y: 0 }, to: { x: 5000, y: 0 }, speed: 300 }, 2);
    const { s } = simulate(b, 120);
    expect(s.vx).toBeGreaterThan(240);
    expect(s.vx).toBeLessThan(330);
    expect(Math.abs(s.vy)).toBeLessThan(1);
  });

  it('ping-pongs between the waypoints when looping', () => {
    const b = new ScriptedPathBehaviour({ from: { x: 0, y: 0 }, to: { x: 600, y: 0 }, speed: 300 }, 2);
    const { xs } = simulate(b, 60 * 8);
    expect(Math.max(...xs)).toBeGreaterThan(540);
    expect(xs[xs.length - 1]!).toBeLessThan(Math.max(...xs)); // came back
  });

  it('stops at the end when not looping', () => {
    const b = new ScriptedPathBehaviour({ from: { x: 0, y: 0 }, to: { x: 300, y: 0 }, speed: 300, loop: false }, 2);
    const { s } = simulate(b, 60 * 6);
    expect(Math.abs(s.x - 300)).toBeLessThan(60);
    expect(Math.abs(s.vx)).toBeLessThan(20);
  });

  it('never fires', () => {
    const b = new ScriptedPathBehaviour({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, speed: 100 }, 2);
    expect(b.tick({ id: 'd', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 }, VIEW).fire).toBeUndefined();
  });
});

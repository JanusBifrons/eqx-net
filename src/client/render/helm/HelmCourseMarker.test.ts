/**
 * Helm move marker, renderer side (owner 2026-11-12: "It says tap and it
 * sets a course, yet no visible indicator of where and what was tapped?").
 * A green RTS-style move icon at `mirror.helmCourse`: drawn at the course
 * point's screen position, a fixed pixel size at any zoom, a brief pop on
 * each new tap, hidden when the mirror carries no course.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { Camera } from '../worker/Camera';

vi.mock('pixi.js', () => {
  class FakeContainer {
    x = 0; y = 0; rotation = 0; alpha = 1; visible = true; eventMode = 'auto';
    parent: FakeContainer | null = null;
    children: FakeContainer[] = [];
    scale = { x: 1, y: 1, set(v: number, w?: number): void { this.x = v; this.y = w ?? v; } };
    addChild(...cs: FakeContainer[]): FakeContainer { for (const c of cs) { c.parent = this; this.children.push(c); } return cs[0]!; }
    removeChild(c: FakeContainer): void { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
    destroy(): void { /* noop */ }
  }
  class FakeGraphics extends FakeContainer {}
  for (const m of ['clear', 'circle', 'fill', 'stroke', 'moveTo', 'lineTo', 'closePath', 'poly']) {
    (FakeGraphics.prototype as unknown as Record<string, unknown>)[m] = function (this: unknown) { return this; };
  }
  return { Container: FakeContainer, Graphics: FakeGraphics };
});

const { HelmCourseMarker, helmMarkerLook, HELM_POP_MS, HELM_STEADY_ALPHA } = await import('./HelmCourseMarker.js');
const { Container } = await import('pixi.js');

const W = 1280, H = 720;
function fakeCamera(scale: number): Camera {
  const stage = new Container();
  return {
    parent: stage,
    scale: { x: scale, y: scale },
    toScreenInto(wx: number, wy: number, out: { x: number; y: number }) { out.x = W / 2 + wx * scale; out.y = H / 2 + wy * scale; },
  } as unknown as Camera;
}

function mirror(course: { x: number; y: number; seq: number } | null): RenderMirror {
  return { ships: new Map(), localPlayerId: 'me', helmCourse: course } as RenderMirror;
}

describe('helmMarkerLook', () => {
  it('pops big and bright on the tap, then settles to a steady subtle marker', () => {
    const out = { scale: 0, alpha: 0, ripple: 0, rippleAlpha: 0 };
    helmMarkerLook(0, out);
    expect(out.scale).toBeGreaterThan(1.3);
    expect(out.alpha).toBe(1);
    expect(out.rippleAlpha).toBeGreaterThan(0.5);
    helmMarkerLook(HELM_POP_MS * 2, out);
    expect(out.scale).toBe(1);
    expect(out.alpha).toBe(HELM_STEADY_ALPHA);
    expect(out.rippleAlpha).toBe(0);
  });
});

describe('HelmCourseMarker', () => {
  it('draws at the course point on screen, hidden with no course', () => {
    const m = new HelmCourseMarker();
    m.init(fakeCamera(0.1));
    m.update(mirror(null), 0);
    expect(m.isVisible()).toBe(false);
    m.update(mirror({ x: 1000, y: 2000, seq: 1 }), 0);
    expect(m.isVisible()).toBe(true);
    // Game Y-up → pixi Y-down: screen y = H/2 - gameY * scale.
    expect(m.container.children[0]!.x).toBeCloseTo(W / 2 + 100);
    expect(m.container.children[0]!.y).toBeCloseTo(H / 2 - 200);
    m.update(mirror(null), 10);
    expect(m.isVisible()).toBe(false);
  });

  it('keeps one on-screen size at any zoom (capitals zoom far out)', () => {
    const near = new HelmCourseMarker(); near.init(fakeCamera(1));
    const far = new HelmCourseMarker(); far.init(fakeCamera(0.01));
    near.update(mirror({ x: 0, y: 0, seq: 1 }), 0);
    far.update(mirror({ x: 0, y: 0, seq: 1 }), 0);
    near.update(mirror({ x: 0, y: 0, seq: 1 }), 5000);
    far.update(mirror({ x: 0, y: 0, seq: 1 }), 5000);
    expect(far.container.children[0]!.scale.x).toBe(near.container.children[0]!.scale.x);
  });

  it('replays the pop on each new tap (seq change), not on the same order', () => {
    const m = new HelmCourseMarker(); m.init(fakeCamera(0.1));
    m.update(mirror({ x: 0, y: 0, seq: 1 }), 0);
    m.update(mirror({ x: 0, y: 0, seq: 1 }), 5000);
    const root = m.container.children[0]!;
    expect(root.scale.x).toBe(1);
    m.update(mirror({ x: 50, y: 50, seq: 2 }), 5001);
    expect(root.scale.x).toBeGreaterThan(1.3);
  });
});

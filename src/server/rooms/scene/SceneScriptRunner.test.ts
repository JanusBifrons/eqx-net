import { describe, it, expect } from 'vitest';
import { SceneScriptRunner, SceneScriptSchema, scenePoint, expandRepeats, type SceneHooks } from './SceneScriptRunner';

function harness(capacity = Infinity): { hooks: SceneHooks; spawned: Array<{ id: string; x: number; y: number; warpIn: boolean }>; hostile: string[] } {
  const spawned: Array<{ id: string; x: number; y: number; warpIn: boolean }> = [];
  const hostile: string[] = [];
  return {
    spawned, hostile,
    hooks: {
      spawn: (id, _k, x, y, warpIn) => { if (spawned.length >= capacity) return false; spawned.push({ id, x, y, warpIn }); return true; },
      markHostileToAll: (id) => { hostile.push(id); },
    },
  };
}

const ticksFor = (ms: number): number => Math.ceil(ms / (1000 / 60));

describe('SceneScriptRunner', () => {
  const script = SceneScriptSchema.parse([
    { atMs: 5000, action: 'spawn', tag: 'raid', kind: 'fighter', count: 40, x: 1000, y: 0, spread: 300, warpIn: true, hostile: true },
    { atMs: 0, action: 'spawn', tag: 'home', kind: 'robot-square', count: 3, x: 0, y: 0 },
    { atMs: 20_000, action: 'end' },
  ]);

  it('does nothing until started, then plays each step when it is due (sorted by time)', () => {
    const h = harness();
    const r = new SceneScriptRunner(script, h.hooks);
    r.tick(100);
    expect(h.spawned).toHaveLength(0);
    r.start(100);
    r.tick(100);
    expect(h.spawned.map((s) => s.id)).toEqual(['scene-home-0', 'scene-home-1', 'scene-home-2']);
    r.tick(100 + ticksFor(5000) - 2);
    expect(h.spawned).toHaveLength(3);
    r.tick(100 + ticksFor(5000));
    expect(h.spawned).toHaveLength(43);
    expect(h.spawned[3]!.warpIn).toBe(true);
    expect(h.hostile).toHaveLength(40);
    expect(r.getStatus().ended).toBe(false);
    r.tick(100 + ticksFor(20_000));
    expect(r.getStatus()).toMatchObject({ ended: true, played: 3, spawned: 43, refused: 0 });
  });

  it('places ships the same way every run, inside the spread', () => {
    const a = harness(), b = harness();
    for (const h of [a, b]) { const r = new SceneScriptRunner(script, h.hooks); r.start(0); r.tick(ticksFor(5000)); }
    expect(a.spawned).toEqual(b.spawned);
    for (const s of a.spawned.slice(3)) expect(Math.hypot(s.x - 1000, s.y)).toBeLessThanOrEqual(300);
  });

  it('counts refused spawns (a full slot pool makes the run invalid)', () => {
    const h = harness(10);
    const r = new SceneScriptRunner(script, h.hooks);
    r.start(0);
    r.tick(ticksFor(5000));
    expect(r.getStatus()).toMatchObject({ spawned: 10, refused: 33 });
  });

  it('start is idempotent (a second pilot does not restart the clock)', () => {
    const h = harness();
    const r = new SceneScriptRunner(script, h.hooks);
    r.start(0);
    r.start(1000);
    r.tick(ticksFor(5000));
    expect(h.spawned).toHaveLength(43);
  });

  it('rejects bad scripts', () => {
    expect(SceneScriptSchema.safeParse([]).success).toBe(false);
    expect(SceneScriptSchema.safeParse([{ atMs: 0, action: 'spawn', tag: 'x', kind: 'nope', count: 1, x: 0, y: 0 }]).success).toBe(false);
    expect(SceneScriptSchema.safeParse([{ atMs: 0, action: 'spawn', tag: 'x', kind: 'fighter', count: 65, x: 0, y: 0 }]).success).toBe(false);
    expect(SceneScriptSchema.safeParse([{ atMs: 0, action: 'spawn', tag: 'Bad Tag', kind: 'fighter', count: 1, x: 0, y: 0 }]).success).toBe(false);
    expect(SceneScriptSchema.safeParse([{ atMs: 0, action: 'end', extra: 1 }]).success).toBe(false);
  });

  it('scenePoint spreads a single ship to the centre', () => {
    const p = { x: 9, y: 9 };
    scenePoint(0, 1, 500, p);
    expect(p).toEqual({ x: 0, y: 0 });
  });

  it('a repeating spawn plays every repeatEveryMs until repeatUntilMs, each with its own tag', () => {
    const script = SceneScriptSchema.parse([
      { atMs: 0, action: 'spawn', tag: 'blue', kind: 'fighter', count: 2, x: 0, y: 0, repeatEveryMs: 10_000, repeatUntilMs: 30_000 },
      { atMs: 40_000, action: 'end' },
    ]);
    expect(expandRepeats(script).map((s) => [s.atMs, s.action === 'spawn' ? s.tag : 'end'])).toEqual([[0, 'blue'], [10_000, 'blue-r1'], [20_000, 'blue-r2'], [40_000, 'end']]);
    const h = harness();
    const r = new SceneScriptRunner(script, h.hooks);
    r.start(0);
    r.tick(ticksFor(25_000));
    expect(h.spawned.map((s) => s.id)).toEqual(['scene-blue-0', 'scene-blue-1', 'scene-blue-r1-0', 'scene-blue-r1-1', 'scene-blue-r2-0', 'scene-blue-r2-1']);
  });

  it('the soak scene stays inside the 64-entry seed guard and reinforces for its whole 10 minutes', async () => {
    const { perfSceneById } = await import('../../../shared-types/perf/perfScenes.js');
    const soak = perfSceneById('fleet-fight-soak')!;
    expect(soak.room.sceneScript.length).toBeLessThanOrEqual(64);
    const steps = expandRepeats(SceneScriptSchema.parse(soak.room.sceneScript));
    expect(steps.filter((s) => s.action === 'spawn')).toHaveLength(120);
    expect(soak.soak).toBe(true);
    expect(soak.room['subcapWrecks']).toBe(true);
  });
});

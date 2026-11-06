/**
 * Scene script — a timed list of world events for a test room (perf scenes,
 * plan prancy-squishing-donut P1).
 *
 * Rooms could only seed at creation; a perf scene needs things to HAPPEN at a
 * known time ("40 ships warp in beside the base at t = 5 s"). The room passes
 * `sceneScript` (testMode only); the runner starts when the first pilot is
 * ready and plays each step on the server tick, so A and B arms of a perf run
 * see the same scene.
 *
 * Actions:
 *  - `spawn`: `count` ships of `kind` in a deterministic disc (`spread`) at
 *    (x, y), ids `scene-<tag>-<i>`. `warpIn` shows the warp-in effect (the
 *    teleport-raid case). `hostile` marks them hostile to every pilot.
 *    Mixed allegiances (drones vs robots) fight each other on sight, so a
 *    fleet fight needs no extra order.
 *  - `end`: the scene is over (the measurement window closes).
 */
import type { ShipKindId } from '../../../shared-types/shipKinds.js';
import type { SceneStep } from '../../../shared-types/perf/sceneScript.js';
export { SceneScriptSchema, SceneStepSchema, SCENE_MAX_SPAWN, type SceneStep } from '../../../shared-types/perf/sceneScript.js';

export interface SceneHooks {
  /** Spawn one ship. `warpIn` ⇒ the warp-in effect + broadcast grace. */
  spawn(id: string, kind: ShipKindId, x: number, y: number, warpIn: boolean): boolean;
  /** Mark a ship hostile to every pilot present. */
  markHostileToAll(id: string): void;
}

export interface SceneStatus {
  started: boolean;
  /** Steps played so far. */
  played: number;
  ended: boolean;
  spawned: number;
  /** Spawns refused (slot pool full). A non-zero value makes the run invalid. */
  refused: number;
  /** Ms since the scene started (0 before). */
  elapsedMs: number;
}

const TICK_MS = 1000 / 60;

/** Deterministic disc placement: a sunflower spiral, no RNG. */
export function scenePoint(i: number, count: number, spread: number, out: { x: number; y: number }): void {
  if (count <= 1 || spread <= 0) { out.x = 0; out.y = 0; return; }
  const r = spread * Math.sqrt((i + 0.5) / count);
  const a = i * 2.399963229728653; // golden angle
  out.x = Math.cos(a) * r;
  out.y = Math.sin(a) * r;
}

export class SceneScriptRunner {
  private readonly steps: SceneStep[];
  private startTick = -1;
  private next = 0;
  private readonly status: SceneStatus = { started: false, played: 0, ended: false, spawned: 0, refused: 0, elapsedMs: 0 };
  private readonly pt = { x: 0, y: 0 };

  constructor(script: readonly SceneStep[], private readonly hooks: SceneHooks) {
    this.steps = [...script].sort((a, b) => a.atMs - b.atMs);
  }

  /** Start the clock (first pilot ready). Idempotent. */
  start(tick: number): void {
    if (this.startTick >= 0) return;
    this.startTick = tick;
    this.status.started = true;
  }

  /** Play every step that is due. Called once per server tick. */
  tick(tick: number): void {
    if (this.startTick < 0 || this.status.ended) return;
    const elapsedMs = (tick - this.startTick) * TICK_MS;
    this.status.elapsedMs = elapsedMs;
    while (this.next < this.steps.length && this.steps[this.next]!.atMs <= elapsedMs) {
      this.play(this.steps[this.next]!);
      this.next++;
      this.status.played = this.next;
    }
  }

  getStatus(): Readonly<SceneStatus> { return this.status; }

  private play(step: SceneStep): void {
    if (step.action === 'end') { this.status.ended = true; return; }
    const spread = step.spread ?? 0;
    for (let i = 0; i < step.count; i++) {
      scenePoint(i, step.count, spread, this.pt);
      const id = `scene-${step.tag}-${i}`;
      if (!this.hooks.spawn(id, step.kind as ShipKindId, step.x + this.pt.x, step.y + this.pt.y, step.warpIn === true)) {
        this.status.refused++;
        continue;
      }
      this.status.spawned++;
      if (step.hostile) this.hooks.markHostileToAll(id);
    }
  }
}

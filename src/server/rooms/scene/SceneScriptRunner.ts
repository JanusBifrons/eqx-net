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
 *  - `fleet`: `count` PARKED hulls owned by the first pilot (roster rows +
 *    lingering hulls), each flown by its wingman brain in `mode` / `stance`
 *    (the RTS fleet scene). Refused without a pilot.
 *  - `rocks` / `rockCut`: still rocks `scene-<tag>-<i>`, then each mined to
 *    a break through the mining laser's real wear path (rock-cut scene).
 *  - `move`: fly a scene ship nose-first to a point and stop there.
 *  - `rigClip`: start a rig clip on a structure (articulation sandbox).
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
  /** `fleet` step: one PARKED hull owned by the first pilot, AI-flown by its
   *  wingman brain. False = refused (no pilot, roster full, no slot). */
  ownedHull?(kind: ShipKindId, x: number, y: number, opts: SceneFleetOpts): boolean;
  /** `rocks` step: one still rock. False = refused (no slot). */
  spawnRock?(id: string, x: number, y: number, radius: number): boolean;
  /** `rockCut` step: mine rock `id` to a break. False = no break (refused). */
  cutRock?(id: string): boolean;
  /** `move` step: fly ship `id` to (x, y) at `speed`, nose first, then stop.
   *  False = no such ship. */
  moveShip?(id: string, x: number, y: number, speed: number): boolean;
  /** `rigClip` step: start `clip` (null = rest) on the first structure of
   *  `kind`. False = refused (no such structure / clip / target). */
  rigClip?(kind: string, clip: string | null, target: SceneRigTarget): boolean;
}

/** Where a `rigClip` step's target comes from (see `SceneStep` rigClip). */
export type SceneRigTarget =
  | { readonly from: 'none' }
  | { readonly from: 'ship'; readonly id: string }
  | { readonly from: 'keep' }
  | { readonly from: 'tip' };

export interface SceneFleetOpts {
  mode: 'defend' | 'hunt';
  stance: 'aggressive' | 'defensive' | 'holdFire';
  /** Hit points (null = the kind's max). */
  health: number | null;
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

/** A spawn step with `repeatEveryMs` becomes one step per repeat (built once,
 *  at room creation): repeat k is due at `atMs + k * repeatEveryMs`, while
 *  that is before `repeatUntilMs`, tagged `<tag>-r<k>`. */
export function expandRepeats(script: readonly SceneStep[]): SceneStep[] {
  const out: SceneStep[] = [];
  for (const s of script) {
    out.push(s);
    if (s.action !== 'spawn' || s.repeatEveryMs === undefined || s.repeatUntilMs === undefined) continue;
    for (let k = 1, t = s.atMs + s.repeatEveryMs; t < s.repeatUntilMs; k++, t += s.repeatEveryMs) {
      out.push({ ...s, atMs: t, tag: `${s.tag}-r${k}`, repeatEveryMs: undefined, repeatUntilMs: undefined });
    }
  }
  return out;
}

export class SceneScriptRunner {
  private readonly steps: SceneStep[];
  private startTick = -1;
  private next = 0;
  private readonly status: SceneStatus = { started: false, played: 0, ended: false, spawned: 0, refused: 0, elapsedMs: 0 };
  private readonly pt = { x: 0, y: 0 };

  constructor(script: readonly SceneStep[], private readonly hooks: SceneHooks) {
    this.steps = expandRepeats(script).sort((a, b) => a.atMs - b.atMs);
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
    if (step.action === 'move') {
      const ok = this.hooks.moveShip?.(`scene-${step.tag}-${step.index ?? 0}`, step.x, step.y, step.speed) ?? false;
      if (ok) this.status.spawned++; else this.status.refused++;
      return;
    }
    if (step.action === 'rigClip') {
      const target: SceneRigTarget = step.targetShip !== undefined ? { from: 'ship', id: `scene-${step.targetShip}-0` }
        : step.keepTarget === true ? { from: 'keep' }
          : step.fromTip === true ? { from: 'tip' } : { from: 'none' };
      if (this.hooks.rigClip?.(step.structure, step.clip, target) ?? false) this.status.spawned++; else this.status.refused++;
      return;
    }
    if (step.action === 'rockCut') {
      for (let i = 0; i < step.count; i++) {
        if (this.hooks.cutRock?.(`scene-${step.tag}-${i}`) ?? false) this.status.spawned++; else this.status.refused++;
      }
      return;
    }
    const spread = step.spread ?? 0;
    if (step.action === 'rocks') {
      for (let i = 0; i < step.count; i++) {
        scenePoint(i, step.count, spread, this.pt);
        const ok = this.hooks.spawnRock?.(`scene-${step.tag}-${i}`, step.x + this.pt.x, step.y + this.pt.y, step.radius) ?? false;
        if (ok) this.status.spawned++; else this.status.refused++;
      }
      return;
    }
    if (step.action === 'fleet') {
      const opts: SceneFleetOpts = { mode: step.mode ?? 'defend', stance: step.stance ?? 'defensive', health: step.health ?? null };
      for (let i = 0; i < step.count; i++) {
        scenePoint(i, step.count, spread, this.pt);
        const ok = this.hooks.ownedHull?.(step.kind as ShipKindId, step.x + this.pt.x, step.y + this.pt.y, opts) ?? false;
        if (ok) this.status.spawned++; else this.status.refused++;
      }
      return;
    }
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

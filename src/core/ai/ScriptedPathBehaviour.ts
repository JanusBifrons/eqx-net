/**
 * Scripted-path drone AI — flies a straight line between two waypoints at a
 * fixed speed, optionally ping-ponging forever. ENGINEERING / TEST ONLY: drives
 * the `radar-sandbox` room's "ships flying into and out of range" scenarios
 * (plan sparkling-wondering-rose) deterministically, with no combat AI.
 *
 * Velocity tracking: each tick the linear impulse closes a fraction of the gap
 * between the current and the desired velocity, scaled by the body's mass
 * (impulse = mass · Δv), so it holds the scripted speed against the kind's
 * linear damping without oscillating. Never fires. Server-only (the client has
 * no drone brain — drones are snapshot-interpolated), so there is no lockstep
 * surface.
 */
import type { AiEntity, AiIntent, AiWorldView, IAiBehaviour } from '../contracts/IAiBehaviour.js';

export interface ScriptedPath {
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** World units per second. */
  speed: number;
  /** Ping-pong between the waypoints forever (default true). */
  loop?: boolean;
}

/** Fraction of the velocity error corrected per tick. */
const VELOCITY_GAIN = 0.25;
/** Within this distance (u) of a waypoint the drone turns around / stops. */
const ARRIVE_EPS = 30;

export class ScriptedPathBehaviour implements IAiBehaviour {
  private headingToEnd = true;
  private readonly intent: AiIntent = { fx: 0, fy: 0, torque: 0 };

  constructor(private readonly path: ScriptedPath, private readonly mass: number) {}

  tick(self: AiEntity, _view: AiWorldView): AiIntent {
    const loop = this.path.loop ?? true;
    let target = this.headingToEnd ? this.path.to : this.path.from;
    let dx = target.x - self.x;
    let dy = target.y - self.y;
    let d = Math.hypot(dx, dy);
    if (d < ARRIVE_EPS) {
      if (loop) {
        this.headingToEnd = !this.headingToEnd;
        target = this.headingToEnd ? this.path.to : this.path.from;
        dx = target.x - self.x;
        dy = target.y - self.y;
        d = Math.hypot(dx, dy);
      } else {
        d = 0;
      }
    }
    const speed = d > 0 ? this.path.speed : 0;
    const vxDes = d > 0 ? (dx / d) * speed : 0;
    const vyDes = d > 0 ? (dy / d) * speed : 0;
    this.intent.fx = this.mass * (vxDes - self.vx) * VELOCITY_GAIN;
    this.intent.fy = this.mass * (vyDes - self.vy) * VELOCITY_GAIN;
    this.intent.torque = 0;
    return this.intent;
  }
}

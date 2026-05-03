/**
 * AI behaviour contract — pure logic, zero zone awareness.
 *
 * `tick()` is called once per server tick per swarm entity. It receives a
 * read-only world view (player positions injected by the server) and returns
 * an intent: an impulse / torque to apply this step, plus an optional fire
 * request that the server resolves through the existing weapon path.
 *
 * Behaviours never construct Rapier objects, never read globals, and never
 * import server or client code — they are deterministic functions of their
 * arguments. Authority over physics and projectiles stays with the server.
 */

export interface AiPlayerView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/**
 * Read-only snapshot the AI controller hands to each behaviour. Behaviours
 * may not retain references past the call — the server may reuse the array.
 */
export interface AiWorldView {
  /** Live, alive players. Empty when none are present. */
  readonly players: ReadonlyArray<AiPlayerView>;
  /** Current server tick. Behaviours use this for cooldowns. */
  readonly tick: number;
  readonly dtSec: number;
}

/** The AI's own pose for this tick. */
export interface AiEntity {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly angvel: number;
}

/**
 * The intent a behaviour produces each tick. Linear impulse and torque are
 * applied to the rigid body in the worker (same path as player INPUT).
 *
 * `fire`, when present, asks the server to fire a hitscan in `(dirX, dirY)`
 * direction on this entity's behalf. The server resolves it through the
 * existing `handleFire` lag-comp path with an `ai-` prefixed shot id.
 */
export interface AiIntent {
  fx: number;
  fy: number;
  torque: number;
  fire?: { dirX: number; dirY: number };
}

export interface IAiBehaviour {
  tick(self: AiEntity, view: AiWorldView): AiIntent;
}

/** Returns the nearest player to (x, y), or null when no players are present. */
export function nearestPlayer(view: AiWorldView, x: number, y: number): AiPlayerView | null {
  let best: AiPlayerView | null = null;
  let bestD2 = Infinity;
  for (const p of view.players) {
    const dx = p.x - x;
    const dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}

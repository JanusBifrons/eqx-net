/**
 * Failure isolation for a pooled physics worker (`worker.ts`).
 *
 * One worker hosts several sector worlds. Before this, an exception from any
 * one world (a Rapier WASM panic, "RuntimeError: unreachable", thrown out of
 * `stepWithEvents`) was uncaught, so the worker exited and EVERY sector on it
 * lost physics for good. Now the worker catches the throw per world, drops
 * only that world and reports `WORLD_FAILED` with the ids its most recent
 * commands touched, so the cause can be traced from the log.
 *
 * The failed world is dropped, not freed: after a panic its Rapier objects
 * are still borrowed on the WASM side and a `free()` can throw again.
 */
import type { WorkerCommand } from './workerCommands.js';

/** How many recent commands a world remembers for a failure report. */
export const RECENT_COMMANDS = 48;

/**
 * Fixed ring of the last commands' type and entity id. `note` stores two
 * string references in preallocated arrays: no allocation on the per-command
 * path (#14). `dump` allocates, but only on a failure.
 */
export class RecentCommands {
  private readonly types: string[] = new Array<string>(RECENT_COMMANDS).fill('');
  private readonly ids: string[] = new Array<string>(RECENT_COMMANDS).fill('');
  private next = 0;
  private count = 0;

  note(cmd: WorkerCommand): void {
    if (cmd.type === 'INPUT' || cmd.type === 'AI_INPUTS' || cmd.type === 'BATCH') return; // high rate or a wrapper (its parts are noted)
    const c = cmd as { playerId?: string; obstacleId?: string; entityId?: string; id?: string; oldId?: string };
    this.types[this.next] = cmd.type;
    this.ids[this.next] = c.obstacleId ?? c.playerId ?? c.entityId ?? c.id ?? c.oldId ?? '';
    this.next = (this.next + 1) % RECENT_COMMANDS;
    if (this.count < RECENT_COMMANDS) this.count++;
  }

  /** Oldest first, as `TYPE id` strings. */
  dump(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.count; i++) {
      const k = (this.next - this.count + i + RECENT_COMMANDS) % RECENT_COMMANDS;
      out.push(this.ids[k] ? `${this.types[k]} ${this.ids[k]}` : this.types[k]!);
    }
    return out;
  }
}

/** The `WORLD_FAILED` message a worker posts for a world it dropped. */
export interface WorldFailedMsg {
  type: 'WORLD_FAILED';
  worldId: number;
  /** `step` (thrown while stepping) or `command` (thrown handling a command). */
  phase: 'step' | 'command';
  errMessage: string;
  errStack: string;
  /** The world's physics tick when it failed. */
  tick: number;
  /** The world's latest commands, oldest first (`TYPE id`). */
  recent: string[];
}

export function worldFailedMsg(worldId: number, phase: 'step' | 'command', err: unknown, tick: number, recent: RecentCommands): WorldFailedMsg {
  const e = err as { message?: unknown; stack?: unknown } | null;
  return {
    type: 'WORLD_FAILED',
    worldId,
    phase,
    errMessage: typeof e?.message === 'string' ? e.message : String(err),
    errStack: typeof e?.stack === 'string' ? e.stack : '',
    tick,
    recent: recent.dump(),
  };
}

/**
 * Impact bursts for capital naval shells.
 *
 * Since shells-as-events slice 4 every naval shell is drawn from its salvo,
 * and its burst comes ONLY from its `shell_end`: `ShellSalvoStore.place()`
 * queues `[x, y, shellRadius]` into `mirror.pendingShellEnds` when the display
 * clock reaches the hit. A shell that misses ends silently (no `shell_end`),
 * and a shell that merely leaves this viewer's interest never bursts: the old
 * "it disappeared, so it hit" guess (and its false edge burst) is gone
 * (docs/architecture/shell-events.md).
 *
 * Everything here is GAME space (Y up): the points go straight to
 * `FxExplosions.spawn`, which flips Y itself. Never hand it `-y`: that drew
 * the burst at the shell's vertical mirror about y = 0 (capital-guns-fighter
 * review 2026-11-10: the fireball ~380 px straight above the fighter hit).
 *
 * No per-frame allocation (invariant #14).
 */
import { shellImpactRadius } from './turretFx.js';

/** Where a burst goes: `FxExplosions` (game-space input). */
export interface ShellBurstSink {
  spawn(x: number, y: number, r: number, nowMs: number): boolean;
}

export class NavalShellBursts {
  /** One frame: burst every `[x, y, shellRadius]` triple in `ends` (game
   *  space; the one-frame `mirror.pendingShellEnds` queue). */
  frame(sink: ShellBurstSink | null, nowMs: number, ends?: readonly number[]): void {
    if (!ends || !sink) return;
    for (let i = 0; i + 2 < ends.length; i += 3) {
      sink.spawn(ends[i]!, ends[i + 1]!, shellImpactRadius(ends[i + 2]!), nowMs);
    }
  }
}

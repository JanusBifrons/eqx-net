/**
 * Game time scale (time scale stream) — this sector's speed: the chosen
 * (forced) speed, the automatic load slowdown, the dimmer glide and the
 * snapshot keyframe. Moved verbatim out of `SectorRoom`; the room hands in
 * live accessors. The load window and the slew run in the room tick (#14):
 * nothing here allocates per tick.
 */
import type { Logger } from 'pino';
import type { TimeScaleKeyframe } from '../../../shared-types/messages.js';
import { clampTimeScale, type GameClock } from '../../../core/clock/GameClock.js';
import { LoadSpeedController } from '../../../core/clock/LoadSpeedController.js';
import { glideToward } from '../../../shared-types/timeScale.js';
import type { TickBudgetTelemetry } from '../TickBudgetTelemetry.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';

/** What the sector's time scale needs from the room; getters read the live field. */
export interface SectorTimeScaleHost {
  gameClock: Pick<GameClock, 'scale' | 'setScale'>;
  tickBudget: Pick<TickBudgetTelemetry, 'windowSeq' | 'lateness'>;
  perfFixedLoad(): boolean;
  roomId(): string;
  sectorKey(): string | null;
  logger: Pick<Logger, 'info'>;
}

export class SectorTimeScale {
  constructor(private readonly h: SectorTimeScaleHost) {}

  /**
   * Set this sector's game speed (time scale stream; clamped 0.25–4). Its
   * clock re-anchors, the physics world and the room loop follow, and the
   * snapshot carries the keyframe while the speed isn't 1. Returns the speed
   * now in force. Test/recording triggers and `POST /dev/time-scale`.
   */
  setTimeScale(scale: number, smooth = false): number {
    const from = this.targetTimeScale();
    this.chosenTimeScale = clampTimeScale(scale);
    this.noteTimeScaleTarget('forced', from);
    // Setup speeds (room/join option, env, tests) apply at once; `smooth`
    // glides there like a dimmer (the dev endpoint's default).
    if (!smooth) this.h.gameClock.setScale(this.targetTimeScale());
    return this.targetTimeScale();
  }

  /** Where the sector's speed is heading: chosen × the load factor. */
  private targetTimeScale(): number {
    return clampTimeScale(this.chosenTimeScale * this.loadFactor);
  }
  private lastSlewAtMs = -1;

  /**
   * The dimmer: each update, glide the sector clock toward its target at
   * the shared `glideToward` (a steady ratio: one doubling or halving per wall
   * second), so a slowdown or a
   * speed change eases in rather than lurching (owner 2026-11-12: "a dial like
   * a dimmer"). Clients follow each small step through the snapshot keyframe
   * on their eased anchor path.
   */
  slewTimeScale(nowMs: number): void {
    const dt = this.lastSlewAtMs < 0 ? 0 : Math.min(100, nowMs - this.lastSlewAtMs);
    this.lastSlewAtMs = nowMs;
    const tgt = this.targetTimeScale();
    const cur = this.h.gameClock.scale;
    if (cur !== tgt) this.h.gameClock.setScale(glideToward(cur, tgt, dt / 1000));
    // The keyframe carries the glide's target so clients glide in step (#15).
    this.timeScaleKey.t = this.h.gameClock.scale === tgt ? undefined : tgt;
  }

  /** The sector's chosen speed (1×, or a forced demo/test speed): the ceiling
   *  the automatic slowdown works under. */
  private chosenTimeScale = 1;
  /** The automatic slowdown's factor, [0.7, 1] (Phase 5). Read by the room
   *  (`state.clockRate`, perf scenes); set only here. */
  loadFactor = 1;
  private readonly loadSpeed = new LoadSpeedController();
  /** Whether the automatic slowdown runs here. On in real sectors; test rooms
   *  opt in with `autoTimeScale: true`. A slow CI runner otherwise slows every
   *  test room's WHOLE game (timers, pulses, spools), not just its physics as
   *  the old TiDi did, and shifts every test's timing (12 feature specs timed
   *  out on CI before this gate). */
  autoSlowdown = true;
  private lastLoadWindowSeq = 0;

  /**
   * Game time scale, Phase 5: the automatic slowdown. Once per telemetry
   * window, lateness (game time behind real time) + the cost rate set a
   * load factor; the sector's whole game (its clock, loop, physics world and
   * clients) runs at chosen × factor. This REPLACES the old TiDi path that
   * slowed only the physics worker (CLOCK_RATE), which clients saw as
   * jitter, not slow motion (docs/SHELF.md).
   */
  applyLoadWindow(newRate: number): void {
    if (this.autoSlowdown && !this.h.perfFixedLoad() && this.h.tickBudget.windowSeq !== this.lastLoadWindowSeq) {
      this.lastLoadWindowSeq = this.h.tickBudget.windowSeq;
      const l = this.h.tickBudget.lateness();
      const f = this.loadSpeed.window(l.latenessTicks, l.wallTicks, newRate);
      if (f !== this.loadFactor) {
        const from = this.targetTimeScale();
        this.loadFactor = f;
        this.noteTimeScaleTarget('load', from, l.wallTicks > 0 ? Math.round((100 * Math.max(0, l.latenessTicks)) / l.wallTicks) : 0);
      }
    }
  }

  /** Log + audit a change of the sector's TARGET speed (not each slew step). */
  private noteTimeScaleTarget(reason: 'load' | 'forced', from: number, latenessPct?: number): void {
    const to = this.targetTimeScale();
    if (to === from) return;
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    const sectorKey = this.h.sectorKey();
    this.h.logger.info({ roomId: this.h.roomId(), sectorKey, from: r2(from), to: r2(to), reason, latenessPct }, 'time scale changed');
    auditEvent({ event: 'time_scale_changed', sector: sectorKey ?? undefined, from: r2(from), to: r2(to), reason, ...(latenessPct !== undefined ? { latenessPct } : {}) });
  }

  /** This sector's speed keyframe (shared, mutated on change). */
  readonly timeScaleKey: TimeScaleKeyframe = { s: 1, fromTick: 0 };
}

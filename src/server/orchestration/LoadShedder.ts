/**
 * Phase 6 Load Shedder — the second lever of the "Temporal Anomaly" safety
 * valve. When the SimulationClock has rate-ramped to its `0.7` floor and the
 * tick budget is *still* overrun, despawn the drones farthest from any player
 * in small batches until the budget recovers.
 *
 * Asteroids are immune (kind=0): they're inert geometry, not physics-time
 * sinks. Drones (kind=1) carry the AI controller cost.
 *
 * Shedding is INVISIBLE (soak 2026-11-14: ~200–325 ships vanished mid-fight
 * when the farthest drones were still on someone's screen): a drone inside
 * any connected player's view (`isInView`, the room's per-client swarm
 * interest window) is never a candidate. If no drone qualifies, nothing is
 * shed and the 0.7× slowdown carries the load.
 *
 * Quiet evict: the call site uses `evictSwarmEntity({ broadcast: false,
 * emitDestroyed: false })` so distant drones evaporating doesn't fire the
 * kill-feed or explosion SFX. The `ENTITY_SHED` bus event is the
 * persistence/telemetry hook that distinguishes shed from combat-kill.
 *
 * Allocation-free once warm (#14): players, candidates and distances live in
 * reused class arrays, and the batch is picked by selection (batch ≤ 8), not
 * a sort.
 */
import { getShipKind } from '../../shared-types/shipKinds.js';
import { isEventId } from '../../shared-types/worldEvents.js';
import { FLAGSHIP_BOT_ID_PREFIX } from '../livingworld/directorBotIds.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { Bus } from '../../core/events/Bus.js';
import { OVER_BUDGET_MS, TIDI_FLOOR } from '../../core/clock/SimulationClock.js';

/** Float epsilon for the "rate at floor" comparison. SimulationClock ramps in
 *  0.005 steps so 0.01 is a comfortable margin without false-positives. */
const FLOOR_GATE = TIDI_FLOOR + 0.01; // 0.71

/** At most one summary log line per this many ms (per room). */
export const SHED_LOG_INTERVAL_MS = 10_000;

export interface ShedLogLine {
  /** Drones shed since the last line. */
  shed: number;
  /** Shed-eligible drones skipped because a player could see them, summed
   *  over the shedding ticks since the last line. */
  skippedInView: number;
}

export interface LoadShedderDeps {
  registry: SwarmEntityRegistry;
  /** Iterates *alive* players' positions. Implementations should skip dead
   *  ships so a dead player doesn't anchor far drones in place. */
  getPlayers: () => Iterable<{ x: number; y: number }>;
  /** Reads live position for a swarm record (typically from SAB). */
  getPosition: (rec: SwarmEntityRecord) => { x: number; y: number };
  /** True when any connected player can see this drone (its swarm interest
   *  window holds it, or the viewer has no window and so sees everything).
   *  In-view drones are never shed. */
  isInView: (rec: SwarmEntityRecord) => boolean;
  /** Quiet despawn — wired to `SectorRoom.evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false })`. */
  evict: (rec: SwarmEntityRecord) => void;
  bus: Bus;
  /** Clock for the log throttle (ms). */
  now: () => number;
  /** Rate-limited summary sink (at most once per `SHED_LOG_INTERVAL_MS`). The
   *  object is a reused scratch: copy it if you keep it. */
  log?: (line: ShedLogLine, msg: string) => void;
}

export class LoadShedder {
  private readonly px: number[] = [];
  private readonly py: number[] = [];
  private readonly cands: (SwarmEntityRecord | null)[] = [];
  private readonly d2: number[] = [];
  private shedSinceLog = 0;
  private skippedSinceLog = 0;
  private lastLogAt = -Infinity;
  private readonly logLine: ShedLogLine = { shed: 0, skippedInView: 0 };

  constructor(private readonly deps: LoadShedderDeps) {}

  /**
   * Decide whether to shed this tick and, if so, evict the batch.
   * Returns the number of entities evicted.
   *
   * @param rate     Current `SimulationClock.rate` (ramped 0.7..1.0).
   * @param busiestMs `Math.max(serverTickMs, workerTickMs)` — the same value
   *                  the clock uses to decide its ramp direction.
   */
  consider(rate: number, busiestMs: number): number {
    if (rate > FLOOR_GATE) return 0;
    if (busiestMs <= OVER_BUDGET_MS) return 0;

    const px = this.px, py = this.py;
    let np = 0;
    for (const p of this.deps.getPlayers()) { px[np] = p.x; py[np] = p.y; np++; }
    if (np === 0) return 0; // no one to be far from

    // Score every eligible, unseen drone by min-dist² to any alive player.
    const cands = this.cands, d2s = this.d2;
    let nc = 0;
    let skipped = 0;
    for (const rec of this.deps.registry.all()) {
      if (rec.kind !== 1) continue; // drone only
      // Allegiances P0: shed-immune kinds (haulers, nexi, elites) are never
      // silently evicted — that would destroy value / break a world state machine.
      // P4a/P4b — elites and world-event NPCs are never shed (a quiet shed has
      // no ENTITY_DESTROYED, so their director would never learn they left).
      // W2a — a flagship fleet's escorts too (the flagship itself is an elite).
      if (getShipKind(rec.shipKind).shedImmune || rec.elite !== undefined || isEventId(rec.id) || rec.id.startsWith(FLAGSHIP_BOT_ID_PREFIX)) continue;
      // Invisible only: never shed what a player can see.
      if (this.deps.isInView(rec)) { skipped++; continue; }
      const pos = this.deps.getPosition(rec);
      let best = Infinity;
      for (let i = 0; i < np; i++) {
        const dx = pos.x - px[i]!;
        const dy = pos.y - py[i]!;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
      cands[nc] = rec;
      d2s[nc] = best;
      nc++;
    }

    let batch = 0;
    if (nc > 0) {
      batch = Math.min(8, Math.ceil(nc * 0.10));
      // Selection of the `batch` farthest (batch ≤ 8): no sort, no allocation.
      for (let k = 0; k < batch; k++) {
        let bi = -1;
        let bd = -1;
        for (let i = 0; i < nc; i++) {
          if (d2s[i]! > bd) { bd = d2s[i]!; bi = i; }
        }
        const rec = cands[bi]!;
        d2s[bi] = -2; // taken
        this.deps.evict(rec);
        this.deps.bus.emit('ENTITY_SHED', { type: 'ENTITY_SHED', entityId: rec.id });
      }
    }
    for (let i = 0; i < nc; i++) cands[i] = null; // drop refs to evicted records

    this.noteForLog(batch, skipped);
    return batch;
  }

  private noteForLog(shed: number, skipped: number): void {
    const log = this.deps.log;
    if (log === undefined) return;
    this.shedSinceLog += shed;
    this.skippedSinceLog += skipped;
    if (this.shedSinceLog === 0 && this.skippedSinceLog === 0) return;
    const now = this.deps.now();
    if (now - this.lastLogAt < SHED_LOG_INTERVAL_MS) return;
    this.lastLogAt = now;
    this.logLine.shed = this.shedSinceLog;
    this.logLine.skippedInView = this.skippedSinceLog;
    this.shedSinceLog = 0;
    this.skippedSinceLog = 0;
    log(this.logLine, 'load shed: drones removed out of view; in-view drones kept');
  }
}

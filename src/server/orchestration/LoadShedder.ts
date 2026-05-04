/**
 * Phase 6 Load Shedder — the second lever of the "Temporal Anomaly" safety
 * valve. When the SimulationClock has rate-ramped to its `0.7` floor and the
 * tick budget is *still* overrun, despawn the drones farthest from any player
 * in small batches until the budget recovers.
 *
 * Asteroids are immune (kind=0): they're inert geometry, not physics-time
 * sinks. Drones (kind=1) carry the AI controller cost.
 *
 * Quiet evict: the call site uses `evictSwarmEntity({ broadcast: false,
 * emitDestroyed: false })` so distant drones evaporating doesn't fire the
 * kill-feed or explosion SFX. The `ENTITY_SHED` bus event is the
 * persistence/telemetry hook that distinguishes shed from combat-kill.
 */
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { Bus } from '../../core/events/Bus.js';
import { OVER_BUDGET_MS, TIDI_FLOOR } from '../../core/clock/SimulationClock.js';

/** Float epsilon for the "rate at floor" comparison. SimulationClock ramps in
 *  0.005 steps so 0.01 is a comfortable margin without false-positives. */
const FLOOR_GATE = TIDI_FLOOR + 0.01; // 0.71

export interface LoadShedderDeps {
  registry: SwarmEntityRegistry;
  /** Iterates *alive* players' positions. Implementations should skip dead
   *  ships so a dead player doesn't anchor far drones in place. */
  getPlayers: () => Iterable<{ x: number; y: number }>;
  /** Reads live position for a swarm record (typically from SAB). */
  getPosition: (rec: SwarmEntityRecord) => { x: number; y: number };
  /** Quiet despawn — wired to `SectorRoom.evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false })`. */
  evict: (rec: SwarmEntityRecord) => void;
  bus: Bus;
}

export class LoadShedder {
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

    const players: Array<{ x: number; y: number }> = [];
    for (const p of this.deps.getPlayers()) players.push(p);
    if (players.length === 0) return 0; // no one to be far from

    // Score every drone by min-dist² to any alive player. Asteroids skipped.
    const candidates: Array<{ rec: SwarmEntityRecord; d2: number }> = [];
    for (const rec of this.deps.registry.all()) {
      if (rec.kind !== 1) continue; // drone only
      const pos = this.deps.getPosition(rec);
      let best = Infinity;
      for (const p of players) {
        const dx = pos.x - p.x;
        const dy = pos.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
      candidates.push({ rec, d2: best });
    }
    if (candidates.length === 0) return 0;

    const batch = Math.min(8, Math.ceil(candidates.length * 0.10));
    // Full sort — at ≤ 4000 drones this is microseconds, and shed-eligible
    // ticks are rare. A partial-sort optimisation can land later if needed.
    candidates.sort((a, b) => b.d2 - a.d2);

    for (let i = 0; i < batch; i++) {
      const rec = candidates[i]!.rec;
      this.deps.evict(rec);
      this.deps.bus.emit('ENTITY_SHED', { type: 'ENTITY_SHED', entityId: rec.id });
    }
    return batch;
  }
}

/**
 * WavePattern — the difficulty/composition Strategy for waves (wave-system
 * plan, Phase 4). Given the wave number against a faction, decide how many
 * squads to commit and the cadence. A pure Strategy seam (Open/Closed): a
 * difficulty pass swaps the `WavePattern` impl (more squads, shorter intervals,
 * mixed-kind squads later) without editing the `WaveDirector`.
 */

export interface WaveSpec {
  /** How many squads to commit against the faction this wave. */
  squadCount: number;
  /** Minimum spacing (ms) before the next wave against the same faction.
   *  v1 keeps a faction under a single sustained wave (no re-issue cadence),
   *  so this is informational until a multi-wave director lands. */
  intervalMs: number;
}

export interface WavePattern {
  nextWave(waveNumber: number): WaveSpec;
}

/**
 * v1 pattern: one squad per ready faction, no escalation yet. The whole
 * difficulty curve is intended to live here in later versions (e.g. wave N
 * commits `min(N, maxSquads)` squads at a shrinking interval).
 */
export class EscalatingWavePattern implements WavePattern {
  nextWave(_waveNumber: number): WaveSpec {
    return { squadCount: 1, intervalMs: 0 };
  }
}

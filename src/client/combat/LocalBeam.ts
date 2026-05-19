/**
 * Local-player hitscan beam visual decision (pure; the side-effecting
 * `ColyseusClient.sendFire` / renderer defer to these — the
 * `shouldDetachWarpVisual` precedent).
 *
 * Background: see `LocalBeam.test.ts` and diagnostic capture
 * `2026-05-19T10-55-36-274Z-pe6rdt`. The local hitscan beam used to be
 * drawn as a continuous ship-attached beam PLUS a redundant chain of
 * "ghost" segments frozen at the `predWorld` pose sampled in `sendFire`;
 * the frozen layer detached from the ship under lag/reconcile correction.
 */
import type { WeaponMode } from '@core/combat/WeaponCatalogue';

/**
 * Should a LOCAL-player fire of this weapon mode spawn a travelling ghost
 * projectile?
 *
 *  - Hitscan → **false**. The local hitscan beam is drawn continuously
 *    from the ship's RENDERED pose (`mirror.ships`) every frame, so it is
 *    rigidly ship-attached and server lag/correction is invisible. A
 *    ghost is frozen at the `predWorld` pose sampled inside `sendFire`
 *    (a different sample than the ship sprite — capture-`pe6rdt`), so it
 *    is a redundant second layer that visibly detaches under lag.
 *    Dropping it leaves exactly one, attached, beam.
 *  - Projectile → **true**. The bolt actually travels; the moving ghost
 *    IS the visual and there is no continuous beam for it to attach to.
 */
export function localFireSpawnsGhost(mode: WeaponMode): boolean {
  return mode !== 'hitscan';
}

/**
 * How long the continuous local hitscan beam stays drawn after the last
 * fire tick. Must be ≥ the hitscan inter-shot interval (`cooldownTicks /
 * 60 s` ≈ 167 ms) so a held burst never blinks off between shots — the
 * gap the frozen ghost layer used to paper over. Kept small so a single
 * tap does not leave a beam lingering unnaturally. Locked against the
 * catalogue cooldown by `LocalBeam.test.ts`.
 */
export const LIVE_BEAM_PERSIST_MS = 220;

/**
 * Is the local hitscan beam still within its post-fire persistence
 * window? `lastFireMs === null` ⇒ never fired ⇒ not visible. The window
 * is inclusive of the boundary. Time is injected (no `performance.now()`
 * here) so the lifecycle is deterministically testable.
 */
export function liveBeamVisible(nowMs: number, lastFireMs: number | null, persistMs: number): boolean {
  return lastFireMs !== null && nowMs - lastFireMs <= persistMs;
}

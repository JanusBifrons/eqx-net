/**
 * Which damage targets get no floating number (debris, rocks, ore pods), read
 * from the swarm mirror by `swarm-<entityId>` id. Pure and alloc-free (#14).
 */
import type { SwarmRenderState } from '@core/contracts/IRenderer';
import { SWARM_KIND_SCRAP, SWARM_KIND_WRECK } from '@shared-types/swarmWireFormat';

const SWARM_ID_PREFIX = 'swarm-';

/**
 * Is `targetId` (`swarm-<entityId>`) a wreck piece (swarm kind 4)? A hit on
 * debris shows its impact spark and flash but NO floating damage number or
 * health bar, for every wreck profile, capitals included (hostile review
 * 2026-11-13: numbers coalesce by screen spot, so hits on a dead ship's
 * pieces kept climbing its floating number after the explosion).
 */
export function isWreckPieceTarget(
  targetId: string, swarm: ReadonlyMap<number, Pick<SwarmRenderState, 'kind'>> | undefined,
): boolean {
  return swarmKindOfTarget(targetId, swarm) === SWARM_KIND_WRECK;
}

/** The swarm kind of a `swarm-<entityId>` target, or undefined. */
function swarmKindOfTarget(
  targetId: string, swarm: ReadonlyMap<number, Pick<SwarmRenderState, 'kind'>> | undefined,
): number | undefined {
  return swarmEntryOfTarget(targetId, swarm)?.kind;
}

/** The swarm entry of a `swarm-<entityId>` target, or undefined. Parses the
 *  id in place (no substring; called per damage event, #14). */
function swarmEntryOfTarget<E>(targetId: string, swarm: ReadonlyMap<number, E> | undefined): E | undefined {
  if (swarm === undefined || !targetId.startsWith(SWARM_ID_PREFIX)) return undefined;
  const n = targetId.length;
  if (n === SWARM_ID_PREFIX.length) return undefined;
  let id = 0;
  for (let i = SWARM_ID_PREFIX.length; i < n; i++) {
    const c = targetId.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return undefined;
    id = id * 10 + c;
  }
  return swarm.get(id);
}

/**
 * Does a hit on `targetId` get NO floating damage number? Wreck pieces
 * (`isWreckPieceTarget`, which also covers pieces cut from a rock), field
 * rocks (swarm kind 0) and ore/loot pods (scrap kind, `shipKind`
 * 'cargo-pod': a cut rock's slivers drop as pods, which the mining lasers
 * and tractored pieces then hit): mining and salvage are not combat (owner
 * note 2026-11-16). They keep their spark, flash and health bar; only the
 * number goes.
 */
export function isNoDamageNumberTarget(
  targetId: string, swarm: ReadonlyMap<number, Pick<SwarmRenderState, 'kind' | 'shipKind'>> | undefined,
): boolean {
  const e = swarmEntryOfTarget(targetId, swarm);
  if (e === undefined) return false;
  return e.kind === SWARM_KIND_WRECK || e.kind === 0 || (e.kind === SWARM_KIND_SCRAP && e.shipKind === 'cargo-pod');
}

/**
 * Is `targetId` a `swarm-<id>` the swarm mirror has no entry for? Such a
 * target was never drawn: an entity spawned and killed between two
 * snapshots (the salvage pod a worn-out wreck piece turns into inside a
 * beam, killed by the beam's next pulse). Its hit gets no floating number:
 * the number would hang over empty space, and the client cannot tell what
 * kind it was (a pod gets none). The caller also checks `mirror.ships`.
 */
export function isUnseenSwarmTarget(
  targetId: string, swarm: ReadonlyMap<number, unknown> | undefined,
): boolean {
  return targetId.startsWith(SWARM_ID_PREFIX) && swarmEntryOfTarget(targetId, swarm) === undefined;
}

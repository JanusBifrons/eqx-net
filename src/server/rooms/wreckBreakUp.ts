/**
 * The death break-up of CapitalWreckSubsystem.ts (carved out for its size
 * cap, god-file-extension-points.md): read the dying thing's hit record,
 * build its pieces (`buildWreckPieces`) and hand them to THE spawn path
 * (`spawnWreck`). Takes a ship kind or any `WreckSource` (wreckSource.ts),
 * so every source breaks through this one path (no sibling system). Also
 * the recent-damage ring the hit tracking (`noteHit`) fills.
 */
import { buildWreckPieces, hullLocalCutAngle, type WreckDeathPose, type WreckFractureInputs, type WreckPieceSpec, WRECK_RECENT_DAMAGE_TICKS } from '../../core/destruction/wreckPieces.js';
import { killCutStripWidth } from '../../shared-types/shipScale/destruction.js';
import { fnv1a32, fnvMixU32 } from '../../core/random/rng.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import { WEAPONS } from '../../core/combat/WeaponCatalogue.js';
import { asWreckSource, type WreckSource } from '../../core/destruction/wreckSource.js';
import { deathExtraCuts } from './wreckBurnHits.js';
import type { CapitalWreckDeps, HitEntry, SpawnWreckOpts } from './capitalWreckTypes.js';

/** The recent-damage ring: `WRECK_HIT_BUCKETS` buckets over the last ~3 s. */
export const WRECK_HIT_BUCKETS = 6;
export const WRECK_HIT_BUCKET_TICKS = WRECK_RECENT_DAMAGE_TICKS / WRECK_HIT_BUCKETS;

/** Damage a tracked target took over the last ~3 s (whole buckets) at `tick`. */
export function recentHitDamage(e: HitEntry, tick: number): number {
  const now = Math.floor(tick / WRECK_HIT_BUCKET_TICKS);
  let sum = 0;
  for (let i = 0; i < WRECK_HIT_BUCKETS; i++) {
    const s = e.stamp[i]!;
    if (s >= 0 && now - s < WRECK_HIT_BUCKETS) sum += e.dmg[i]!;
  }
  return sum;
}

/** What `onDeath` did with a dying ship. `vaporised`: a cut weapon's kill
 *  (heavy-beam slice, railgun channel) burned every piece away (fracture
 *  v11, the profile's `cutBurnMinShare`): no wreck, the body is gone, and
 *  the room marks its `destroy` event `vaporised`. */
export interface WreckDeathOutcome {
  readonly pieces: number;
  readonly vaporised: boolean;
}
const HELD: SpawnWreckOpts = { held: true };
const NOT_HELD: SpawnWreckOpts = { held: false };
const NO_WRECK: WreckDeathOutcome = { pieces: 0, vaporised: false };
const VAPORISED: WreckDeathOutcome = { pieces: 0, vaporised: true };

/** What the break-up reads and calls on its subsystem. */
export interface WreckBreakUpHost {
  readonly d: Pick<CapitalWreckDeps, 'serverTick' | 'positionOf'>;
  /** Per target: the tick it last broke (a double death breaks once). */
  readonly lastDeathTick: Map<string, number>;
  /** The test seam's fixed fracture seed, or null. */
  forcedSeed(): number | null;
  hitOf(targetId: string): HitEntry | undefined;
  forget(targetId: string): void;
  spawnWreck(
    source: ShipKindId | WreckSource, ownerKey: string, pieces: readonly WreckPieceSpec[], fracture: WreckFractureInputs,
    hull: number, deathAngle: number, opts: SpawnWreckOpts,
  ): number;
}

/** Break `targetId` (a ship kind or any wreck source) at `pose` into wreck
 *  bodies (`CapitalWreckSubsystem.onDeath`, inside its spawn batch). */
export function breakUpWreck(
  h: WreckBreakUpHost, targetId: string, source: ShipKindId | WreckSource, pose: WreckDeathPose, maxHull: number,
  despawnDyingBody?: () => void,
): WreckDeathOutcome {
  // Two lethal hits in one tick can report the same death twice
  // (the 2026-06-19 double SHIP_DESTROYED): break the hull once.
  const tick = h.d.serverTick();
  if (h.lastDeathTick.get(targetId) === tick) return NO_WRECK;
  if (h.lastDeathTick.size > 256) h.lastDeathTick.clear();
  h.lastDeathTick.set(targetId, tick);
  const src = asWreckSource(source);
  const e = h.hitOf(targetId);
  const hull = maxHull > 0 ? maxHull : 1;
  const attackerWorld = e !== undefined && e.shooterId !== '' ? h.d.positionOf(e.shooterId) : null;
  const killBlowDamage = e !== undefined ? e.lastDamage / hull : 0;
  const recentDamageRate = e !== undefined ? recentHitDamage(e, tick) / hull : 0;
  // Kill cut (fracture v9): the killing weapon's `killCut`, along the
  // killing shot's direction turned into the hull's frame. No direction
  // (splash, ram) or no weapon ⇒ the normal break-up.
  let cutKind: 'slice' | 'channel' | undefined;
  let cutAng: number | undefined;
  let cutW: number | undefined;
  const killCut = e !== undefined && e.hasDir && e.weaponId !== null ? WEAPONS.get(e.weaponId)?.killCut : undefined;
  if (e !== undefined && killCut !== undefined) {
    cutKind = killCut.kind;
    cutAng = hullLocalCutAngle(pose, { x: e.dirX, y: e.dirY });
    // The wire width is in the hull's 1× frame.
    // A channel's strip, or a wide slice's burned gap (the heavy beam:
    // its width plus a hair, fracture v13).
    const w = killCutStripWidth(killCut);
    if (w > 0) cutW = w / src.scale;
  }
  // Multi-cut: each beam on the hull cuts too; an overlapping one widens `strip`, moves `killWorld`.
  const killWorld = e !== undefined && e.hasPoint ? { x: e.x, y: e.y } : null, strip = { w: cutW ?? 0 };
  const extraCuts = e !== undefined && killWorld !== null && cutAng !== undefined && e.burn !== null
    ? deathExtraCuts(e.burn, pose, src, killWorld, tick, cutAng, strip) : undefined;
  if (cutW !== undefined) cutW = strip.w;
  h.forget(targetId);
  const seed = h.forcedSeed() ?? fnvMixU32(fnv1a32(targetId), tick >>> 0);
  const { pieces, fracture } = buildWreckPieces({
    kindId: src, pose, killWorld, attackerWorld, seed, killBlowDamage, recentDamageRate, cutKind, cutAng, cutW, extraCuts,
  });
  // Fracture v11: a cut kill that left no piece (each burned away) is a
  // vaporised ship. Its body goes too: nothing is left to hand over to.
  const vaporised = pieces.length === 0 && fracture.cutKind !== undefined;
  if (pieces.length > 0 || vaporised) despawnDyingBody?.();
  if (vaporised) return VAPORISED;
  // The profile decides the hold (capital: `WRECK_CRACK_MS` in game ticks;
  // sub-cap 0: the kick rides the spawn velocity), the body and the FIFO.
  // A cut kill splits at once (owner, weapon cuts): no hold whatever the
  // profile; the client reads the same from the descriptor's `cutKind`.
  const held = src.profile.holdMs > 0 && fracture.cutKind === undefined;
  const spawned = h.spawnWreck(src, targetId, pieces, fracture, hull, pose.angle, held ? HELD : NOT_HELD);
  return { pieces: spawned, vaporised: false };
}

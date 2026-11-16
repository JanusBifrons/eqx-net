/**
 * Rock cut (salvage stream; docs/features/mining-and-salvage.md "Mining
 * asteroids"): the mining laser wears a rock down and, worn out, the rock
 * breaks along the burn lines of the beams that burned it, into movable
 * wreck pieces, through the SAME code a dead hull's wreck uses (no parallel
 * system):
 *  - wear: the rock's hidden integrity is a per-rock `PieceKnock` (as a wreck
 *    piece's), `wreckPieceIntegrity` of the rock's source; only a weapon
 *    with a 'rock' factor wears it (`wreckWearFactor(_, true)`: the mining
 *    laser), and each cutting hit burns its line (`burnPieceHit`, the rock
 *    being a "piece" at its own centre, scale 1);
 *  - break: a ROOT wreck whose fracture inputs name the rock (`rock`: its
 *    stable id, shape seed and radius; `wreckSource.ts`), the killing beam's
 *    cut and the other burn lines (`extraCuts`, fracture v12), fractured by
 *    `wreckPieceGeometry`, placed by `placeWreckPieces` and spawned by
 *    `spawnWreckPieces` (wreckResplit.ts) as kind-4 pieces with their own
 *    descriptor; a sliver under the profile's re-split floor drops as an ore
 *    pod instead (`dropPieceSalvage` → the room's `dropSalvage` → `OreDraw`);
 *  - the rock itself leaves through the room's normal evict path
 *    (`removePiece`).
 * Pieces then wear, re-split and pod exactly like a wreck's (re-split chain
 * on the rock root), by their 'rock' factor.
 *
 * Per hit: two Map lookups and scalar maths; a rock's first wearing hit
 * allocates its entry (and its source, once). A break allocates (once).
 */
import { fnv1a32, fnvMixU32 } from '../../core/random/rng.js';
import { WEAPONS, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { hullPointInto } from '../../core/destruction/burnLines.js';
import { hullLocalCutAngle, wreckPieceGeometry } from '../../core/destruction/wreckPieces.js';
import type { WreckFractureInputs } from '../../core/destruction/wreckPieceFrame.js';
import { rockWreckSource, ROCK_WRECK_PARENT_KIND, type WreckSource } from '../../core/destruction/wreckSource.js';
import { wreckPieceIntegrity, wreckWearFactor } from '../../core/destruction/wreckIntegrity.js';
import { FRACTURE_ALGO_VERSION } from '../../core/destruction/fractureHull.js';
import { ASTEROID_RESOURCES_PER_AREA } from '../../core/swarm/asteroidShape.js';
import { burnPieceHit } from './wreckBurnHits.js';
import { placeWreckPieces, spawnWreckPieces, type WreckResplitHost } from './wreckResplit.js';
import type { CapitalWreckDeps, PieceKnock, WreckOre, WreckRockView } from './capitalWreckTypes.js';

const PT = { x: 0, y: 0 };

/** A rock being worn: its knock entry plus its wreck source. */
type RockWear = PieceKnock & { src: WreckSource };

export class RockCutter {
  /** Per rock being worn: its hidden integrity and burn lines, and its
   *  source (built once, on its first wearing hit). */
  private readonly rocks = new Map<string, RockWear>();
  /** `forcedSeed`: the subsystem's test seam (a fixed fracture seed). */
  constructor(
    private readonly d: CapitalWreckDeps, private readonly h: WreckResplitHost,
    private readonly forcedSeed: () => number | null = () => null,
  ) {}

  /**
   * A weapon hit `damage` on `id` at world (hitX, hitY) along (dirX, dirY).
   * Not a rock, or a weapon that does not wear rock: false, nothing done.
   * Wears the rock; worn out, it breaks (true: the rock is gone, its pieces
   * are wreck pieces now). A full piece FIFO never stops a break: the oldest
   * pieces go, as after a ship death (`enforceCap`). A break that cannot
   * happen yet (no pose, fewer than two pieces) leaves it worn out (false):
   * the next hit tries again.
   */
  onRockHit(
    id: string, hitX: number, hitY: number, dirX: number, dirY: number, damage: number,
    weaponId: WeaponId | undefined, shooterId: string,
  ): boolean {
    if (this.d.rockOf === undefined || !(damage > 0)) return false;
    const f = wreckWearFactor(weaponId, true);
    if (!(f > 0)) return false;
    const rock = this.d.rockOf(id);
    if (rock === null) return false;
    let k = this.rocks.get(id);
    if (k === undefined) {
      const src = rockWreckSource({ id, shape: rock.shape, r: rock.radius });
      k = {
        mass: src.bodyMass, impulsePerDamage: 0, maxDv: 0, spin: 1, wakeDv: 0,
        index: 0, integrity: wreckPieceIntegrity(src, src.bodyMass), cx: 0, cy: 0, radius: rock.radius, burn: null, src,
      };
      this.rocks.set(id, k); // once per rock mined
    }
    burnPieceHit(k, this.d, id, 1, shooterId, hitX, hitY, dirX, dirY, weaponId);
    k.integrity -= damage * f;
    if (k.integrity > 0) return false;
    return this.breakRock(id, rock, k, hitX, hitY, dirX, dirY, weaponId);
  }

  /** Forget a rock that left the world (any eviction). */
  forget(id: string): void {
    this.rocks.delete(id);
  }

  /** Test seam: a rock's hidden integrity (undefined: not worn yet). */
  integrity(id: string): number | undefined {
    return this.rocks.get(id)?.integrity;
  }

  private breakRock(
    id: string, rock: WreckRockView, k: RockWear,
    hitX: number, hitY: number, dirX: number, dirY: number, weaponId: WeaponId | undefined,
  ): boolean {
    // The cheap check before any fracture work: no pose, no break.
    const pose = this.d.piecePose?.(id) ?? null;
    if (pose === null) return false;
    const tick = this.d.serverTick();
    const src = k.src;
    const rs = src.profile.resplit!;
    // The breaking hit in the rock's 1× Pixi-up frame (its rest frame, y
    // flipped; scale 1). The fracture projects it onto the outline.
    hullPointInto(pose.x, pose.y, pose.angle, 1, hitX, hitY, PT);
    const inputs: WreckFractureInputs = {
      rock: src.rock!, seed: this.forcedSeed() ?? fnvMixU32(fnv1a32(id), tick >>> 0), killX: PT.x, killY: PT.y,
      killBlowDamage: 0, recentDamageRate: 0, snapChance: src.profile.fracture!.snapChance,
    };
    const killCut = weaponId !== undefined ? WEAPONS.get(weaponId)?.killCut : undefined;
    if (killCut !== undefined && (dirX !== 0 || dirY !== 0)) {
      inputs.cutKind = killCut.kind;
      inputs.cutAng = hullLocalCutAngle(pose, { x: dirX, y: dirY });
      if ((killCut.width ?? 0) > 0) inputs.cutW = killCut.width;
      const extra = k.burn?.extraCuts(tick, inputs.killX, inputs.killY, inputs.cutAng, inputs.cutW ?? 0);
      if (extra !== undefined) inputs.extraCuts = extra;
    }
    const geom = wreckPieceGeometry(inputs);
    if (geom.length < 2) return false;
    const fifo = this.h.fifo(false);
    const placed = placeWreckPieces(
      src, geom, pose, pose.x, pose.y, inputs.killX, -inputs.killY, inputs.seed ^ 0x3ec7, inputs.cutW ?? 0,
    );
    // Every piece carries its area's share of the ore the rock had left.
    const left = rock.resources ?? src.area * ASTEROID_RESOURCES_PER_AREA;
    const ore: WreckOre = { rockId: id, resource: rock.resource, perArea: src.area > 0 ? Math.max(0, left) / src.area : 0 };
    const [wreckId, serial] = this.h.newWreck();
    const r = spawnWreckPieces(this.d, this.h, src, { ore }, placed, rs.minAreaFrac * src.area, serial, wreckId, null, fifo);
    if (r.ids.length === 0 && r.pods === 0) return false;
    this.rocks.delete(id);
    // TODO(macro terrain C3): record a cut-field rock as mined here with
    // `cutField?.markConsumed(rec.fieldKey)` (PR #707, not on main yet; the
    // terrain stream owns that record, so no removed-rock list here), then
    // drop the field-rock skip in SectorRoom's `rockOf`. Piece ore then reads
    // the field through `oreAtRest(restX, restY, x, y, angle, out)`, the rock's
    // rest frame copied into `ore` here and on every re-split (#706).
    // The rock leaves through the room's normal evict path.
    this.d.removePiece(id);
    if (r.ids.length > 0) {
      this.h.addWreck({
        desc: {
          wreckId, parentKind: ROCK_WRECK_PARENT_KIND, seed: inputs.seed, killX: inputs.killX, killY: inputs.killY,
          killBlowDamage: 0, recentDamageRate: 0, snapChance: inputs.snapChance, algoVersion: FRACTURE_ALGO_VERSION,
          deathTick: tick,
          ...(inputs.cutKind !== undefined ? { cutKind: inputs.cutKind, cutAng: inputs.cutAng } : {}),
          ...(inputs.cutW !== undefined ? { cutW: inputs.cutW } : {}),
          ...(inputs.extraCuts !== undefined ? { extraCuts: inputs.extraCuts.slice() } : {}),
          rock: { id, shape: rock.shape, r: rock.radius },
        },
        pieces: r.ids.length, ids: r.ids, mass: r.mass, holdUntil: tick,
        chain: { root: inputs, steps: [] }, parent: 0, children: 0, src, ore,
      }, null);
    }
    // Over the cap: the oldest pieces go, exactly as after a ship death.
    this.h.enforceCap(false);
    return true;
  }
}

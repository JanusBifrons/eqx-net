/**
 * Capital destruction S2a (docs/architecture/capital-destruction.md §S2):
 * every capital, NPC or player-flown, breaks into wreck pieces that are solid
 * server bodies. Behind the `capitalWrecks` room option, ON by default since
 * 2026-11-14 (`wreckSwitchOn`). With both switches off the room never
 * constructs this class.
 *
 * Two jobs:
 *  1. HIT TRACKING (per hit, from `SectorRoom.applyDamage`): for each capital
 *     target, the last hit's world point, damage and shooter, plus the
 *     damage taken over the last ~3 s in a fixed 6-bucket ring. Entries are
 *     pooled (one per capital ever hit, reused after death): no per-hit
 *     allocation (#14).
 *  2. DEATH (once, from the capital's death hook): read the tracker, build the
 *     pieces (`buildWreckPieces`: the kill point on the hull edge, piece count
 *     from the final hit and the recent damage rate), spawn one body per piece.
 *     The pieces move with the dead hull for `WRECK_CRACK_MS` (game ticks),
 *     then `tick()` gives each its slow separating kick.
 *  3. DESCRIPTORS (S2b): each wreck gets a u16 `wreckId` (its pieces carry it
 *     on the binary wire) and one `WreckDescriptor` (the fracture inputs) that
 *     rides the snapshot while any of its pieces lives. A client, a late joiner
 *     included, rebuilds the pieces from it (#16); no vertex is on the wire.
 *
 * Sub-capital break-up slice 2 (plan `subcapital-breakup.md`): the same
 * system breaks every OTHER ship too (behind `subcapWrecks`), driven by the
 * dying kind's destruction profile (`destructionProfileOf`), never by a
 * capital/sub-cap branch: the profile's `holdMs` (sub-cap 0 ⇒ the separating
 * kick rides the spawn velocity, no pending kick), its push and damping
 * scales and `piecesCollide` (via `wreckBodyParams`). Sub-cap pieces have
 * their own FIFO cap (`MAX_LIVE_SUBCAP_WRECK_PIECES`), so fighter debris
 * never evicts a capital piece. Which kinds break at all is the room's
 * `wreckKindOf` dep (flags + composite kinds that keep their scrap). The
 * class keeps its name (`WreckSubsystem` is an alias) so the in-flight
 * descriptor-transport slice merges cleanly.
 *
 * Hand-rolled-mock testable: everything room-shaped comes in as hooks.
 */
import { buildWreckPieces, hullLocalCutAngle, type WreckFractureInputs, type WreckPieceSpec, WRECK_RECENT_DAMAGE_TICKS, wreckBodyParams, type WreckDeathPose } from '../../core/destruction/wreckPieces.js';
import { DESTRUCTION_PROFILES, killCutStripWidth } from '../../shared-types/shipScale/destruction.js';
import { fnv1a32, fnvMixU32 } from '../../core/random/rng.js';
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import { FRACTURE_ALGO_VERSION } from '../../core/destruction/fractureHull.js';
import type { WreckDescriptor } from '../../shared-types/messages/snapshotMessages.js';
import { wreckCrackTicks } from '../../shared-types/wreckTiming.js';
import { WEAPONS, type WeaponId } from '../../core/combat/WeaponCatalogue.js';
import { shipShapeScale } from '../../core/geometry/shipHullOutline.js';
import { wreckPieceIntegrity, wreckWearFactor } from '../../core/destruction/wreckIntegrity.js';
import { WreckResplitter, type WreckPiecePose, type WreckResplitHost } from './wreckResplit.js';
import type { CapitalWreckDeps, HitEntry, LiveWreck, PieceKnock, SpawnWreckOpts, WreckOrigin } from './capitalWreckTypes.js';
import { WreckFifos } from './wreckFifos.js';
import { forEachLineagePiece, forEachPieceNear, lineageRootOf, pieceSalvageQtyOf, pieceStoreOf, type PieceStoreView } from './wreckLineage.js';
import { burnHullHit, burnPieceHit, deathExtraCuts } from './wreckBurnHits.js';
import { RockCutter } from './rockCut.js';
import type { WreckLineageState } from './wreckLineageSaves.js';
import { WreckKickQueue } from './wreckKicks.js';
import { shipWreckSource } from '../../core/destruction/wreckSource.js';
export type { WreckPiecePose };
export type { CapitalWreckDeps, LiveWreck, PieceKnock, SpawnWreckOpts, WreckOrigin, WreckPieceSpawn } from './capitalWreckTypes.js';

const BUCKETS = 6;
const BUCKET_TICKS = WRECK_RECENT_DAMAGE_TICKS / BUCKETS;

/** The last hit on a tracked hull (a pooled entry: read, don't keep). */
export interface LastHitView {
  readonly hasPoint: boolean;
  readonly x: number;
  readonly y: number;
  /** The shot's direction of travel (any length); `hasDir` false ⇒ unknown
   *  (splash, ram, a path that doesn't know it). */
  readonly hasDir: boolean;
  readonly dirX: number;
  readonly dirY: number;
  /** The weapon that landed it; null ⇒ unknown (ram, mine, untagged path). */
  readonly weaponId: WeaponId | null;
  readonly lastDamage: number;
  readonly shooterId: string;
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

/** Scratch for a piece's centre in `onWreckHit` (#14). */
const CENTRE_SCRATCH: WreckPiecePose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

export class CapitalWreckSubsystem {
  /** Kicks waiting for `WRECK_CRACK_MS` (`wreckKicks.ts`). */
  private readonly kicks: WreckKickQueue;
  private readonly entries = new Map<string, HitEntry>();
  private readonly pool: HitEntry[] = [];
  /** Live piece ids per origin and class (wreckFifos.ts): battle FIFOs evict, the field list never does. */
  private readonly fifos = new WreckFifos();
  /** Battle eviction of one piece (made once, #14). */
  private readonly evict = (id: string): void => { if (this.d.isLive(id)) this.d.removePiece(id); this.pieceGone(id); };
  private deaths = 0;
  private readonly lastDeathTick = new Map<string, number>();
  /** S2b: live wrecks by wreckId, and the snapshot slice (one descriptor per
   *  live wreck, rebuilt only when the set changes). */
  private readonly wrecks = new Map<number, LiveWreck>();
  private readonly pieceWreck = new Map<string, number>();
  /** Per live piece: how a hit knocks it (overkill knock-back). */
  private readonly knock = new Map<string, PieceKnock>();
  private readonly slice: WreckDescriptor[] = [];
  private nextWreckId = 1;
  /** Bumped whenever the set of live wrecks changes. */
  version = 0;
  /** Test seam: a fixed fracture seed. */
  forcedSeed: number | null = null;

  /** Worn-out pieces split or turn to salvage (§S4, wreckResplit.ts). */
  private readonly resplit: WreckResplitter;
  private readonly host: WreckResplitHost;
  /** Rock cut: mined-out rocks break into wreck pieces (rockCut.ts). */
  readonly rockCut: RockCutter;

  constructor(private readonly d: CapitalWreckDeps) {
    this.kicks = new WreckKickQueue(d);
    const f = this.fifos;
    const host = this.host = {
      fifo: (capital: boolean, origin: WreckOrigin) => f.list(capital, origin),
      cap: (capital: boolean, origin: WreckOrigin) => f.cap(capital, origin),
      newWreck: (): [number, number] => [this.allocWreckId(), this.deaths++],
      addPiece: (id: string, wreckId: number, entry: PieceKnock, fifo: string[]) => { this.knock.set(id, entry); fifo.push(id); this.pieceWreck.set(id, wreckId); },
      addWreck: (nw: Omit<LiveWreck, 'root' | 'origin'> & { origin?: WreckOrigin }, parent: LiveWreck | null) => {
        // Lineage: a root (rock break) is its own root; a child inherits its parent's root and origin.
        const w = nw as LiveWreck; w.root = parent !== null ? parent.root : w.desc.wreckId;
        w.origin = parent !== null ? parent.origin : (nw.origin ?? 'battle');
        this.wrecks.set(w.desc.wreckId, w); if (parent !== null) parent.children++;
        this.setChanged(); this.d.lineageTouched?.(w.root);
      },
      dropPiece: (id: string, fifo: string[]) => this.dropPiece(id, fifo),
      enforceCap: (capital: boolean) => f.enforce(capital, this.evict),
    };
    this.resplit = new WreckResplitter(d, host);
    this.rockCut = new RockCutter(d, host, () => this.forcedSeed);
  }

  /** Record a hit on `targetId` (called for every damaging hit). Cheap for
   *  non-capitals (one kind lookup). `hitX/hitY` absent ⇒ the attacker's
   *  position stands in at death. `dirX/dirY` (the shot's travel) and
   *  `weaponId` are kept for the last hit only; absent ⇒ unknown. */
  noteHit(
    targetId: string, shooterId: string, damage: number, hitX: number | undefined, hitY: number | undefined,
    dirX?: number, dirY?: number, weaponId?: WeaponId,
  ): void {
    if (damage <= 0) return;
    const kindId = this.d.wreckKindOf(targetId);
    if (kindId === null) return;
    let e = this.entries.get(targetId);
    if (e === undefined) {
      e = this.pool.pop() ?? {
        hasPoint: false, x: 0, y: 0, hasDir: false, dirX: 0, dirY: 0, weaponId: null,
        lastDamage: 0, shooterId: '', dmg: new Float64Array(BUCKETS), stamp: new Int32Array(BUCKETS).fill(-1), burn: null,
      };
      e.dmg.fill(0);
      e.stamp.fill(-1);
      e.burn?.clear(e.burn.mergeGap);
      this.entries.set(targetId, e);
    }
    // Fracture v12 multi-cut: a cutting beam burns its line into the hull.
    e.burn = burnHullHit(e.burn, this.d, targetId, kindId, shooterId, hitX, hitY, dirX, dirY, weaponId);
    e.hasPoint = hitX !== undefined && hitY !== undefined;
    e.x = hitX ?? 0;
    e.y = hitY ?? 0;
    e.hasDir = dirX !== undefined && dirY !== undefined && (dirX !== 0 || dirY !== 0);
    e.dirX = e.hasDir ? dirX! : 0;
    e.dirY = e.hasDir ? dirY! : 0;
    e.weaponId = weaponId ?? null;
    e.lastDamage = damage;
    e.shooterId = shooterId;
    const b = Math.floor(this.d.serverTick() / BUCKET_TICKS);
    const i = b % BUCKETS;
    if (e.stamp[i] !== b) {
      e.stamp[i] = b;
      e.dmg[i] = 0;
    }
    e.dmg[i]! += damage;
  }

  /** Damage `targetId` took over the last ~3 s (whole buckets). */
  private recentDamage(e: HitEntry): number {
    const now = Math.floor(this.d.serverTick() / BUCKET_TICKS);
    let sum = 0;
    for (let i = 0; i < BUCKETS; i++) {
      const s = e.stamp[i]!;
      if (s >= 0 && now - s < BUCKETS) sum += e.dmg[i]!;
    }
    return sum;
  }

  /** The last hit recorded on `targetId` (the pooled entry itself, no copy:
   *  read it before the next `noteHit` / death), or null if none. */
  lastHit(targetId: string): LastHitView | null {
    return this.entries.get(targetId) ?? null;
  }

  /** Forget a target that left without dying (evicted, despawned). */
  forget(targetId: string): void {
    this.rockCut.forget(targetId);
    const e = this.entries.get(targetId);
    if (e === undefined) return;
    this.entries.delete(targetId);
    this.pool.push(e);
  }

  /**
   * A capital died at `pose`: break it into wreck bodies. Returns the number
   * of pieces spawned (0 for a non-capital) and whether a cut kill
   * vaporised it (`WreckDeathOutcome`). Call while the dying body is
   * still live (its pose is read off the SAB). `despawnDyingBody` posts the
   * dying body's DESPAWN; it is called once, BEFORE the first piece spawn,
   * and only when there are pieces or the ship was vaporised (no piece to
   * hand over to, but the dead body must still go). The worker handles each command as its
   * own message and can step between two of them, so a despawn posted after
   * the spawns left the pieces inside the old hull for a step, and the
   * push-out shoved them (2026-11-14: a sub-cap piece stopped dead and its
   * cut barely opened; `subcapWrecks.test.ts` "loot pod"). For the same
   * reason the despawn and every piece spawn go in ONE worker message
   * (`beginBatch`): one message per piece let a loaded worker step between
   * two pieces, so one started a step ahead (`wreckSpawnOneMessage.test.ts`).
   */
  onDeath(targetId: string, kindId: ShipKindId, pose: WreckDeathPose, maxHull: number, despawnDyingBody?: () => void): WreckDeathOutcome {
    this.d.beginBatch?.();
    try {
      return this.breakUp(targetId, kindId, pose, maxHull, despawnDyingBody);
    } finally {
      this.d.endBatch?.();
    }
  }

  private breakUp(targetId: string, kindId: ShipKindId, pose: WreckDeathPose, maxHull: number, despawnDyingBody?: () => void): WreckDeathOutcome {
    // Two lethal hits in one tick can report the same death twice
    // (the 2026-06-19 double SHIP_DESTROYED): break the hull once.
    const tick = this.d.serverTick();
    if (this.lastDeathTick.get(targetId) === tick) return NO_WRECK;
    if (this.lastDeathTick.size > 256) this.lastDeathTick.clear();
    this.lastDeathTick.set(targetId, tick);
    const e = this.entries.get(targetId);
    const hull = maxHull > 0 ? maxHull : 1;
    const attackerWorld = e !== undefined && e.shooterId !== '' ? this.d.positionOf(e.shooterId) : null;
    const killBlowDamage = e !== undefined ? e.lastDamage / hull : 0;
    const recentDamageRate = e !== undefined ? this.recentDamage(e) / hull : 0;
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
      if (w > 0) cutW = w / shipShapeScale(getShipKind(kindId));
    }
    // Multi-cut: each beam on the hull cuts too; an overlapping one widens `strip`, moves `killWorld`.
    const killWorld = e !== undefined && e.hasPoint ? { x: e.x, y: e.y } : null, strip = { w: cutW ?? 0 };
    const extraCuts = e !== undefined && killWorld !== null && cutAng !== undefined && e.burn !== null
      ? deathExtraCuts(e.burn, pose, kindId, killWorld, tick, cutAng, strip) : undefined;
    if (cutW !== undefined) cutW = strip.w;
    this.forget(targetId);
    const seed = this.forcedSeed ?? fnvMixU32(fnv1a32(targetId), this.d.serverTick() >>> 0);
    const { pieces, fracture } = buildWreckPieces({
      kindId, pose, killWorld, attackerWorld, seed, killBlowDamage, recentDamageRate, cutKind, cutAng, cutW, extraCuts,
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
    const held = DESTRUCTION_PROFILES[shipTuning(getShipKind(kindId)).destruction].holdMs > 0 && fracture.cutKind === undefined;
    const spawned = this.spawnWreck(kindId, targetId, pieces, fracture, hull, pose.angle, held ? HELD : NOT_HELD);
    return { pieces: spawned, vaporised: false };
  }

  /** THE wreck spawn path (wreck fields plan slice 0a; capital-destruction.md):
   *  id, piece bodies in order, knock, kicks when `held`, FIFO, `LiveWreck` +
   *  descriptor, cap. `ownerKey` goes to `ownerOf`; `hull` is the max HP. */
  spawnWreck(
    kindId: ShipKindId, ownerKey: string, pieces: readonly WreckPieceSpec[], fracture: WreckFractureInputs,
    hull: number, deathAngle: number, opts: SpawnWreckOpts,
  ): number {
    const { held, poses, skipPieces } = opts;
    const origin = opts.origin ?? 'battle';
    const at = opts.deathTick ?? this.d.serverTick();
    const n = this.deaths++;
    const wreckId = this.allocWreckId();
    // Overkill knock-back (#18): a blow worth the whole hull's HP would move
    // the whole hull at `wreckKnockSpeed`.
    const tuning = shipTuning(getShipKind(kindId));
    const profile = DESTRUCTION_PROFILES[tuning.destruction];
    const crackTicks = held ? wreckCrackTicks() : 0;
    const body = wreckBodyParams(kindId);
    const fifo = this.fifos.list(profile.id === 'capital', origin);
    let hullMass = 0;
    for (const p of pieces) hullMass += p.mass;
    const impulsePerDamage = (hullMass * tuning.wreckKnockSpeed) / hull;
    let spawned = 0;
    let spawnedMass = 0;
    const spawnedIds: string[] = [];
    for (const p of pieces) {
      if (skipPieces?.has(p.index) === true) continue;
      const id = `wreck-${n}-${p.index}`;
      const posed = poses?.get(p.index);
      // No hold: the separating kick is part of the spawn motion (the pieces
      // spawn at the death angle, the kick's frame), so no pending kick.
      // A posed piece spawns exactly as given (no kick at all).
      const kick = posed === undefined && !held;
      const ok = this.d.spawnPiece({
        id, x: posed?.x ?? p.x, y: posed?.y ?? p.y,
        vx: posed?.vx ?? (kick ? p.vx + p.kickVx : p.vx), vy: posed?.vy ?? (kick ? p.vy + p.kickVy : p.vy),
        angle: posed?.angle ?? p.angle, angvel: posed?.angvel ?? (kick ? p.angvel + p.kickAngvel : p.angvel),
        radius: p.radius, mass: p.mass, parentShipKind: kindId, pieceIndex: p.index, wreckId,
        parts: p.parts, colliderParts: p.colliderParts,
        linearDamping: body.linearDamping, angularDamping: body.angularDamping,
        collisionGroups: body.collisionGroups,
        settleSpeed: body.settleSpeed, settleSpin: body.settleSpin,
        ...(opts.sleeping === true ? { sleeping: true } : {}),
      });
      if (!ok) continue;
      spawned++;
      spawnedMass += p.mass;
      spawnedIds.push(id);
      this.knock.set(id, {
        mass: p.mass, impulsePerDamage, maxDv: tuning.wreckKnockMax, spin: profile.spinScale, wakeDv: profile.knockWakeScale * tuning.wreckKnockMax,
        index: p.index, integrity: wreckPieceIntegrity(kindId, p.mass),
        cx: p.cx, cy: p.cy, radius: p.radius, burn: null,
      });
      // The hull holds together for the crack delay, then parts (game ticks).
      if (held && posed === undefined) this.kicks.push(id, at + crackTicks, p.kickVx, p.kickVy, p.kickAngvel, deathAngle);
      fifo.push(id);
      this.pieceWreck.set(id, wreckId);
    }
    if (spawned > 0) {
      const owner = opts.owner ?? this.d.ownerOf?.(ownerKey);
      this.wrecks.set(wreckId, {
        desc: {
          wreckId, parentKind: kindId, seed: fracture.seed, killX: fracture.killX, killY: fracture.killY,
          killBlowDamage: fracture.killBlowDamage, recentDamageRate: fracture.recentDamageRate,
          snapChance: fracture.snapChance, algoVersion: FRACTURE_ALGO_VERSION,
          ...(opts.cool === true ? {} : { deathTick: at }), // cool: drawn long dead
          // Emit-when-present: an un-cut wreck's descriptor is unchanged.
          ...(fracture.cutKind !== undefined ? { cutKind: fracture.cutKind, cutAng: fracture.cutAng } : {}),
          ...(fracture.cutW !== undefined ? { cutW: fracture.cutW } : {}),
          ...(fracture.extraCuts !== undefined ? { extraCuts: fracture.extraCuts.slice() } : {}),
          ...(owner !== undefined && owner !== '' ? { owner } : {}),
        },
        pieces: spawned,
        ids: spawnedIds,
        mass: spawnedMass,
        holdUntil: at + crackTicks,
        chain: { root: fracture, steps: [] },
        parent: 0,
        children: 0,
        root: wreckId,
        origin,
        src: shipWreckSource(kindId),
      });
      this.setChanged(); this.d.lineageTouched?.(wreckId);
    }
    if (origin === 'battle') this.fifos.enforce(profile.id === 'capital', this.evict);
    return spawned;
  }

  /** Per server tick: due separating kicks (`WreckKickQueue.tick`). */
  tick(): void {
    this.kicks.tick();
  }

  /**
   * Overkill knock-back (owner request 2026-11-13): a weapon hit `damage` on
   * wreck piece `id` at world point (hitX, hitY), travelling along (dirX,
   * dirY). Posts an impulse J = damage × hull mass × `wreckKnockSpeed` ÷ max
   * hull at the hit point, along the shot, so an off-centre hit also turns
   * the piece; the speed change J ÷ m is capped at `wreckKnockMax`. Returns
   * false (and does nothing) when `id` is not a live wreck piece or the
   * direction is degenerate. Scalars only, alloc-free (#14): it runs in the
   * projectile and beam hit paths.
   *
   * A beam (a `hitscan`-mode weapon: light, no mass) never shoves debris
   * (owner 2026-11-15: "lasers shouldn't move the scrap"): it still wears
   * the piece's integrity and can split it, but posts no impulse. Only real
   * impacts (shells, slugs; rams through the contact) push, by mass.
   *
   * During the crack hold (the rest of a salvo landing right after the kill,
   * owner review 2026-11-13: the hull bent like a banana) the same impulse
   * goes to the WHOLE wreck as one rigid body (`impulseWreck`): Δv = J ÷ the
   * wreck's mass, Δω = (r × J) ÷ its moment of inertia, every piece set to
   * v_com + ω × r_i, so the hull reads as one cracked body until it splits.
   * The speed cap is then on the whole wreck (`wreckKnockMax` × its mass).
   *
   * A piece ASLEEP (settled debris) is shoved only by a hit whose uncapped
   * speed change is at least the profile's `knockWakeScale` × `wreckKnockMax`
   * (sub-caps: twice the cap, so small arms leave it asleep; capitals: 0,
   * every hit). A lighter hit returns true (the shot stops) and does nothing.
   */
  onWreckHit(
    id: string, hitX: number, hitY: number, dirX: number, dirY: number, damage: number, weaponId?: WeaponId, shooterId = '',
  ): boolean {
    const k = this.knock.get(id);
    // Rock cut: a hit on a rock (not a piece) wears it (rockCut.ts).
    if (k === undefined) {
      // A mined-out rock's pieces spawn in one worker message, as a death's.
      this.d.beginBatch?.();
      try {
        return this.rockCut.onRockHit(id, hitX, hitY, dirX, dirY, damage, weaponId, shooterId);
      } finally {
        this.d.endBatch?.();
      }
    }
    if (this.d.impulsePiece === undefined || !(damage > 0)) return false;
    const len = Math.hypot(dirX, dirY);
    if (!(len > 1e-9) || !Number.isFinite(hitX) || !Number.isFinite(hitY)) return false;
    let j = damage * k.impulsePerDamage;
    const wreckId = this.pieceWreck.get(id);
    const w = wreckId !== undefined ? this.wrecks.get(wreckId) : undefined;
    // Fracture v12 multi-cut: a cutting beam burns its line into the piece.
    if (w !== undefined) { burnPieceHit(k, this.d, id, w.src.scale, shooterId, hitX, hitY, dirX, dirY, weaponId); this.d.lineageTouched?.(w.root); }
    // Re-split (§S4): the hit wears the piece's hidden integrity; worn out
    // (and past the crack hold) it splits or turns to salvage instead of
    // being shoved.
    // A rock's pieces wear by the weapon's 'rock' factor (the mining laser).
    if (k.integrity > 0) k.integrity -= damage * wreckWearFactor(weaponId, w !== undefined && w.src.rock !== null);
    if (k.integrity <= 0 && w !== undefined && wreckId !== undefined && this.d.serverTick() >= w.holdUntil) {
      // The re-split's pieces spawn in one worker message, as a death's.
      this.d.beginBatch?.();
      try {
        if (this.resplit.wornOut(id, k, wreckId, w, hitX, hitY, dirX, dirY, weaponId)) return true;
      } finally {
        this.d.endBatch?.();
      }
    }
    // A beam carries no momentum: the shot stops on the piece, no shove.
    if (weaponId !== undefined && WEAPONS.get(weaponId)?.mode === 'hitscan') return true;
    if (w !== undefined && this.d.impulseWreck !== undefined && this.d.serverTick() < w.holdUntil) {
      const jMax = k.maxDv * w.mass;
      if (j > jMax) j = jMax;
      const s = j / len;
      this.d.impulseWreck(w.ids, dirX * s, dirY * s, hitX, hitY);
      return true;
    }
    // A resting piece ignores a light hit (wreck sleep fix, 2026-11-13): the
    // shot still stops on it, but small arms no longer wake settled debris.
    if (k.wakeDv > 0 && j < k.wakeDv * k.mass && this.d.pieceAsleep?.(id) === true) return true;
    const jMax = k.maxDv * k.mass;
    if (j > jMax) j = jMax;
    const s = j / len;
    // The profile's spin scale shortens the lever arm (capital 1: the hit
    // point as is). A sub-cap piece still takes the whole shove, but only a
    // lazy turn (owner on the v5 film 2026-11-13: "they spin too much").
    let px = hitX;
    let py = hitY;
    if (k.spin !== 1 && this.d.pieceCentreInto !== undefined && this.d.pieceCentreInto(id, CENTRE_SCRATCH)) {
      px = CENTRE_SCRATCH.x + (hitX - CENTRE_SCRATCH.x) * k.spin;
      py = CENTRE_SCRATCH.y + (hitY - CENTRE_SCRATCH.y) * k.spin;
    }
    this.d.impulsePiece(id, dirX * s, dirY * s, px, py);
    return true;
  }

  /** True while piece `id`'s wreck is still in its crack hold (before
   *  `holdUntil`): its pieces move only as one rigid body then, so a tractor
   *  leaves them alone until the hold ends (salvage plan PR 11). */
  inCrackHold(id: string): boolean {
    const wreckId = this.pieceWreck.get(id);
    const w = wreckId !== undefined ? this.wrecks.get(wreckId) : undefined;
    return w !== undefined && this.d.serverTick() < w.holdUntil;
  }

  /** Pieces still holding together (waiting for their kick). */
  pendingKicks(): number {
    return this.kicks.length;
  }

  /** A free u16 wreck id (never 0, never one still live). */
  private allocWreckId(): number {
    for (;;) {
      const id = this.nextWreckId;
      this.nextWreckId = id >= 0xffff ? 1 : id + 1;
      if (!this.wrecks.has(id)) return id;
    }
  }

  /** Lineage walks (wreckLineage.ts): every live piece under root wreck `root`; a piece's root or null. */
  forEachLineagePiece(root: number, visit: (pieceId: string) => void): void { forEachLineagePiece(this.wrecks, this.pieceWreck, root, visit); }
  lineageRootOf(pieceId: string): number | null { return lineageRootOf(this.wrecks, this.pieceWreck, pieceId); }

  private setChanged(): void {
    this.version++;
    this.slice.length = 0;
    for (const w of this.wrecks.values()) this.slice.push(w.desc);
  }

  /** A wreck piece left the world (cap, or any other removal). */
  pieceGone(id: string): void {
    this.knock.delete(id);
    const wreckId = this.pieceWreck.get(id);
    if (wreckId === undefined) return;
    this.pieceWreck.delete(id);
    const w = this.wrecks.get(wreckId);
    if (w === undefined) return;
    w.pieces--; this.d.lineageTouched?.(w.root);
    if (w.origin === 'field') this.fifos.forgetField(id); // the non-evicting list keeps no stale id
    this.retire(wreckId, w);
  }

  /** Drop a wreck with no live pieces nor child wrecks, then each ancestor
   *  left so (§S4: ancestors stay on the wire while a descendant lives). */
  private retire(wreckId: number, w: LiveWreck): void {
    let changed = false;
    while (w.pieces <= 0 && w.children <= 0) {
      this.wrecks.delete(wreckId);
      changed = true;
      const p = w.parent !== 0 ? this.wrecks.get(w.parent) : undefined;
      if (p === undefined) break;
      p.children--;
      wreckId = w.parent;
      w = p;
    }
    if (changed) this.setChanged();
  }

  /** Remove a live piece that broke or turned to salvage (out of its FIFO,
   *  its body, its wreck's count). */
  private dropPiece(id: string, fifo: string[]): void {
    const i = fifo.indexOf(id);
    if (i >= 0) fifo.splice(i, 1);
    if (this.d.isLive(id)) this.d.removePiece(id);
    this.pieceGone(id);
  }
  /** Battle-wreck save/restore (wreckLineageSaves.ts): the maps it reads, the spawn host it restores through. */
  lineageState(): WreckLineageState { return { wrecks: this.wrecks, pieceWreck: this.pieceWreck, knock: this.knock, host: this.host, d: this.d }; }

  /** A live piece's salvage if stored whole (wreckLineage.ts `pieceSalvageQtyOf`). */
  pieceSalvageQty(id: string): number { return pieceSalvageQtyOf(this.wrecks, this.pieceWreck, this.knock, id); }

  /** A piece went whole into a hold (`LootSubsystem`'s piece store): it leaves like a worn-out piece turning to salvage. */
  /** Wreck fields 3b: an untouched field hull's piece retires with its chunk (`dropPiece`, field list). */
  retireFieldPiece(id: string): void { if (this.knock.has(id)) this.dropPiece(id, this.fifos.field); }
  storePiece(id: string): void {
    if (!this.knock.has(id)) return;
    this.dropPiece(id, this.fifos.holding(id) ?? this.fifos.capital);
  }

  /** Test seam: a live piece's hidden integrity (undefined: not a piece). */
  pieceIntegrity(id: string): number | undefined {
    return this.knock.get(id)?.integrity ?? this.rockCut.integrity(id);
  }

  /** A live piece's mass, radius and whole-store worth (wreckLineage.ts `pieceStoreOf`). */
  pieceStore(id: string, out: PieceStoreView): boolean { return pieceStoreOf(this.wrecks, this.pieceWreck, this.knock, id, out); }

  /** Live pieces a ship at (x, y) could take in (wreckLineage.ts `forEachPieceNear`). */
  forEachPieceNear(x: number, y: number, reach: number, maxMass: number, visit: (id: string, px: number, py: number, pr: number) => void): void { forEachPieceNear(this.wrecks, this.pieceWreck, this.knock, this.d.serverTick(), this.d.piecePoseInto, x, y, reach, maxMass, visit); }

  /** The snapshot slice: one descriptor per live wreck (shared array, rebuilt
   *  only on change; empty when there are none). */
  descriptors(): readonly WreckDescriptor[] {
    return this.slice;
  }

  /** Live wreck pieces this subsystem tracks, every origin and class. */
  liveCount(): number { return this.fifos.count(); }
  /** Live battle sub-capital wreck pieces (their own FIFO). */
  liveSubcapCount(): number { return this.fifos.subcap.length; }
  /** Live battle pieces (both FIFOs) / live field pieces (wreckFifos.ts). */
  liveBattleCount(): number { return this.fifos.battleCount(); }
  liveFieldCount(): number { return this.fifos.fieldCount(); }

  /** Test seams: a smaller sub-cap cap / field cap (null ⇒ the constants). */
  get subcapCapOverride(): number | null { return this.fifos.subcapCapOverride; }
  set subcapCapOverride(v: number | null) { this.fifos.subcapCapOverride = v; }
  get fieldCapOverride(): number | null { return this.fifos.fieldCapOverride; }
  set fieldCapOverride(v: number | null) { this.fifos.fieldCapOverride = v; }
}

/** The generalised name (sub-capital break-up slice 2): one wreck system for
 *  every profile. */
export { CapitalWreckSubsystem as WreckSubsystem };

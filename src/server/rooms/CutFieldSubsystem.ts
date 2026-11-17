/**
 * Macro terrain v2 (room option `cutField`): the room's side of a cut field.
 * Streams the chunks near ships in as fixed rock colliders on the streamer's
 * own game-clock timer (never the room tick, #14), wakes the rocks a ram
 * touches (C2), and carries the seed for the welcome (#16: a joiner cuts the
 * same rocks). Field rocks stay off the swarm wire (unless awake or moved) and
 * the sector snapshot; what changed on them (ore mined, broken up, where a
 * moved rock was left: deep sleep, C2) is saved by rock key in
 * `terrain_records` (C4) and loaded when the field starts.
 * How it works: docs/architecture/macro-terrain.md.
 */
import type { GameClock, GameTimer } from '../../core/clock/GameClock.js';
import {
  CutFieldStreamer, cutFieldOpts, fieldRockBody, fieldRockId, fieldRockMass, fieldRocksInBox, fieldRockWakes,
  FIELD_WAKES_PER_TICK, STEP_EVERY_MS,
} from '../../core/terrain/chunkStreamer.js';
import { FIELD_LAYOUT_VERSION, SLICED, type ChunkOpts, type FieldClearing } from '../../core/terrain/fieldLayout.js';
import { rockObstacleParts, type GridObstacle, type ObstacleBox } from '../../core/structures/Grid.js';
import { oreAt, oreSeed, type OreConc } from '../../core/terrain/fieldOre.js';
import { SLOT_ANGLE_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { SWARM_KIND_DRONE } from '../../shared-types/swarmWireFormat.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipBodyMass } from '../../shared-types/shipScale/tuning.js';
import {
  MAX_WELCOME_CLEARINGS, MAX_WELCOME_CONSUMED_ROCKS, MAX_WELCOME_MOVED_ROCKS, type CutFieldWelcome, type FieldConsumedMessage, type FieldMovedMessage, type FieldRockPose,
} from '../../shared-types/messages/snapshotMessages.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { fieldRockOnWire, type SwarmEntityRecord, type SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import type { RockRecordStore } from '../db/terrainSql.js';
import { guarded } from './guardedLoop.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

export interface CutFieldRoomHooks {
  /** The SAB slots of every pilot's ship (AI hulls come from the registry). */
  shipSlots(): Iterable<number>;
  sab(): Float32Array;
  post(cmd: WorkerCmd): void;
  /** Remove a rock; `broadcast` when it is awake (on the wire). */
  evict(rec: SwarmEntityRecord, broadcast: boolean): void;
  /** Send to every client in the room (reliable). */
  broadcast(type: 'field_consumed' | 'field_moved', msg: FieldConsumedMessage | FieldMovedMessage): void;
  /** The body mass of the pilot ship a contact names (contacts name a
   *  pilot's hull by playerId); undefined for anything else. A rock wakes
   *  only to a body at least as heavy (`fieldRockWakes`). */
  shipMass?(id: string): number | undefined;
  /** The change record's save (C4): a room that persists its sector passes
   *  one; engineering and test rooms without a saved sector pass none. */
  records?: RockRecordStore;
}

/** World point (x, y) on a rock now at (poseX, poseY, angle) back into the
 *  rest frame it was cut in (centre (restX, restY), angle 0), into `out`. */
export function toRestFrame(
  restX: number, restY: number, poseX: number, poseY: number, angle: number,
  x: number, y: number, out: { x: number; y: number },
): { x: number; y: number } {
  const dx = x - poseX, dy = y - poseY, cos = Math.cos(angle), sin = Math.sin(angle);
  out.x = restX + dx * cos + dy * sin;
  out.y = restY - dx * sin + dy * cos;
  return out;
}

/** A woken rock left closer than this to its cut pose (world units / radians)
 *  counts as unmoved: it goes back to having no pose record. */
const MOVED_EPS = 0.5;
const MOVED_EPS_ANGLE = 1e-3;

/** Where a moved rock was left (C2 deep sleep): its body centre and angle. */
interface RockPose { x: number; y: number; angle: number }

export class CutFieldSubsystem {
  readonly streamer: CutFieldStreamer;
  private readonly timer: GameTimer;
  private wakeTick = -1;
  private wakesThisTick = 0;
  /** The field's ore seed (`oreSeed`), as the client draws it. */
  private readonly oreBase: number;
  private readonly restPt = { x: 0, y: 0 };
  /** The field's change record by rock key, saved in `terrain_records`
   *  (C4: written on each change, loaded at start). A rock nobody touched
   *  has no entry. `minedPool`: what is left in a mined rock, kept while its
   *  chunk is unloaded so a re-cut doesn't refill it. `consumed`: rocks
   *  broken up (salvage rock cut), never cut whole again. `movedPose`: where
   *  a woken rock was left when its chunk unloaded (deep sleep, C2); the
   *  re-cut spawns it there, fixed, instead of at its cut pose. */
  private readonly minedPool = new Map<number, number>();
  private readonly consumed = new Set<number>();
  private readonly movedPose = new Map<number, RockPose>();
  private readonly seed: string;
  private readonly gameClock: GameClock;
  private readonly opts: ChunkOpts;

  constructor(
    seed: string,
    gameClock: GameClock,
    private readonly registry: SwarmEntityRegistry,
    spawner: SwarmSpawner,
    private readonly hooks: CutFieldRoomHooks,
    /** Open pockets cut out of the field (galaxy sectors, F4); none in test
     *  and showcase rooms. On the welcome so the client cuts the same rocks. */
    clearings?: readonly FieldClearing[],
  ) {
    this.seed = seed;
    this.gameClock = gameClock;
    this.oreBase = oreSeed(seed);
    this.loadRecords();
    // More than the welcome carries would leave joiners cutting other rocks (#15).
    if ((clearings?.length ?? 0) > MAX_WELCOME_CLEARINGS) throw new Error(`cut field: ${clearings!.length} clearings, the welcome carries ${MAX_WELCOME_CLEARINGS}`);
    this.opts = cutFieldOpts(seed, clearings);
    this.streamer = new CutFieldStreamer(this.opts, {
      // Pilots and AI hulls keep rocks loaded. Slow cadence (STEP_EVERY_MS).
      visitShips: (cb) => {
        const sab = hooks.sab();
        for (const slot of hooks.shipSlots()) cb(sab[slotBase(slot) + SLOT_X_OFF]!, sab[slotBase(slot) + SLOT_Y_OFF]!);
        for (const rec of registry.all()) {
          if (rec.kind === SWARM_KIND_DRONE) cb(sab[slotBase(rec.slot) + SLOT_X_OFF]!, sab[slotBase(rec.slot) + SLOT_Y_OFF]!);
        }
      },
      spawnRock: (id, rock) => {
        // A broken-up rock is never cut whole again (counted as refused).
        if (this.consumed.has(rock.key)) return false;
        // The same body the client builds (#15): centred on the outline.
        const b = fieldRockBody(rock);
        // A moved rock comes back where it was left (deep sleep, C2), still
        // fixed, its rest frame (ore) where the field cut it.
        const at = this.movedPose.get(rock.key);
        if (!spawner.spawnAsteroid({
          id, x: at?.x ?? b.x, y: at?.y ?? b.y, vx: 0, vy: 0, radius: b.radius, vertices: b.verts, mass: fieldRockMass(b.radius),
          fixed: true, fieldRock: true, fieldKey: rock.key, parts: b.parts ?? undefined, angle: at?.angle, restX: b.x, restY: b.y,
        })) return false;
        const rec = registry.get(id);
        if (rec && at) rec.fieldMoved = true; // on the wire: the clients cut it at its cut pose
        const left = this.minedPool.get(rock.key);
        if (rec && left !== undefined && rec.resources !== undefined) rec.resources = Math.min(rec.resources, left);
        return true;
      },
      removeRock: (id) => {
        const rec = registry.get(id);
        if (!rec) return;
        if (rec.fieldKey !== undefined) {
          let changed = false;
          if (rec.resources !== undefined && rec.resourcesMax !== undefined && rec.resources < rec.resourcesMax
            && this.minedPool.get(rec.fieldKey) !== rec.resources) {
            this.minedPool.set(rec.fieldKey, rec.resources);
            changed = true;
          }
          const moved = rec.fieldAwake === true && this.notePose(rec, rec.fieldKey);
          if (moved || changed) this.save(rec.fieldKey);
          if (moved) this.sendPose(rec.fieldKey);
        }
        hooks.evict(rec, fieldRockOnWire(rec));
      },
      nowMs: () => gameClock.now(),
    });
    this.timer = gameClock.every(STEP_EVERY_MS, guarded('cut-field', () => this.streamer.step()));
  }

  /** A contact between `aId` and `bId` (contact batch, per aggregated pair). */
  onContact(aId: string, bId: string, closingSpeed: number, tick: number): void {
    this.wake(aId, bId, closingSpeed, tick);
    this.wake(bId, aId, closingSpeed, tick);
  }

  dispose(): void {
    this.timer.cancel();
  }

  /** An awake rock's chunk is unloading: keep where it was left (its live SAB
   *  pose) when that is off its cut pose, else forget any pose kept for it.
   *  True when the kept pose changed. A chunk event, never per tick. */
  private notePose(rec: SwarmEntityRecord, key: number): boolean {
    if (rec.restX === undefined || rec.restY === undefined) return false;
    const sab = this.hooks.sab(), base = slotBase(rec.slot);
    const x = sab[base + SLOT_X_OFF]!, y = sab[base + SLOT_Y_OFF]!, angle = sab[base + SLOT_ANGLE_OFF]!;
    const kept = this.movedPose.get(key);
    if (Math.hypot(x - rec.restX, y - rec.restY) < MOVED_EPS && Math.abs(angle) < MOVED_EPS_ANGLE) {
      return this.movedPose.delete(key);
    }
    if (kept && kept.x === x && kept.y === y && kept.angle === angle) return false;
    if (kept) { kept.x = x; kept.y = y; kept.angle = angle; } else this.movedPose.set(key, { x, y, angle });
    return true;
  }

  /** Tell the room rock `key`'s kept pose (`field_moved`), or that it has
   *  none any more (`clear: true`: back at its cut pose). A chunk event. */
  private sendPose(key: number): void {
    const p = this.movedPose.get(key);
    this.hooks.broadcast('field_moved', p ? { k: key, x: p.x, y: p.y, a: p.angle } : { k: key, clear: true });
  }

  /** A fixed field rock wakes when something at least as heavy touches it
   *  (a capital on a small rock), or when an awake rock at least as heavy is
   *  driven into it (`fieldRockWakes`); at most `FIELD_WAKES_PER_TICK` a
   *  tick. Its body turns dynamic and it rides the swarm wire by its rock key
   *  until its chunk unloads. */
  private wake(id: string, otherId: string, closingSpeed: number, tick: number): void {
    const rec = this.registry.get(id);
    if (rec?.fieldRock !== true || rec.fieldAwake === true) return;
    const other = this.registry.get(otherId);
    if (!fieldRockWakes(fieldRockMass(rec.radius), other, this.massOf(otherId, other), closingSpeed)) return;
    this.wakeRock(id, otherId, tick);
  }

  /** The body mass of contact party `id` (registry record `rec`, if any): a
   *  field rock's `fieldRockMass`, an AI hull's or a pilot ship's
   *  `shipBodyMass`; undefined for anything else (asteroid, scrap, wreck,
   *  structure), which then never wakes a rock. No allocation. */
  private massOf(id: string, rec: SwarmEntityRecord | null | undefined): number | undefined {
    if (rec?.fieldRock === true) return fieldRockMass(rec.radius);
    if (rec?.kind === SWARM_KIND_DRONE) return shipBodyMass(getShipKind(rec.shipKind ?? null));
    if (rec) return undefined;
    return this.hooks.shipMass?.(id);
  }

  /** Rock `key` was broken up (its pieces are live wrecks now): it is never
   *  cut whole again, here or after its chunk reloads. `field_consumed` tells
   *  the room (C3); it also clears any moved pose the clients hold. */
  markConsumed(key: number): void {
    if (this.consumed.has(key)) return;
    this.consumed.add(key);
    this.minedPool.delete(key);
    this.movedPose.delete(key);
    this.save(key);
    this.hooks.broadcast('field_consumed', { k: key });
  }

  /** One rock's whole record to the save, an absolute upsert (a discrete
   *  event, never per tick). */
  private save(rockKey: number): void {
    const store = this.hooks.records;
    if (!store) return;
    const p = this.movedPose.get(rockKey);
    store.put({
      type: 'TERRAIN_RECORD_PUT', sectorKey: store.sectorKey, rockKey, layoutVersion: FIELD_LAYOUT_VERSION,
      pool: this.minedPool.get(rockKey) ?? null, consumed: this.consumed.has(rockKey),
      pose: p ? { x: p.x, y: p.y, angle: p.angle } : null, ts: this.gameClock.now(),
    });
  }

  /** The saved record, once at start. Rows cut under another
   *  FIELD_LAYOUT_VERSION name other rocks: ignored (one warning), and
   *  overwritten if their key is written again. */
  private loadRecords(): void {
    const store = this.hooks.records;
    if (!store) return;
    let stale = 0;
    for (const r of store.load()) {
      if (r.layoutVersion !== FIELD_LAYOUT_VERSION) { stale++; continue; }
      if (r.consumed) { this.consumed.add(r.rockKey); continue; }
      if (r.pool !== null) this.minedPool.set(r.rockKey, r.pool);
      if (r.pose !== null) this.movedPose.set(r.rockKey, { x: r.pose.x, y: r.pose.y, angle: r.pose.angle });
    }
    if (stale > 0) store.warn({ sectorKey: store.sectorKey, stale, layoutVersion: FIELD_LAYOUT_VERSION }, 'terrain_records: rows from another field layout ignored');
  }

  /** Spread into every welcome: the seed, the clearings (F4, when any), the
   *  consumed keys (C3) and the moved rocks' poses (C2), #16. A join is
   *  rare, so the lists are built per call. */
  /** The field's layout options (the nav maps are built from them, #15). */
  get navOpts(): ChunkOpts { return this.opts; }

  get welcome(): { cutField: CutFieldWelcome } {
    const cutField: CutFieldWelcome = { seed: this.seed };
    const clearings = this.opts.clearings;
    if (clearings?.length) cutField.clearings = clearings.map((c) => ({ x: c.x, y: c.y, r: c.r }));
    if (this.consumed.size > 0) {
      const consumed: number[] = cutField.consumed = [];
      for (const k of this.consumed) { if (consumed.length >= MAX_WELCOME_CONSUMED_ROCKS) break; consumed.push(k); }
    }
    if (this.movedPose.size > 0) {
      const moved: FieldRockPose[] = cutField.moved = [];
      for (const [k, p] of this.movedPose) { if (moved.length >= MAX_WELCOME_MOVED_ROCKS) break; moved.push({ k, x: p.x, y: p.y, a: p.angle }); }
    }
    return { cutField };
  }

  isConsumed(key: number): boolean {
    return this.consumed.has(key);
  }

  /** Placement (C5): push onto `out` the field rocks reaching into `box` that
   *  have no body right now (their chunk is not loaded), cut from the layout
   *  (`fieldRocksInBox`), as their bounding circle plus the convex parts their
   *  collider would have (`fieldRockBody`; none ⇒ the outline's convex hull,
   *  as the collider), at rest: the same obstacle a live rock gives (C5b). A
   *  broken-up rock is gone; a live one is already in `out` from the registry.
   *  A discrete player action, never per tick. */
  dormantObstacles(box: ObstacleBox, out: GridObstacle[]): void {
    for (const r of fieldRocksInBox(this.opts, box.x0, box.y0, box.x1, box.y1)) {
      if (this.consumed.has(r.key) || this.registry.get(fieldRockId(r.key))) continue;
      const b = fieldRockBody(r);
      const at = this.movedPose.get(r.key); // a moved rock, where it was left (C2)
      out.push({ x: at?.x ?? r.x, y: at?.y ?? r.y, radius: r.radius, angle: at?.angle ?? 0, parts: rockObstacleParts(b.verts, b.parts, true) });
    }
  }

  /** The field's ore at field rock `rec`'s rest centre, into `out` (what a
   *  harvester or Miner draws from it). False for anything else. No
   *  allocation. */
  oreAtCentre(rec: SwarmEntityRecord, out: OreConc): boolean {
    if (rec.fieldRock !== true || rec.restX === undefined || rec.restY === undefined) return false;
    oreAt(this.oreBase, SLICED.radius, rec.restX, rec.restY, out);
    return true;
  }

  /** The field's ore at world (x, y) on anything cut from a field rock whose
   *  rest centre (restX, restY) now sits at (poseX, poseY) turned by `angle`
   *  (`toRestFrame`), into `out`. For the pieces of a broken-up rock (salvage
   *  rock cut), which keep their parent's rest frame. No allocation. */
  oreAtRest(restX: number, restY: number, poseX: number, poseY: number, angle: number, x: number, y: number, out: OreConc): OreConc {
    const p = toRestFrame(restX, restY, poseX, poseY, angle, x, y, this.restPt);
    return oreAt(this.oreBase, SLICED.radius, p.x, p.y, out);
  }

  /** Wake a sleeping field rock for a reason other than a touch (a mining
   *  laser about to cut it). Same per-tick cap. True when it is awake after the
   *  call; false for anything that is not a field rock, or when the cap is hit
   *  (try again next tick). */
  wakeRock(id: string, by: string, tick: number): boolean {
    const rec = this.registry.get(id);
    if (rec?.fieldRock !== true) return false;
    if (rec.fieldAwake === true) return true;
    if (tick !== this.wakeTick) { this.wakeTick = tick; this.wakesThisTick = 0; }
    if (this.wakesThisTick >= FIELD_WAKES_PER_TICK) return false;
    this.wakesThisTick++;
    rec.fieldAwake = true;
    this.hooks.post({ type: 'UNFIX_BODY', entityId: id });
    serverLogEvent('field_rock_woke', { id, by, tick });
    return true;
  }
}

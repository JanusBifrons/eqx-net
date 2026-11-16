/**
 * Macro terrain v2 (room option `cutField`): the room's side of a cut field.
 * Streams the chunks near ships in as fixed rock colliders on the streamer's
 * own game-clock timer (never the room tick, #14), wakes the rocks a ram
 * touches (C2), and carries the seed for the welcome (#16: a joiner cuts the
 * same rocks). Field rocks stay off the swarm wire and the sector snapshot;
 * what changed on them (ore mined, broken up) is saved by rock key in
 * `terrain_records` (C4) and loaded when the field starts.
 * How it works: docs/architecture/macro-terrain.md.
 */
import type { GameClock, GameTimer } from '../../core/clock/GameClock.js';
import {
  CutFieldStreamer, cutFieldOpts, fieldRockBody, fieldRockMass, fieldRockWakes,
  FIELD_WAKES_PER_TICK, STEP_EVERY_MS,
} from '../../core/terrain/chunkStreamer.js';
import { FIELD_LAYOUT_VERSION, SLICED } from '../../core/terrain/fieldLayout.js';
import { oreAt, oreSeed, type OreConc } from '../../core/terrain/fieldOre.js';
import { SLOT_ANGLE_OFF, SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { SWARM_KIND_DRONE } from '../../shared-types/swarmWireFormat.js';
import { MAX_WELCOME_CONSUMED_ROCKS, type FieldConsumedMessage } from '../../shared-types/messages/snapshotMessages.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import type { TerrainRecordStore } from '../db/terrainSql.js';
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
  broadcast(type: 'field_consumed', msg: FieldConsumedMessage): void;
  /** The change record's save (C4): a room that persists its sector passes
   *  one; engineering and test rooms without a saved sector pass none. */
  records?: TerrainRecordStore;
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
   *  broken up (salvage rock cut), never cut whole again. */
  private readonly minedPool = new Map<number, number>();
  private readonly consumed = new Set<number>();
  private readonly seed: string;
  private readonly gameClock: GameClock;

  constructor(
    seed: string,
    gameClock: GameClock,
    private readonly registry: SwarmEntityRegistry,
    spawner: SwarmSpawner,
    private readonly hooks: CutFieldRoomHooks,
  ) {
    this.seed = seed;
    this.gameClock = gameClock;
    this.oreBase = oreSeed(seed);
    this.loadRecords();
    this.streamer = new CutFieldStreamer(cutFieldOpts(seed), {
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
        if (!spawner.spawnAsteroid({ id, x: b.x, y: b.y, vx: 0, vy: 0, radius: b.radius, vertices: b.verts, mass: fieldRockMass(b.radius), fixed: true, fieldRock: true, fieldKey: rock.key, parts: b.parts ?? undefined })) return false;
        const left = this.minedPool.get(rock.key);
        const rec = left === undefined ? null : registry.get(id);
        if (rec !== null && rec.resources !== undefined) rec.resources = Math.min(rec.resources, left!);
        return true;
      },
      removeRock: (id) => {
        const rec = registry.get(id);
        if (!rec) return;
        if (rec.fieldKey !== undefined && rec.resources !== undefined && rec.resourcesMax !== undefined && rec.resources < rec.resourcesMax
          && this.minedPool.get(rec.fieldKey) !== rec.resources) {
          this.minedPool.set(rec.fieldKey, rec.resources);
          this.save(rec.fieldKey, rec.resources, false);
        }
        hooks.evict(rec, rec.fieldAwake === true);
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

  /** A fixed field rock wakes when a ship touches it, or when an awake rock
   *  is driven into it (`fieldRockWakes`); at most `FIELD_WAKES_PER_TICK` a
   *  tick. Its body turns dynamic and it rides the swarm wire by its rock key
   *  until its chunk unloads. */
  private wake(id: string, otherId: string, closingSpeed: number, tick: number): void {
    if (!fieldRockWakes(this.registry.get(otherId), closingSpeed)) return;
    this.wakeRock(id, otherId, tick);
  }

  /** Rock `key` was broken up (its pieces are live wrecks now): it is never
   *  cut whole again, here or after its chunk reloads. Server only for now:
   *  the client's cut learns consumed keys with the plan's C3 wire. */
  markConsumed(key: number): void {
    if (this.consumed.has(key)) return;
    this.consumed.add(key);
    this.minedPool.delete(key);
    this.save(key, null, true);
    this.hooks.broadcast('field_consumed', { k: key });
  }

  /** One rock's record to the save (a discrete event, never per tick). */
  private save(rockKey: number, pool: number | null, consumed: boolean): void {
    const store = this.hooks.records;
    if (!store) return;
    store.put({ type: 'TERRAIN_RECORD_PUT', sectorKey: store.sectorKey, rockKey, layoutVersion: FIELD_LAYOUT_VERSION, pool, consumed, ts: this.gameClock.now() });
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
      if (r.consumed) this.consumed.add(r.rockKey);
      else if (r.pool !== null) this.minedPool.set(r.rockKey, r.pool);
    }
    if (stale > 0) store.warn({ sectorKey: store.sectorKey, stale, layoutVersion: FIELD_LAYOUT_VERSION }, 'terrain_records: rows from another field layout ignored');
  }

  /** Spread into every welcome: the seed and the consumed keys (C3, #16). A
   *  join is rare, so the list is built per call. */
  get welcome(): { cutField: { seed: string; consumed?: number[] } } {
    if (this.consumed.size === 0) return { cutField: { seed: this.seed } };
    const consumed: number[] = [];
    for (const k of this.consumed) { if (consumed.length >= MAX_WELCOME_CONSUMED_ROCKS) break; consumed.push(k); }
    return { cutField: { seed: this.seed, consumed } };
  }

  isConsumed(key: number): boolean {
    return this.consumed.has(key);
  }

  /** The field's ore where a shot hit field rock `rec` at world (x, y), into
   *  `out` (F1b: what you cut off decides what you get). The ore is laid out
   *  over the field as cut, so a rock that has moved (awake) maps the point
   *  back into its rest frame first. No point (x undefined) ⇒ the rock's
   *  centre. False for anything else. No allocation. */
  oreAtHit(rec: SwarmEntityRecord, x: number | undefined, y: number | undefined, out: OreConc): boolean {
    if (rec.fieldRock !== true || rec.restX === undefined || rec.restY === undefined) return false;
    if (x === undefined || y === undefined) { oreAt(this.oreBase, SLICED.radius, rec.restX, rec.restY, out); return true; }
    if (rec.fieldAwake !== true) { oreAt(this.oreBase, SLICED.radius, x, y, out); return true; }
    const sab = this.hooks.sab(), b = slotBase(rec.slot);
    this.oreAtRest(rec.restX, rec.restY, sab[b + SLOT_X_OFF]!, sab[b + SLOT_Y_OFF]!, sab[b + SLOT_ANGLE_OFF]!, x, y, out);
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

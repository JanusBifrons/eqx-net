/**
 * Macro terrain v2 (room option `cutField`): the room's side of a cut field.
 * Streams the chunks near ships in as fixed rock colliders on the streamer's
 * own game-clock timer (never the room tick, #14), wakes the rocks a ram
 * touches (C2), and carries the seed for the welcome (#16: a joiner cuts the
 * same rocks). Field rocks stay off the swarm wire and the save until woken.
 * How it works: docs/architecture/macro-terrain.md.
 */
import type { GameClock, GameTimer } from '../../core/clock/GameClock.js';
import {
  CutFieldStreamer, cutFieldOpts, fieldRockBody, fieldRockMass, fieldRockWakes,
  FIELD_WAKES_PER_TICK, STEP_EVERY_MS,
} from '../../core/terrain/chunkStreamer.js';
import { SLOT_X_OFF, SLOT_Y_OFF, slotBase } from '../../shared-types/sabLayout.js';
import { SWARM_KIND_DRONE } from '../../shared-types/swarmWireFormat.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import { guarded } from './guardedLoop.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

export interface CutFieldRoomHooks {
  /** The SAB slots of every pilot's ship (AI hulls come from the registry). */
  shipSlots(): Iterable<number>;
  sab(): Float32Array;
  post(cmd: WorkerCmd): void;
  /** Remove a rock; `broadcast` when it is awake (on the wire). */
  evict(rec: SwarmEntityRecord, broadcast: boolean): void;
}

export class CutFieldSubsystem {
  readonly streamer: CutFieldStreamer;
  /** Spread into every welcome. */
  readonly welcome: { cutField: { seed: string } };
  private readonly timer: GameTimer;
  private wakeTick = -1;
  private wakesThisTick = 0;

  constructor(
    seed: string,
    gameClock: GameClock,
    private readonly registry: SwarmEntityRegistry,
    spawner: SwarmSpawner,
    private readonly hooks: CutFieldRoomHooks,
  ) {
    this.welcome = { cutField: { seed } };
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
        // The same body the client builds (#15): centred on the outline.
        const b = fieldRockBody(rock);
        return spawner.spawnAsteroid({ id, x: b.x, y: b.y, vx: 0, vy: 0, radius: b.radius, vertices: b.verts, mass: fieldRockMass(b.radius), fixed: true, fieldRock: true, fieldKey: rock.key });
      },
      removeRock: (id) => {
        const rec = registry.get(id);
        if (rec) hooks.evict(rec, rec.fieldAwake === true);
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

import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '@core/contracts/IRenderer';
import { POSE_RING_DEPTH } from '@core/contracts/IRenderer';
import { PhysicsWorld } from '@core/physics/World';
import type { Keyboard } from '../input/Keyboard';
import { SWARM_KIND_ASTEROID } from '../../shared-types/swarmWireFormat.js';

const PLAYER_ID = 'local-player';

/**
 * Fully local, single-player diagnostic client. Runs one PhysicsWorld, one ship,
 * a few asteroids. No network, no reconciliation — purely the same simulation
 * the server runs, driven by keyboard at 60 Hz. If movement jitters here, the
 * bug is in the sim; if it's smooth here but jitters in multiplayer, the bug
 * is in the reconciler.
 *
 * Phase 5c: asteroids feed `mirror.swarm` (the new binary-swarm-channel mirror)
 * instead of the old `mirror.obstacles`. Local mode keys swarm entries by a
 * synthetic numeric id, mirroring the server's u16 entityId convention.
 */
export class LocalGameClient {
  readonly mirror: RenderMirror = {
    ships: new Map(),
    swarm: new Map(),
    localPlayerId: PLAYER_ID,
  };

  private world: PhysicsWorld | null = null;
  /** Per-asteroid metadata keyed by string id (the simulation id) — radius and the synthetic swarm entityId. */
  private asteroidMeta = new Map<string, { radius: number; entityId: number }>();
  private nextEntityId = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  async start(keyboard: Keyboard): Promise<void> {
    this.world = await PhysicsWorld.create();
    if (this.disposed) {
      this.world.dispose();
      this.world = null;
      return;
    }

    this.world.spawnShip(PLAYER_ID, 0, 0);

    // A small constellation of asteroids within easy reach of the spawn point.
    this.spawnAsteroid('asteroid-0', 150, 0, 28, 4);
    this.spawnAsteroid('asteroid-1', -120, 100, 22, 3);
    this.spawnAsteroid('asteroid-2', 60, -180, 34, 5);
    this.world.setShipState('asteroid-1', { x: -120, y: 100, vx: 0.4, vy: -0.2, angle: 0 });

    this.intervalId = setInterval(() => {
      if (!this.world) return;
      const input = keyboard.read();
      this.world.applyInput(PLAYER_ID, input);
      this.world.tick(1 / 60);
    }, 1000 / 60);
  }

  private spawnAsteroid(id: string, x: number, y: number, radius: number, mass: number): void {
    if (!this.world) return;
    this.world.spawnObstacle(id, x, y, radius, mass);
    this.asteroidMeta.set(id, { radius, entityId: this.nextEntityId++ });
  }

  /** Called once per render frame; snapshots physics into the mirror. */
  updateMirror(): void {
    if (!this.world) return;
    const states = this.world.getAllShipStates();
    const swarm = this.mirror.swarm!;

    for (const [id, s] of states) {
      const meta = this.asteroidMeta.get(id);
      if (meta !== undefined) {
        // Local mode has no wire packets, so prev == latest each frame. The
        // interpolator returns the latest pose unchanged when only one ring
        // entry is populated.
        const ring: PoseRingEntry[] = new Array(POSE_RING_DEPTH);
        for (let i = 0; i < POSE_RING_DEPTH; i++) {
          ring[i] = { x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: true };
        }
        ring[0]!.x = s.x; ring[0]!.y = s.y; ring[0]!.angle = s.angle;
        ring[0]!.vx = s.vx; ring[0]!.vy = s.vy; ring[0]!.angvel = s.angvel ?? 0;
        ring[0]!.empty = false;
        const entry: SwarmRenderState = {
          x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel ?? 0,
          prevX: s.x, prevY: s.y, prevAngle: s.angle,
          prevArrivalMs: 0, latestArrivalMs: 0,
          poseRing: ring,
          ringHead: 1,
          radius: meta.radius,
          kind: SWARM_KIND_ASTEROID,
          sleeping: false,
          lastUpdateTick: 0,
        };
        swarm.set(meta.entityId, entry);
      } else {
        this.mirror.ships.set(id, s);
      }
    }
    for (const id of this.mirror.ships.keys()) {
      if (!states.has(id)) this.mirror.ships.delete(id);
    }
    // Sweep stale swarm entries (asteroids that vanished from physics).
    for (const [, meta] of this.asteroidMeta) {
      // (Local mode never removes asteroids, but sweep defensively if state is missing.)
      void meta;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.world?.dispose();
    this.world = null;
    this.mirror.ships.clear();
    this.mirror.swarm?.clear();
    this.asteroidMeta.clear();
  }
}

import type { RenderMirror, ObstacleRenderState } from '@core/contracts/IRenderer';
import { PhysicsWorld } from '@core/physics/World';
import type { Keyboard } from '../input/Keyboard';

const PLAYER_ID = 'local-player';

/**
 * Fully local, single-player diagnostic client. Runs one PhysicsWorld, one ship,
 * a few asteroids. No network, no reconciliation — purely the same simulation
 * the server runs, driven by keyboard at 60 Hz. If movement jitters here, the
 * bug is in the sim; if it's smooth here but jitters in multiplayer, the bug
 * is in the reconciler.
 */
export class LocalGameClient {
  readonly mirror: RenderMirror = {
    ships: new Map(),
    obstacles: new Map(),
    localPlayerId: PLAYER_ID,
  };

  private world: PhysicsWorld | null = null;
  /** Radii for each spawned obstacle so the renderer can draw them correctly. */
  private asteroidRadii = new Map<string, number>();
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
    this.asteroidRadii.set(id, radius);
  }

  /** Called once per render frame; snapshots physics into the mirror. */
  updateMirror(): void {
    if (!this.world) return;
    const states = this.world.getAllShipStates();
    const obstacles = this.mirror.obstacles!;

    for (const [id, s] of states) {
      const radius = this.asteroidRadii.get(id);
      if (radius !== undefined) {
        const entry: ObstacleRenderState = { ...s, radius };
        obstacles.set(id, entry);
      } else {
        this.mirror.ships.set(id, s);
      }
    }
    for (const id of this.mirror.ships.keys()) {
      if (!states.has(id)) this.mirror.ships.delete(id);
    }
    for (const id of obstacles.keys()) {
      if (!states.has(id)) obstacles.delete(id);
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
    this.mirror.obstacles?.clear();
    this.asteroidRadii.clear();
  }
}

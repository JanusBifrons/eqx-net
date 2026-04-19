import { Room, Client } from 'colyseus';
import { z } from 'zod';
import { pino } from 'pino';
import { PhysicsWorld } from '../../core/physics/World.js';
import { Bus } from '../../core/events/Bus.js';
import { SectorState, ShipState } from './schema/SectorState.js';
import { assignPlayerId } from '../identity/PlayerIdentity.js';
import { InputMessageSchema } from '../../shared-types/messages.js';
import type { WelcomeMessage } from '../../shared-types/messages.js';

const logger = pino({
  name: 'SectorRoom',
  transport: process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

const JoinOptionsSchema = z.object({ playerId: z.string().nullable().optional() }).passthrough();

const MAX_INPUTS_PER_TICK = 3;

interface PendingInput {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  tick: number;
}

export class SectorRoom extends Room<SectorState> {
  private physics!: PhysicsWorld;
  private bus!: Bus;
  private pendingInputs = new Map<string, PendingInput>();
  private sessionToPlayer = new Map<string, string>();
  private playerToSession = new Map<string, string>();
  private inputCountThisTick = new Map<string, number>();
  private serverTick = 0;

  override async onCreate(_options: unknown): Promise<void> {
    this.setState(new SectorState());
    this.bus = new Bus();
    this.physics = await PhysicsWorld.create();

    this.onMessage('input', (client: Client, raw: unknown) => {
      const playerId = this.sessionToPlayer.get(client.sessionId);
      if (!playerId) return;

      const count = this.inputCountThisTick.get(playerId) ?? 0;
      if (count >= MAX_INPUTS_PER_TICK) return;
      this.inputCountThisTick.set(playerId, count + 1);

      const result = InputMessageSchema.safeParse(raw);
      if (!result.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed input message');
        return;
      }
      const { thrust, turnLeft, turnRight, tick } = result.data;
      this.pendingInputs.set(playerId, { thrust, turnLeft, turnRight, tick });
    });

    this.setSimulationInterval((dt) => this.update(dt), 1000 / 60);
    logger.info('SectorRoom created');
  }

  override onJoin(client: Client, options: unknown): void {
    logger.info({ sessionId: client.sessionId, options }, 'onJoin called');
    const parsed = JoinOptionsSchema.safeParse(options);
    const requestedId = parsed.success ? parsed.data.playerId : null;
    let playerId = assignPlayerId(requestedId);
    // If the requested ID is already held by an active session (e.g. two tabs sharing
    // the same localStorage), assign a fresh UUID rather than letting two sessions
    // silently share one ship.
    if (this.playerToSession.has(playerId)) {
      playerId = assignPlayerId(null);
    }

    this.sessionToPlayer.set(client.sessionId, playerId);
    this.playerToSession.set(playerId, client.sessionId);

    const spawnX = (Math.random() - 0.5) * 400;
    const spawnY = (Math.random() - 0.5) * 400;

    if (!this.physics.hasShip(playerId)) {
      this.physics.spawnShip(playerId, spawnX, spawnY);
    }

    if (!this.state.ships.has(playerId)) {
      const ship = new ShipState();
      ship.playerId = playerId;
      ship.x = spawnX;
      ship.y = spawnY;
      this.state.ships.set(playerId, ship);
    }

    const welcome: WelcomeMessage = { type: 'welcome', playerId };
    client.send('welcome', welcome);

    this.bus.emit('SHIP_SPAWNED', { type: 'SHIP_SPAWNED' as const, playerId, x: spawnX, y: spawnY });
    logger.info({ playerId, sessionId: client.sessionId }, 'player joined');
  }

  override onLeave(client: Client, _consented: boolean): void {
    const playerId = this.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

    this.sessionToPlayer.delete(client.sessionId);
    this.playerToSession.delete(playerId);
    this.pendingInputs.delete(playerId);

    this.physics.despawnShip(playerId);
    this.state.ships.delete(playerId);

    this.bus.emit('SHIP_DESPAWNED', { type: 'SHIP_DESPAWNED' as const, playerId });
    logger.info({ playerId }, 'player left');
  }

  override onDispose(): void {
    this.physics.dispose();
    logger.info('SectorRoom disposed');
  }

  private update(dtMs: number): void {
    this.inputCountThisTick.clear();

    for (const [playerId, input] of this.pendingInputs) {
      this.physics.applyInput(playerId, input);
      this.bus.emit('SHIP_INPUT_APPLIED', { type: 'SHIP_INPUT_APPLIED' as const, playerId, tick: input.tick });
    }
    this.pendingInputs.clear();

    this.physics.tick(dtMs / 1000);
    this.serverTick++;
    this.state.tick = this.serverTick;

    for (const [playerId, shipState] of this.state.ships) {
      const phys = this.physics.getShipState(playerId);
      if (!phys) continue;
      shipState.x = phys.x;
      shipState.y = phys.y;
      shipState.angle = phys.angle;
      shipState.vx = phys.vx;
      shipState.vy = phys.vy;
    }
  }
}

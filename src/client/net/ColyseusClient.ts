import { Client, Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { WelcomeMessage } from '@shared-types/messages';
import { useUIStore, type ConnectionStatus } from '../state/store';

export interface ColyseusClientCallbacks {
  onConnectionStatus: (s: ConnectionStatus) => void;
  onPlayerId: (id: string) => void;
}

export class ColyseusGameClient {
  readonly mirror: RenderMirror = {
    ships: new Map(),
    localPlayerId: null,
  };

  private room: Room | null = null;
  private inputTick = 0;
  private inputIntervalId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  async connect(
    wsUrl: string,
    storedPlayerId: string | null,
    keyboard: { read: () => { thrust: boolean; turnLeft: boolean; turnRight: boolean } },
    callbacks: ColyseusClientCallbacks,
  ): Promise<void> {
    callbacks.onConnectionStatus('connecting');
    console.log('[ColyseusClient] connecting to', wsUrl, 'playerId:', storedPlayerId);
    const client = new Client(wsUrl);

    let resolvedRoom: Room;
    try {
      console.log('[ColyseusClient] calling joinOrCreate…');
      const joinPromise = client.joinOrCreate<unknown>('sector', { playerId: storedPlayerId });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('joinOrCreate timed out after 12 s — WS proxy likely broken')), 12000),
      );
      resolvedRoom = await Promise.race([joinPromise, timeoutPromise]);
    } catch (err) {
      console.error('[ColyseusClient] joinOrCreate failed:', err);
      callbacks.onConnectionStatus('error');
      throw err;
    }

    // React StrictMode calls cleanup before the async joinOrCreate resolves.
    // If disposed() fired while we were awaiting, leave immediately so the
    // server cleans up the seat and the playerId isn't persisted.
    if (this.disposed) {
      resolvedRoom.leave();
      return;
    }

    this.room = resolvedRoom;
    console.log('[ColyseusClient] joinOrCreate resolved, roomId:', this.room.roomId, 'sessionId:', this.room.sessionId);

    this.room.onMessage('welcome', (msg: WelcomeMessage) => {
      console.log('[ColyseusClient] welcome received, playerId:', msg.playerId);
      this.mirror.localPlayerId = msg.playerId;
      callbacks.onPlayerId(msg.playerId);
    });

    this.room.onStateChange((state: unknown) => {
      this.syncMirror(state);
    });

    this.room.onLeave((code) => {
      console.warn('[ColyseusClient] left room, code:', code);
      callbacks.onConnectionStatus('disconnected');
      this.stopInputLoop();
    });

    this.room.onError((code, message) => {
      console.error('[ColyseusClient] room error', code, message);
      callbacks.onConnectionStatus('error');
    });

    callbacks.onConnectionStatus('connected');
    console.log('[ColyseusClient] connected — starting input loop');
    this.startInputLoop(keyboard);
  }

  private syncMirror(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const ships = s['ships'] as Map<string, unknown> | undefined;
    if (!ships) return;

    const seen = new Set<string>();
    for (const [playerId, ship] of ships.entries()) {
      const sh = ship as Record<string, unknown>;
      seen.add(playerId);
      this.mirror.ships.set(playerId, {
        x: Number(sh['x'] ?? 0),
        y: Number(sh['y'] ?? 0),
        angle: Number(sh['angle'] ?? 0),
        vx: Number(sh['vx'] ?? 0),
        vy: Number(sh['vy'] ?? 0),
      });
    }

    for (const key of this.mirror.ships.keys()) {
      if (!seen.has(key)) this.mirror.ships.delete(key);
    }

    useUIStore.getState().setShipCount(this.mirror.ships.size);
  }

  private startInputLoop(keyboard: { read: () => { thrust: boolean; turnLeft: boolean; turnRight: boolean } }): void {
    this.inputIntervalId = setInterval(() => {
      if (!this.room) return;
      const { thrust, turnLeft, turnRight } = keyboard.read();
      this.room.send('input', {
        type: 'input',
        tick: this.inputTick++,
        thrust,
        turnLeft,
        turnRight,
      });
    }, 1000 / 60);
  }

  private stopInputLoop(): void {
    if (this.inputIntervalId !== null) {
      clearInterval(this.inputIntervalId);
      this.inputIntervalId = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopInputLoop();
    this.room?.leave();
    this.room = null;
  }
}

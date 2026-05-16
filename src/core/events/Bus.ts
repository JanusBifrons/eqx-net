export interface BusEventPayloads {
  SHIP_SPAWNED: { type: 'SHIP_SPAWNED'; playerId: string; x: number; y: number };
  SHIP_DESPAWNED: { type: 'SHIP_DESPAWNED'; playerId: string };
  SHIP_INPUT_APPLIED: { type: 'SHIP_INPUT_APPLIED'; playerId: string; tick: number };
  LASER_FIRED: { type: 'LASER_FIRED'; shooterId: string; x: number; y: number; angle: number };
  PLAYER_DAMAGED: { type: 'PLAYER_DAMAGED'; targetId: string; damage: number; newHealth: number };
  SHIP_DESTROYED: { type: 'SHIP_DESTROYED'; targetId: string; shooterId: string };
  ENTITY_DESTROYED: { type: 'ENTITY_DESTROYED'; entityId: string };
  ENTITY_SHED: { type: 'ENTITY_SHED'; entityId: string };
  ENTITY_SLEPT: { type: 'ENTITY_SLEPT'; entityId: string };
  ENTITY_WOKE: { type: 'ENTITY_WOKE'; entityId: string };
  TIDI_RATE_CHANGED: { type: 'TIDI_RATE_CHANGED'; rate: number };
  TRANSIT_STATE_CHANGED: {
    type: 'TRANSIT_STATE_CHANGED';
    playerId: string;
    state: 'DOCKED' | 'SPOOLING' | 'IN_TRANSIT' | 'ARRIVED';
  };
  /** Living World — a director-owned bot was spawned into a sector
   *  (initial placement, inter-sector arrival, or no-origin respawn).
   *  Discrete + low-frequency; subscribers are telemetry/logging only. */
  BOT_SPAWNED: {
    type: 'BOT_SPAWNED';
    botId: string;
    sectorKey: string | null;
    x: number;
    y: number;
  };
  /** Living World — a director-owned bot left a sector via the quiet
   *  inter-sector handoff. NOT a combat kill (that flows through
   *  `ENTITY_DESTROYED`) nor a load-shed (`ENTITY_SHED`). */
  BOT_DESPAWNED: {
    type: 'BOT_DESPAWNED';
    botId: string;
    sectorKey: string | null;
    reason: 'transit';
  };
  /** Living World — a bot began an inter-sector warp (spool start). The
   *  spool/commit lifecycle itself rides the existing
   *  `TRANSIT_STATE_CHANGED` (botId in the `playerId` field); this variant
   *  additionally carries the route for population telemetry. */
  BOT_TRANSIT_STARTED: {
    type: 'BOT_TRANSIT_STARTED';
    botId: string;
    from: string;
    to: string;
  };
  /** Stage 2 of the network-feel roadmap. The server's physics worker
   *  resolved a collision above the impulse floor; subscribers (telemetry,
   *  network broadcast) get the post-collision velocities of both bodies
   *  for immediate downstream propagation. */
  COLLISION_RESOLVED: {
    type: 'COLLISION_RESOLVED';
    aId: string;
    bId: string;
    vA: { x: number; y: number };
    vB: { x: number; y: number };
    impulse: number;
    tick: number;
  };
  /** Shield 0-cross: shield was >0 and is now exactly 0 (Phase: shield).
   *  Drives the collider->polygon swap audit + shield-shatter SFX. */
  SHIELD_BROKEN: { type: 'SHIELD_BROKEN'; entityId: string };
  /** Shield regenerated back above 0 after the Halo delay (Phase: shield).
   *  Drives the collider->circle swap + shield-up SFX. */
  SHIELD_RESTORED: { type: 'SHIELD_RESTORED'; entityId: string };
}

export type BusEventType = keyof BusEventPayloads;

type ListenerMap = {
  [K in BusEventType]?: Set<(payload: BusEventPayloads[K]) => void>;
};

export class Bus {
  private listeners: ListenerMap = {};

  emit<K extends BusEventType>(event: K, payload: BusEventPayloads[K]): void {
    const fns = this.listeners[event] as Set<(p: BusEventPayloads[K]) => void> | undefined;
    if (fns) for (const fn of fns) fn(payload);
  }

  on<K extends BusEventType>(event: K, fn: (payload: BusEventPayloads[K]) => void): this {
    if (!this.listeners[event]) {
      (this.listeners as Record<string, Set<unknown>>)[event] = new Set();
    }
    (this.listeners[event] as Set<(p: BusEventPayloads[K]) => void>).add(fn);
    return this;
  }

  off<K extends BusEventType>(event: K, fn: (payload: BusEventPayloads[K]) => void): this {
    (this.listeners[event] as Set<(p: BusEventPayloads[K]) => void> | undefined)?.delete(fn);
    return this;
  }

  once<K extends BusEventType>(event: K, fn: (payload: BusEventPayloads[K]) => void): this {
    const wrapper = (payload: BusEventPayloads[K]): void => {
      fn(payload);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  removeAllListeners(event?: BusEventType): this {
    if (event) {
      delete this.listeners[event];
    } else {
      this.listeners = {};
    }
    return this;
  }
}

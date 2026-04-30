export interface BusEventPayloads {
  SHIP_SPAWNED: { type: 'SHIP_SPAWNED'; playerId: string; x: number; y: number };
  SHIP_DESPAWNED: { type: 'SHIP_DESPAWNED'; playerId: string };
  SHIP_INPUT_APPLIED: { type: 'SHIP_INPUT_APPLIED'; playerId: string; tick: number };
  LASER_FIRED: { type: 'LASER_FIRED'; shooterId: string; x: number; y: number; angle: number };
  PLAYER_DAMAGED: { type: 'PLAYER_DAMAGED'; targetId: string; damage: number; newHealth: number };
  SHIP_DESTROYED: { type: 'SHIP_DESTROYED'; targetId: string; shooterId: string };
  ENTITY_DESTROYED: { type: 'ENTITY_DESTROYED'; entityId: string };
  ENTITY_SLEPT: { type: 'ENTITY_SLEPT'; entityId: string };
  ENTITY_WOKE: { type: 'ENTITY_WOKE'; entityId: string };
  TIDI_RATE_CHANGED: { type: 'TIDI_RATE_CHANGED'; rate: number };
  TRANSIT_STATE_CHANGED: {
    type: 'TRANSIT_STATE_CHANGED';
    playerId: string;
    state: 'DOCKED' | 'SPOOLING' | 'IN_TRANSIT' | 'ARRIVED';
  };
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

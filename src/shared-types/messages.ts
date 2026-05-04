import { z } from 'zod';

export const InputMessageSchema = z
  .object({
    type: z.literal('input'),
    tick: z.number().int().nonnegative(),
    thrust: z.boolean(),
    turnLeft: z.boolean(),
    turnRight: z.boolean(),
    /** Shift-held boost — multiplies thrust impulse server-side. Optional for
     *  back-compat with clients that pre-date this field. */
    boost: z.boolean().optional(),
  })
  .strict();

export const IdentifyMessageSchema = z
  .object({
    type: z.literal('identify'),
    playerId: z.string().uuid().nullable(),
  })
  .strict();

export const FireMessageSchema = z
  .object({
    type: z.literal('fire'),
    tick: z.number().int().nonnegative(),
    clientShotId: z.string(),
    weapon: z.enum(['hitscan', 'projectile']).default('hitscan'),
    rayFromX: z.number(),
    rayFromY: z.number(),
    rayDirX: z.number(),
    rayDirY: z.number(),
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion('type', [
  InputMessageSchema,
  IdentifyMessageSchema,
  FireMessageSchema,
]);

export type InputMessage = z.infer<typeof InputMessageSchema>;
export type IdentifyMessage = z.infer<typeof IdentifyMessageSchema>;
export type FireMessage = z.infer<typeof FireMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface WelcomeMessage {
  type: 'welcome';
  playerId: string;
  /** Server physics tick at the moment the player joined. Client seeds inputTick from this. */
  serverTick: number;
  /** Phase 8 — stable galaxy sector key (e.g. 'sol-prime'), or null in
   *  engineering rooms (test-sector, swarm-soak, etc.) which have no
   *  persistent identity. */
  sectorKey: string | null;
}

/** Authoritative snapshot broadcast by the server at 20 Hz for client-side
 *  reconciliation. Phase 5c: `obstacles` removed — asteroids and drones now
 *  flow through the binary swarm channel (see `client.send('swarm', buf)`)
 *  instead of being carried on every snapshot. */
export interface SnapshotMessage {
  type: 'snapshot';
  serverTick: number;
  /** Authoritative ship states at the time the snapshot was taken. */
  states: Record<string, { x: number; y: number; vx: number; vy: number; angle: number; angvel: number }>;
  /** Last client input tick acknowledged by the server for each player. */
  ackedTicks: Record<string, number>;
  /** Set of playerIds currently holding boost (shift). Renderer draws an
   *  exhaust trail for each. Absent / empty when nobody is boosting. */
  boostingIds?: string[];
}

/** Server → client (direct): result of a fire request. */
export interface HitAckMessage {
  type: 'hit_ack';
  clientShotId: string;
  hit: boolean;
  targetId?: string;
  /** True only when the server discarded the shot (cooldown or temporal plausibility). */
  rejected?: boolean;
}

/** Server → client (broadcast): a ship took damage. */
export interface DamageEvent {
  type: 'damage';
  targetId: string;
  damage: number;
  newHealth: number;
  shooterId: string;
}

/** Server → client (broadcast): a ship was destroyed. */
export interface DestroyEvent {
  type: 'destroy';
  targetId: string;
  shooterId: string;
}

/** Server → client (direct): respawn confirmed — new position and server tick to reseed input clock. */
export interface RespawnAckMessage {
  type: 'respawn_ack';
  x: number;
  y: number;
  serverTick: number;
}

/** Server → client (broadcast): a hitscan shot was fired. Sent to ALL clients so
 *  they can render the beam. The endpoint is server-authoritative (lag-comp result). */
export interface LaserFiredEvent {
  type: 'laser_fired';
  shooterId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  hit: boolean;
  targetId?: string;
}

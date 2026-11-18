import { z } from 'zod';

/**
 * RTS command layer, slice 7 — the owner-only `fleet_status` stream.
 *
 * Server → ONE client, ~2 Hz: the status of every AI-flown ship that client's
 * player owns in this room (mode, stance, activity, order, shield...).
 *
 * WHY A MESSAGE AND NOT A SNAPSHOT FIELD (root invariant #16): the snapshot
 * goes to everyone in interest, while a wingman's mode / stance / orders are
 * PRIVATE to its owner. The stream is still state, not an event: every send
 * is the owner's FULL fleet list (the client applies it with `replace: true`),
 * repeated on a fixed cadence, so a late joiner, a reconnect or a lost frame
 * converges within one period. The only skipped sends are "still empty" ones.
 *
 * Compact wire: `s` is an array of fixed-order tuples (see `FleetStatusTuple`).
 * Enums go as indices into the tables below; append-only, never reorder.
 * The tables ARE the fleet command vocabulary: the server's fleet store, the
 * `set_mode` / `set_stance` schemas and the client UI all read them.
 */
export const FLEET_STATUS_MODES = ['patrol', 'defend', 'hunt', 'escort', 'retreat'] as const;
export const FLEET_STATUS_STANCES = ['aggressive', 'defensive', 'holdFire'] as const;
export const FLEET_STATUS_ACTIVITIES = [
  'idle', 'moving', 'patrolling', 'chasing', 'attacking', 'retreating', 'formingUp', 'guarding',
  'searching',
  // Navigation slice 9: no way fits to its goal, so it waits as close as it can get.
  'blocked',
] as const;
export const FLEET_STATUS_ORDERS = ['move', 'attack', 'stop'] as const;
/** Slot 6 (morale) is RETIRED; it still accepts the old index range so an
 *  older sender parses (fightOn / fallBack / flee). */
const RETIRED_MORALE_COUNT = 3;

/** A ship's standing job (what it does with no order in hand). */
export type FleetMode = (typeof FLEET_STATUS_MODES)[number];
/** When the ship may open fire. */
export type FleetStance = (typeof FLEET_STATUS_STANCES)[number];
/** What the ship is doing right now (the status panel's line). */
export type FleetActivity = (typeof FLEET_STATUS_ACTIVITIES)[number];
type FleetStatusOrder = (typeof FLEET_STATUS_ORDERS)[number];

/** A one-off order layered on top of the mode: done once, then the mode
 *  resumes from where the ship is. */
export type FleetOrder =
  | { readonly kind: 'move'; readonly x: number; readonly y: number }
  | { readonly kind: 'attack'; readonly targetId: string }
  | { readonly kind: 'stop' };

/** Patrol routes hold this many waypoints (fewer ⇒ defend; extra are dropped). */
export const FLEET_ROUTE_MIN = 2;
export const FLEET_ROUTE_MAX = 16;

const idx = (n: number) => z.number().int().min(0).max(n - 1);
const optIdx = (n: number) => z.number().int().min(-1).max(n - 1);
const optId = z.string().max(64).nullable();
const optNum = z.number().finite().nullable();

/**
 * One ship. Order:
 *  0 id, 1 mode idx, 2 stance idx, 3 activity idx, 4 targetId|null,
 *  5 RETIRED (was hullPct; sent null), 6 RETIRED (was morale idx; sent -1),
 *  7 squadId|null, 8 order idx (-1 none), 9 orderX|null, 10 orderY|null
 *  (move order dest), 11 escortId|null, 12 route: flat [x0,y0,x1,y1,…]
 *  (patrol) | null, 13 shieldPct (0..100 int; appended 2026-11-14, optional
 *  so an older sender still parses).
 *
 * RTS Part A (owner decision): hull % comes from room-state
 * `ShipState.health` (synced for every ship, copied onto the mirror by
 * `syncMirror`), and morale is not reported. The tuple is append-only, so
 * slots 5 and 6 stay and are never filled: the decoder ignores them, and
 * they still accept an older sender's numbers. Shield % stays here for now
 * (no per-ship shield carrier exists for parked hulls).
 */
const FleetStatusTupleSchema = z.tuple([
  z.string().min(1).max(64),
  idx(FLEET_STATUS_MODES.length),
  idx(FLEET_STATUS_STANCES.length),
  idx(FLEET_STATUS_ACTIVITIES.length),
  optId,
  z.number().int().min(0).max(100).nullable(),
  optIdx(RETIRED_MORALE_COUNT),
  optId,
  optIdx(FLEET_STATUS_ORDERS.length),
  optNum,
  optNum,
  optId,
  z.array(z.number().finite()).max(32).nullable(),
  z.number().int().min(0).max(100).optional(),
]);

export const FleetStatusMessageSchema = z
  .object({
    type: z.literal('fleet_status'),
    s: z.array(FleetStatusTupleSchema).max(256),
  })
  .strict();

export type FleetStatusTuple = z.infer<typeof FleetStatusTupleSchema>;
export type FleetStatusMessage = z.infer<typeof FleetStatusMessageSchema>;

/** Decoded row (the client's `FleetStatusUpdate` shape, minus nothing). */
export interface FleetStatusRowWire {
  id: string;
  mode: FleetMode;
  stance: FleetStance;
  activity: FleetActivity;
  targetId: string | null;
  /** Shield 0..100 (absent from an older sender). */
  shieldPct?: number;
  squadId?: string;
  orderKind?: FleetStatusOrder;
  orderX?: number;
  orderY?: number;
  escortId?: string;
  route?: [number, number][];
}

/** Encode one decoded row (tests / reference; the server fills tuples in place). */
export function encodeFleetStatusRow(r: FleetStatusRowWire): FleetStatusTuple {
  let route: number[] | null = null;
  if (r.route !== undefined) {
    route = [];
    for (const [x, y] of r.route) route.push(x, y);
  }
  const t: FleetStatusTuple = [
    r.id,
    FLEET_STATUS_MODES.indexOf(r.mode),
    FLEET_STATUS_STANCES.indexOf(r.stance),
    FLEET_STATUS_ACTIVITIES.indexOf(r.activity),
    r.targetId,
    null, // retired: hull
    -1, // retired: morale
    r.squadId ?? null,
    r.orderKind === undefined ? -1 : FLEET_STATUS_ORDERS.indexOf(r.orderKind),
    r.orderX ?? null,
    r.orderY ?? null,
    r.escortId ?? null,
    route,
  ];
  if (r.shieldPct !== undefined) t.push(r.shieldPct);
  return t;
}

/** Decode one validated tuple. */
export function decodeFleetStatusRow(t: FleetStatusTuple): FleetStatusRowWire {
  // Slots 5 and 6 are retired (hull, morale): ignored.
  const [id, mode, stance, activity, targetId, , , squadId, order, ox, oy, escortId, route, shieldPct] = t;
  const row: FleetStatusRowWire = {
    id,
    mode: FLEET_STATUS_MODES[mode]!,
    stance: FLEET_STATUS_STANCES[stance]!,
    activity: FLEET_STATUS_ACTIVITIES[activity]!,
    targetId,
  };
  if (shieldPct !== undefined) row.shieldPct = shieldPct;
  if (squadId !== null) row.squadId = squadId;
  if (order >= 0) row.orderKind = FLEET_STATUS_ORDERS[order]!;
  if (ox !== null) row.orderX = ox;
  if (oy !== null) row.orderY = oy;
  if (escortId !== null) row.escortId = escortId;
  if (route !== null) {
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < route.length; i += 2) pts.push([route[i]!, route[i + 1]!]);
    row.route = pts;
  }
  return row;
}

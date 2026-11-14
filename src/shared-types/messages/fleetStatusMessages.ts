import { z } from 'zod';

/**
 * RTS command layer, slice 7 — the owner-only `fleet_status` stream.
 *
 * Server → ONE client, ~2 Hz: the status of every AI-flown ship that client's
 * player owns in this room (mode, stance, activity, hull, morale, order...).
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
 * The tables mirror `core/ai/wingman/types.ts` (shared-types stays
 * self-contained; parity locked in `fleetStatusMessages.test.ts`).
 */
export const FLEET_STATUS_MODES = ['patrol', 'defend', 'hunt', 'escort', 'retreat'] as const;
export const FLEET_STATUS_STANCES = ['aggressive', 'defensive', 'holdFire'] as const;
export const FLEET_STATUS_ACTIVITIES = [
  'idle', 'moving', 'patrolling', 'chasing', 'attacking', 'retreating', 'formingUp', 'guarding',
] as const;
export const FLEET_STATUS_ORDERS = ['move', 'attack', 'stop'] as const;
/** Index = `MORALE_OUTCOME` value (core/ai/tactics/morale.ts). */
export const FLEET_STATUS_MORALE = ['fightOn', 'fallBack', 'flee'] as const;

type FleetStatusMode = (typeof FLEET_STATUS_MODES)[number];
type FleetStatusStance = (typeof FLEET_STATUS_STANCES)[number];
type FleetStatusActivity = (typeof FLEET_STATUS_ACTIVITIES)[number];
type FleetStatusOrder = (typeof FLEET_STATUS_ORDERS)[number];
type FleetStatusMorale = (typeof FLEET_STATUS_MORALE)[number];

const idx = (n: number) => z.number().int().min(0).max(n - 1);
const optIdx = (n: number) => z.number().int().min(-1).max(n - 1);
const optId = z.string().max(64).nullable();
const optNum = z.number().finite().nullable();

/**
 * One ship. Order:
 *  0 id, 1 mode idx, 2 stance idx, 3 activity idx, 4 targetId|null,
 *  5 hullPct (0..100 int), 6 morale idx (-1 none), 7 squadId|null,
 *  8 order idx (-1 none), 9 orderX|null, 10 orderY|null (move order dest),
 *  11 escortId|null, 12 route: flat [x0,y0,x1,y1,…] (patrol) | null,
 *  13 shieldPct (0..100 int; appended 2026-11-14, optional so an older
 *  sender still parses).
 */
const FleetStatusTupleSchema = z.tuple([
  z.string().min(1).max(64),
  idx(FLEET_STATUS_MODES.length),
  idx(FLEET_STATUS_STANCES.length),
  idx(FLEET_STATUS_ACTIVITIES.length),
  optId,
  z.number().int().min(0).max(100),
  optIdx(FLEET_STATUS_MORALE.length),
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
  mode: FleetStatusMode;
  stance: FleetStatusStance;
  activity: FleetStatusActivity;
  targetId: string | null;
  hullPct: number;
  /** Shield 0..100 (absent from an older sender). */
  shieldPct?: number;
  moraleOutcome?: FleetStatusMorale;
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
    r.hullPct,
    r.moraleOutcome === undefined ? -1 : FLEET_STATUS_MORALE.indexOf(r.moraleOutcome),
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
  const [id, mode, stance, activity, targetId, hullPct, morale, squadId, order, ox, oy, escortId, route, shieldPct] = t;
  const row: FleetStatusRowWire = {
    id,
    mode: FLEET_STATUS_MODES[mode]!,
    stance: FLEET_STATUS_STANCES[stance]!,
    activity: FLEET_STATUS_ACTIVITIES[activity]!,
    targetId,
    hullPct,
  };
  if (shieldPct !== undefined) row.shieldPct = shieldPct;
  if (morale >= 0) row.moraleOutcome = FLEET_STATUS_MORALE[morale]!;
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

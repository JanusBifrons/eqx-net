/**
 * The `fleet_status` stream handler (RTS command layer, slice 7): validate,
 * decode the compact tuples and REPLACE the fleet status singleton. Each
 * message is the owner's whole fleet, so rows for ships no longer listed are
 * dropped. The only writer of `fleet/fleetStatus.ts`.
 */
import { FleetStatusMessageSchema, decodeFleetStatusRow } from '@shared-types/messages';
import { applyFleetStatus, type FleetStatusUpdate } from './fleetStatus.js';

/** Apply one raw `fleet_status` message. False (and nothing changes) when it
 *  fails validation. */
export function ingestFleetStatus(raw: unknown): boolean {
  const parsed = FleetStatusMessageSchema.safeParse(raw);
  if (!parsed.success) return false;
  // 2 Hz, bounded by the owner's fleet: the row objects are the singleton's input.
  const rows: FleetStatusUpdate[] = [];
  for (const t of parsed.data.s) {
    const w = decodeFleetStatusRow(t);
    const row: FleetStatusUpdate = {
      id: w.id,
      mode: w.mode,
      stance: w.stance,
      activity: w.activity,
      targetId: w.targetId,
      hullPct: w.hullPct,
    };
    if (w.squadId !== undefined) row.squadId = w.squadId;
    if (w.orderKind !== undefined) row.orderKind = w.orderKind;
    if (w.orderX !== undefined) row.orderX = w.orderX;
    if (w.orderY !== undefined) row.orderY = w.orderY;
    if (w.route !== undefined) row.route = w.route;
    if (w.escortId !== undefined) row.escortId = w.escortId;
    if (w.moraleOutcome !== undefined) row.moraleOutcome = w.moraleOutcome;
    rows.push(row);
  }
  applyFleetStatus(rows, { replace: true });
  return true;
}

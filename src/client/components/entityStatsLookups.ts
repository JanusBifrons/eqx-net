/**
 * Selection-id lookups for the entity inspector (`EntityStatsPanel`): the
 * numeric entityId, a structure's name / subtype / grid slice, a drone's name.
 * Moved verbatim out of EntityStatsPanel.tsx (size cap).
 */
import { getGameClient } from '../net/clientSingleton';
import { getStructureKind } from '@shared-types/structureKinds';
import { getShipKind } from '@shared-types/shipKinds';
import type { StructureRenderState } from '@core/contracts/IRenderer';

/** Parse the numeric swarm entityId from a selection id (`swarm-<n>` or `<n>`).
 *  Undefined when not numeric. */
export function parseEntityId(id: string): number | undefined {
  const n = parseInt(id.startsWith('swarm-') ? id.slice('swarm-'.length) : id, 10);
  return Number.isNaN(n) ? undefined : n;
}

/** A structure's catalogue display name (INSTANT — from the swarm mirror's
 *  subtype byte), so the panel names it before the first server packet. */
export function structureName(id: string): string | undefined {
  const client = getGameClient();
  if (!client) return undefined;
  const entityId = parseInt(id.startsWith('swarm-') ? id.slice('swarm-'.length) : id, 10);
  if (Number.isNaN(entityId)) return undefined;
  const sw = client.mirror.swarm?.get(entityId);
  return sw?.shipKind ? getStructureKind(sw.shipKind).displayName : undefined;
}

/** A structure's raw subtype id (the swarm `shipKind` byte) — used to gate the
 *  connector-only connection count (C4). Undefined when the swarm entry is gone. */
export function structureSubtype(id: string): string | undefined {
  const client = getGameClient();
  if (!client) return undefined;
  const entityId = parseInt(id.startsWith('swarm-') ? id.slice('swarm-'.length) : id, 10);
  if (Number.isNaN(entityId)) return undefined;
  return client.mirror.swarm?.get(entityId)?.shipKind;
}

export function droneName(shipKind: string | undefined): string {
  if (!shipKind) return 'Drone';
  // The name is cosmetic; a capitalised kind id reads fine.
  return `${shipKind.charAt(0).toUpperCase()}${shipKind.slice(1)} drone`;
}

/** The grid slice entry for a selected structure, keyed by the numeric entityId
 *  (`mirror.structures` uses the bare entityId; the selection id is the mirror
 *  form `swarm-<entityId>`). Returns undefined if absent. */
export function structureSliceFor(id: string): StructureRenderState | undefined {
  const client = getGameClient();
  if (!client) return undefined;
  const entityId = parseInt(id.startsWith('swarm-') ? id.slice('swarm-'.length) : id, 10);
  if (Number.isNaN(entityId)) return undefined;
  return client.mirror.structures?.get(entityId);
}

/** A parked hull's inspector labels. Mine reads as mine ("OWNER you") under its
 *  kind's display name, whatever the server put in `displayName` (empty for a
 *  guest owner). Anyone else's shows the owner's name, else "Abandoned hull",
 *  over the kind's display name. Never a raw kind id (no ids in the UI). */
export function parkedHullLabels(
  displayName: string | undefined,
  kind: string | undefined,
  mine: boolean,
): { name: string; infoLine?: string; owner?: string } {
  const kindName = getShipKind(kind).displayName;
  if (mine) return { name: kindName, owner: 'you' };
  return { name: displayName || 'Abandoned hull', infoLine: kindName };
}

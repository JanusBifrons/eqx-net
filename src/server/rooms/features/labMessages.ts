/**
 * Economy v2 W3 — Research Lab client messages: view / start / cancel a job.
 * Moved verbatim out of `SectorRoom.onCreate`; the room hands in live
 * accessors so every handler reads the same state it did there.
 */
import type { Client } from 'colyseus';
import type { StructureRegistry } from '../../structures/StructureRegistry.js';
import type { ResearchLabSubsystem } from '../../structures/ResearchLabSubsystem.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { ParsedMessageHost, RoomFeature } from './parsedMessage.js';
import { LabCancelSchema, LabQuerySchema, LabStartSchema, type LabStart, type LabState } from '../../../shared-types/messages/labMessages.js';

/** What the handlers need from the room; getters read the live field. */
export interface LabMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  researchLabs(): Pick<ResearchLabSubsystem, 'start' | 'cancel' | 'view'>;
}

export function registerLabMessages(h: LabMessageHost): RoomFeature {
  // ── Economy v2 W3 — Research Lab: view / start / cancel a job ───────────
  const labRequest = (client: Client, kind: 'lab_query' | 'lab_start' | 'lab_cancel', raw: unknown): void => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    let entityId: number;
    let job: LabStart['job'] | null = null;
    if (kind === 'lab_start') {
      const p = LabStartSchema.safeParse(raw);
      if (!p.success) { h.malformed.record(client.sessionId, kind); return; }
      entityId = p.data.entityId;
      job = p.data.job;
    } else {
      const p = (kind === 'lab_query' ? LabQuerySchema : LabCancelSchema).safeParse(raw);
      if (!p.success) { h.malformed.record(client.sessionId, kind); return; }
      entityId = p.data.entityId;
    }
    const rec = h.swarmRegistry.getByEntityId(entityId);
    const lab = rec ? h.structureRegistry.get(rec.id) : undefined;
    if (lab === undefined || lab.owner !== playerId) {
      const none: LabState = { type: 'lab_state', entityId, powered: false, connected: false, job: null, blueprints: [], ok: false, message: 'That is not your Research Lab.' };
      try { client.send('lab_state', none); } catch { /* closing */ }
      return;
    }
    let verdict: { ok: boolean; message: string } | undefined;
    if (job !== null) verdict = h.researchLabs().start(playerId, lab, job);
    else if (kind === 'lab_cancel') verdict = h.researchLabs().cancel(playerId, lab);
    try { client.send('lab_state', h.researchLabs().view(playerId, lab, entityId, verdict)); } catch { /* closing */ }
  };
  h.onMessage('lab_query', (client: Client, raw: unknown) => labRequest(client, 'lab_query', raw));
  h.onMessage('lab_start', (client: Client, raw: unknown) => labRequest(client, 'lab_start', raw));
  h.onMessage('lab_cancel', (client: Client, raw: unknown) => labRequest(client, 'lab_cancel', raw));
  return {};
}

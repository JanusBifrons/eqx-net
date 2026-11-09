/**
 * Client → server wire parity (#15) for the teleporter senders in
 * `src/client/structures/structureActionsClient.ts`: the exact payload each
 * real sender puts on the wire must pass the strict server schema.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';
import * as client from '../../src/client/structures/structureActionsClient';
import {
  SetTeleportRulesSchema,
  TeleportCandidatesQuerySchema,
  TeleportFireSchema,
  TeleportPadLoadSchema,
  TeleportPadUnloadSchema,
  TeleportPairRemoteSchema,
  TeleportPairSchema,
  TeleportUnpairSchema,
  DEFAULT_TELEPORT_RULES,
  SetTeleportTollSchema,
  TollAnswerSchema,
  TeleportPairRequestSchema,
  TeleportPairAnswerSchema,
} from '../../src/shared-types/teleport';

const sent: Array<{ type: string; payload: unknown }> = [];
vi.mock('../../src/client/net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send: (type: string, payload: unknown) => sent.push({ type, payload }) }) }),
}));
vi.mock('../../src/client/net/clientSingleton.js', () => ({
  getGameClient: () => ({ getRoom: () => ({ send: (type: string, payload: unknown) => sent.push({ type, payload }) }) }),
}));

function lastAccepted(schema: ZodType, wireType: string): void {
  const m = sent[sent.length - 1]!;
  expect(m.type).toBe(wireType);
  const r = schema.safeParse(m.payload);
  expect(r.success, `${wireType}: ${JSON.stringify(m.payload)} → ${r.success ? '' : r.error.message}`).toBe(true);
}

describe('teleporter senders match the server schemas', () => {
  afterEach(() => { sent.length = 0; });

  it('every teleporter message', () => {
    client.sendTeleportPair(3, 4);
    lastAccepted(TeleportPairSchema, 'teleport_pair');
    client.sendTeleportUnpair(3);
    lastAccepted(TeleportUnpairSchema, 'teleport_unpair');
    client.sendTeleportFire(3);
    lastAccepted(TeleportFireSchema, 'teleport_fire');
    client.sendSetTeleportRules(3, { ...DEFAULT_TELEPORT_RULES, whenCharged: true, loaded: { good: null, qty: 50 } });
    lastAccepted(SetTeleportRulesSchema, 'set_teleport_rules');
    client.sendTeleportPadLoad(3, 'alloy', 10);
    lastAccepted(TeleportPadLoadSchema, 'teleport_pad_load');
    client.sendTeleportPadUnload(3);
    lastAccepted(TeleportPadUnloadSchema, 'teleport_pad_unload');
    client.sendTeleportCandidates(3);
    lastAccepted(TeleportCandidatesQuerySchema, 'teleport_candidates');
    client.sendTeleportPairRemote(3, 'verdance', 'st-abc');
    lastAccepted(TeleportPairRemoteSchema, 'teleport_pair_remote');
    // T4 — tolls and pairing with another owner.
    client.sendSetTeleportToll(3, { per1000: 25, nonPayer: 'hostile' });
    lastAccepted(SetTeleportTollSchema, 'set_teleport_toll');
    client.sendSetTeleportToll(3, null);
    lastAccepted(SetTeleportTollSchema, 'set_teleport_toll');
    client.sendTollAnswer(3, 'always');
    lastAccepted(TollAnswerSchema, 'teleport_toll_answer');
    client.sendTeleportPairRequest(3, 'verdance', 'st-abc');
    lastAccepted(TeleportPairRequestSchema, 'teleport_pair_request');
    client.sendTeleportPairAnswer('req-1', true);
    lastAccepted(TeleportPairAnswerSchema, 'teleport_pair_answer');
  });
});

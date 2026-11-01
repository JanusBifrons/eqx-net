/**
 * Wire parity (#15): the REAL client sender's payload must pass the server's
 * schema. A strict schema missing the `type` field that tradeClient's send()
 * always adds silently dropped every real request (fixed for the lab, install
 * and bounty messages in #227; this locks `unpack_hull`).
 */
import { describe, expect, it, vi } from 'vitest';

const sent: Array<[string, unknown]> = [];
vi.mock('./clientSingleton.js', () => ({
  getGameClient: () => ({ getRoom: () => ({ send: (t: string, p: unknown) => sent.push([t, p]) }) }),
}));

import { sendUnpackHull } from './tradeClient.js';
import { UnpackHullSchema } from '../../shared-types/blueprints.js';

describe('tradeClient → server schema parity (economy v2 W5a)', () => {
  it('sendUnpackHull’s real payload parses with UnpackHullSchema', () => {
    sendUnpackHull(7, 'gunship');
    const [type, payload] = sent[sent.length - 1]!;
    expect(type).toBe('unpack_hull');
    expect(UnpackHullSchema.safeParse(payload).success).toBe(true);
  });
});

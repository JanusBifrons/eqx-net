/**
 * Factions F1 — the standing web in the economy store: the one-time rescale
 * of saved reputation (−1000..1000 → −100..100), the three storage cases
 * (NPC → player, player → anyone, NPC → NPC) and the NPC web's round trip.
 */
import { describe, expect, it } from 'vitest';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { EconomyStore, STANDING_SCALE_VERSION } from './EconomyStore.js';

const P = '6a7e0000-0000-4000-8000-0000000000a1';
const Q = '6a7e0000-0000-4000-8000-0000000000b2';

function store(): { s: EconomyStore; ops: PersistOp[] } {
  const ops: PersistOp[] = [];
  const sink = { enqueueCritical: (op: PersistOp) => ops.push(op) } as unknown as IPersistenceSink;
  return { s: new EconomyStore({ persistence: () => sink, now: () => 1000 }), ops };
}

describe('EconomyStore standing', () => {
  it('rescales a pre-faction row once (÷10), and keeps a current row as is', () => {
    const { s } = store();
    s.hydrate({
      players: [
        { player_id: P, payload_json: JSON.stringify({ rep: { traders: -300, robots: 505, drones: 0 } }) },
        { player_id: Q, payload_json: JSON.stringify({ rep: { traders: -30 }, standingScale: STANDING_SCALE_VERSION }) },
      ],
      deals: [],
      market: null,
    });
    expect(s.rep(P, 'traders')).toBe(-30);
    expect(s.rep(P, 'robots')).toBe(50.5);
    expect(s.rep(Q, 'traders')).toBe(-30);
    // A re-save carries the marker, so a second load does not divide again.
    const op = s.playerOp(P) as Extract<PersistOp, { type: 'ECON_PLAYER_PUT' }>;
    expect(JSON.parse(op.payloadJson).standingScale).toBe(STANDING_SCALE_VERSION);
  });

  it('NPC → player standing is the player row’s rep', () => {
    const { s } = store();
    expect(s.adjustStanding('traders', P, 5)).toBe(5);
    expect(s.rep(P, 'traders')).toBe(5);
    expect(s.standing('traders', P)).toBe(5);
    expect(s.adjustStanding('core', P, -12.34)).toBe(-12.3); // any NPC faction, 0.1 steps
    expect(s.standing('core', P)).toBe(-12.3);
  });

  it('a player’s view of others is separate (directional)', () => {
    const { s } = store();
    s.adjustStanding(P, 'traders', -40);
    expect(s.standing(P, 'traders')).toBe(-40);
    expect(s.standing('traders', P)).toBe(0);
    s.adjustStanding(P, Q, 20);
    expect(s.standing(P, Q)).toBe(20);
    expect(s.standing(Q, P)).toBe(0);
  });

  it('clamps to ±100 and a faction always stands at 100 with itself', () => {
    const { s } = store();
    expect(s.adjustStanding('core', 'azure-deep', -500)).toBe(-100);
    expect(s.standing('core', 'core')).toBe(100);
  });

  it('the NPC web persists and hydrates', () => {
    const { s, ops } = store();
    s.adjustStanding('core', 'azure-deep', -25);
    s.adjustStanding('verdant-reach', 'traders', 10);
    const put = ops.filter((o) => o.type === 'ECON_STATE_PUT').pop() as Extract<PersistOp, { type: 'ECON_STATE_PUT' }>;
    expect(put.key).toBe('standings');
    const { s: s2 } = store();
    s2.hydrate({ players: [], deals: [], market: null, standings: put.payloadJson });
    expect(s2.standing('core', 'azure-deep')).toBe(-25);
    expect(s2.standing('azure-deep', 'core')).toBe(0);
    expect(s2.standing('verdant-reach', 'traders')).toBe(10);
  });

  it('the trade view still lists the three original sides', () => {
    const { s } = store();
    s.adjustStanding('core', P, 7);
    expect(Object.keys(s.view(P).rep).sort()).toEqual(['drones', 'robots', 'traders']);
  });
});

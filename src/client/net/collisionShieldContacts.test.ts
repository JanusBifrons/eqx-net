/**
 * User report 2026-11-07: "the shield should show on collisions when it's
 * raised, same as on shots hitting the shields". Each side of a collision
 * gets a shield contact facing the other body (the renderer draws it only on
 * a raised shield). Grinding contacts arrive every tick, so it's throttled.
 */
import { describe, it, expect } from 'vitest';
import { pushCollisionShieldContacts, type ShieldContactTrigger } from './collisionShieldContacts.js';

const mirror = {
  ships: new Map<string, { x: number; y: number }>([['p1', { x: 0, y: 0 }], ['p2', { x: 100, y: 0 }]]),
  swarm: new Map<number, { x: number; y: number }>([[7, { x: 0, y: 200 }]]),
};
const msg = (aId: string, bId: string, eA?: number, eB?: number) => ({ aId, bId, ...(eA !== undefined ? { eA } : {}), ...(eB !== undefined ? { eB } : {}) });

describe('collision shield contacts', () => {
  it('two pilots: each gets a contact facing the other', () => {
    const out: ShieldContactTrigger[] = [];
    pushCollisionShieldContacts(msg('p1', 'p2', -1, -1), mirror, 1000, new Map(), out);
    expect(out).toEqual([
      { kind: 'shield-contact', entityId: 'p1', worldX: 100, worldY: 0 },
      { kind: 'shield-contact', entityId: 'p2', worldX: 0, worldY: 0 },
    ]);
  });

  it('a drone side is keyed like its sprite (swarm-<entityId>)', () => {
    const out: ShieldContactTrigger[] = [];
    pushCollisionShieldContacts(msg('p1', 'swarm-drone-3', -1, 7), mirror, 1000, new Map(), out);
    expect(out.map((t) => t.entityId)).toEqual(['p1', 'swarm-7']);
    expect(out[1]).toMatchObject({ worldX: 0, worldY: 0 });
  });

  it('a side the client cannot name is skipped (old server, parked hull)', () => {
    const out: ShieldContactTrigger[] = [];
    pushCollisionShieldContacts(msg('p1', 'x'), mirror, 1000, new Map(), out);
    expect(out).toEqual([]);
  });

  it('a grinding contact shows at most every 150 ms per shield', () => {
    const out: ShieldContactTrigger[] = [];
    const last = new Map<string, number>();
    pushCollisionShieldContacts(msg('p1', 'p2', -1, -1), mirror, 1000, last, out);
    pushCollisionShieldContacts(msg('p1', 'p2', -1, -1), mirror, 1050, last, out);
    expect(out.length).toBe(2);
    pushCollisionShieldContacts(msg('p1', 'p2', -1, -1), mirror, 1200, last, out);
    expect(out.length).toBe(4);
  });
});

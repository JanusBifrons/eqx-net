import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  auditEvent,
  getRecentAudit,
  setAuditSink,
  clearAuditRing,
  type AuditEvent,
} from './GameplayAuditLog.js';

describe('GameplayAuditLog', () => {
  let captured: AuditEvent[];

  beforeEach(() => {
    captured = [];
    clearAuditRing();
    // Override the durable sink so no pino-roll logger / files are created.
    setAuditSink((rec) => captured.push(rec));
  });

  afterEach(() => {
    setAuditSink(null);
    clearAuditRing();
  });

  it('stamps ts + iso and forwards the full record to the sink', () => {
    const before = Date.now();
    auditEvent({ event: 'structure_destroyed', sector: 'sol-prime', owner: 'alice', kind: 'capital', attackerId: 'swarm-7' });
    expect(captured).toHaveLength(1);
    const rec = captured[0]!;
    expect(rec.event).toBe('structure_destroyed');
    expect(typeof rec.ts).toBe('number');
    expect(rec.ts).toBeGreaterThanOrEqual(before);
    expect(rec.iso).toBe(new Date(rec.ts).toISOString());
    expect((rec as { owner?: string }).owner).toBe('alice');
  });

  it('appends to the in-memory ring (newest last)', () => {
    auditEvent({ event: 'player_joined', sector: 's', playerId: 'a' });
    auditEvent({ event: 'player_left', sector: 's', playerId: 'a' });
    const recent = getRecentAudit();
    expect(recent.map((e) => e.event)).toEqual(['player_joined', 'player_left']);
  });

  it('getRecentAudit respects the limit (returns the tail)', () => {
    for (let i = 0; i < 5; i++) auditEvent({ event: 'drone_destroyed', sector: 's', attackerId: `k${i}` });
    const recent = getRecentAudit(2);
    expect(recent).toHaveLength(2);
    expect((recent[1] as { attackerId?: string }).attackerId).toBe('k4');
  });

  it('never throws into game logic when the sink throws', () => {
    setAuditSink(() => { throw new Error('sink boom'); });
    expect(() => auditEvent({ event: 'base_ready', sector: 's', owner: 'a' })).not.toThrow();
    // ring still recorded it even though the sink failed
    expect(getRecentAudit().at(-1)!.event).toBe('base_ready');
  });
});

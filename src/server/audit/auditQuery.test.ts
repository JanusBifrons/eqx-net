import { describe, it, expect } from 'vitest';
import { filterAudit, formatAuditLine, formatAuditTimeline, eventIdentities } from './auditQuery.js';
import type { AuditEvent } from './GameplayAuditLog.js';

function ev(ts: number, partial: Partial<AuditEvent> & { event: AuditEvent['event'] }): AuditEvent {
  return { ts, iso: new Date(ts).toISOString(), ...partial } as AuditEvent;
}

const FIXTURE: AuditEvent[] = [
  ev(3000, { event: 'structure_destroyed', sector: 'sol-prime', owner: 'alice', kind: 'capital', attackerId: 'swarm-7', attackerKind: 'fighter' }),
  ev(1000, { event: 'wave_dispatched', sector: 'sol-prime', owner: 'alice', targetSector: 'sol-prime', squadId: 'sq1', squadSize: 8 }),
  ev(2000, { event: 'structure_attacked', sector: 'sol-prime', owner: 'alice', kind: 'miner', attackerId: 'swarm-7' }),
  ev(4000, { event: 'drone_destroyed', sector: 'vega-reach', attackerId: 'alice' }),
  ev(5000, { event: 'player_joined', sector: 'vega-reach', playerId: 'bob' }),
];

describe('filterAudit', () => {
  it('sorts oldest→newest regardless of input order', () => {
    const out = filterAudit(FIXTURE);
    expect(out.map((e) => e.ts)).toEqual([1000, 2000, 3000, 4000, 5000]);
  });

  it('filters by sector', () => {
    const out = filterAudit(FIXTURE, { sector: 'vega-reach' });
    expect(out.map((e) => e.event)).toEqual(['drone_destroyed', 'player_joined']);
  });

  it('filters by a single event type', () => {
    const out = filterAudit(FIXTURE, { event: 'structure_destroyed' });
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toBe('structure_destroyed');
  });

  it('filters by a list of event types', () => {
    const out = filterAudit(FIXTURE, { event: ['structure_destroyed', 'structure_attacked'] });
    expect(out.map((e) => e.event)).toEqual(['structure_attacked', 'structure_destroyed']);
  });

  it('filters by owner (exact)', () => {
    const out = filterAudit(FIXTURE, { owner: 'alice' });
    // player_joined (bob) and drone_destroyed (no owner) excluded
    expect(out.every((e) => (e as { owner?: string }).owner === 'alice')).toBe(true);
    expect(out).toHaveLength(3);
  });

  it('filters by player across ANY identity field (owner, attacker, playerId)', () => {
    const out = filterAudit(FIXTURE, { player: 'alice' });
    // alice is owner of 3 + the attackerId on drone_destroyed = 4
    expect(out).toHaveLength(4);
    expect(out.some((e) => e.event === 'drone_destroyed')).toBe(true);
  });

  it('honours since/until bounds (inclusive)', () => {
    const out = filterAudit(FIXTURE, { since: 2000, until: 4000 });
    expect(out.map((e) => e.ts)).toEqual([2000, 3000, 4000]);
  });

  it('keeps only the most recent N with limit', () => {
    const out = filterAudit(FIXTURE, { limit: 2 });
    expect(out.map((e) => e.ts)).toEqual([4000, 5000]);
  });

  it('does not mutate the input array', () => {
    const before = FIXTURE.map((e) => e.ts);
    filterAudit(FIXTURE, { limit: 1 });
    expect(FIXTURE.map((e) => e.ts)).toEqual(before);
  });
});

describe('eventIdentities', () => {
  it('collects every string id an event references', () => {
    const e = ev(1, { event: 'player_killed', sector: 's', victim: 'alice', killer: 'bob' });
    expect(eventIdentities(e).sort()).toEqual(['alice', 'bob']);
  });
});

describe('formatAuditLine', () => {
  it('renders a structure_destroyed line with owner + attacker', () => {
    const line = formatAuditLine(FIXTURE[0]!);
    expect(line).toContain('[sol-prime]');
    expect(line).toContain('structure_destroyed');
    expect(line).toContain('capital');
    expect(line).toContain('owner=alice');
    expect(line).toContain('swarm-7');
  });

  it('renders a wave_dispatched line', () => {
    const line = formatAuditLine(FIXTURE[1]!);
    expect(line).toContain('wave of 8');
    expect(line).toContain('sol-prime');
  });

  it('formatAuditTimeline joins one line per event', () => {
    const text = formatAuditTimeline(filterAudit(FIXTURE, { sector: 'vega-reach' }));
    expect(text.split('\n')).toHaveLength(2);
  });
});

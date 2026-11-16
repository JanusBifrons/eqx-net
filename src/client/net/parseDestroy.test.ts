/**
 * The `destroy` trust boundary (invariant #3): parsed with the shared strict
 * `DestroyEventSchema`, malformed dropped (sampled warn), and the fracture
 * v11 `vaporised` flag read (a cut kill that left no wreck piece).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logged: Array<{ tag: string; data: Record<string, unknown> }> = [];
vi.mock('../debug/ClientLogger', () => ({
  logEvent: (tag: string, data: Record<string, unknown>) => { logged.push({ tag, data }); },
}));

const { parseDestroy, DESTROY_DROP_WARN_EVERY, resetDestroyDropCountForTest } = await import('./parseDestroy.js');

const valid = { type: 'destroy' as const, targetId: 'p1', shooterId: 'p2' };

describe('parseDestroy', () => {
  beforeEach(() => { logged.length = 0; resetDestroyDropCountForTest(); });

  it('a plain death parses, not vaporised', () => {
    const evt = parseDestroy(valid);
    expect(evt).not.toBeNull();
    expect(evt!.targetId).toBe('p1');
    expect(evt!.vaporised).toBeUndefined();
  });

  it('a vaporised death parses and carries the flag', () => {
    const evt = parseDestroy({ ...valid, vaporised: true });
    expect(evt!.vaporised).toBe(true);
  });

  it('accepts an empty shooterId (environmental kill)', () => {
    expect(parseDestroy({ ...valid, shooterId: '' })).not.toBeNull();
  });

  it('drops malformed payloads (null), never reaching game logic', () => {
    expect(parseDestroy({ ...valid, targetId: '' })).toBeNull();
    expect(parseDestroy({ ...valid, vaporised: false })).toBeNull();
    expect(parseDestroy({ ...valid, extra: 1 })).toBeNull();
    expect(parseDestroy({ type: 'destroy', targetId: 'p1' })).toBeNull();
    expect(parseDestroy(null)).toBeNull();
    expect(parseDestroy('destroy')).toBeNull();
  });

  it('the drop warning is sampled: the first drop, then one per DESTROY_DROP_WARN_EVERY', () => {
    for (let i = 0; i < DESTROY_DROP_WARN_EVERY * 2 + 1; i++) parseDestroy({ bad: i });
    const warns = logged.filter((l) => l.tag === 'destroy_malformed_dropped');
    expect(warns.length).toBe(3);
    expect(warns[0]!.data.dropped).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { HostileActLedger } from './HostileActLedger.js';
import { HOSTILE_ACT_COOLDOWN_MS } from '../../shared-types/relations.js';

describe('HostileActLedger', () => {
  it('is directional and per owner', () => {
    const l = new HostileActLedger();
    l.record('a', 'b', 0);
    expect(l.isHostile('a', 'b', 1)).toBe(true);
    expect(l.isHostile('b', 'a', 1)).toBe(false);
    expect(l.isHostile('a', 'c', 1)).toBe(false);
  });

  it('expires after the cooldown (default and custom)', () => {
    const l = new HostileActLedger();
    l.record('a', 'b', 0);
    expect(l.isHostile('a', 'b', HOSTILE_ACT_COOLDOWN_MS - 1)).toBe(true);
    expect(l.isHostile('a', 'b', HOSTILE_ACT_COOLDOWN_MS)).toBe(false);
    l.record('a', 'c', 0, 100);
    expect(l.isHostile('a', 'c', 99)).toBe(true);
    expect(l.isHostile('a', 'c', 100)).toBe(false);
  });

  it('a new act extends the cooldown and never shortens it', () => {
    const l = new HostileActLedger();
    l.record('a', 'b', 0, 1000);
    l.record('a', 'b', 10, 100);
    expect(l.isHostile('a', 'b', 500)).toBe(true);
    l.record('a', 'b', 900, 1000);
    expect(l.isHostile('a', 'b', 1500)).toBe(true);
  });

  it('ignores acts against yourself', () => {
    const l = new HostileActLedger();
    l.record('a', 'a', 0);
    expect(l.size()).toBe(0);
  });

  it('sweep drops expired entries and clear forgets one', () => {
    const l = new HostileActLedger();
    l.record('a', 'b', 0, 100);
    l.record('c', 'b', 0, 1000);
    l.record('a', 'd', 0, 1000);
    l.sweep(100);
    expect(l.size()).toBe(2);
    l.clear('c', 'b');
    expect(l.size()).toBe(1);
    expect(l.isHostile('a', 'd', 500)).toBe(true);
  });
});

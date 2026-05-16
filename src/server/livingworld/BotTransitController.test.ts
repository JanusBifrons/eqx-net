import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Bus } from '../../core/events/Bus.js';
import { BotTransitController } from './BotTransitController.js';

const SPOOL = 50;

describe('BotTransitController', () => {
  let bus: Bus;
  let states: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new Bus();
    states = [];
    bus.on('TRANSIT_STATE_CHANGED', (e) => states.push(e.state));
  });
  afterEach(() => vi.useRealTimers());

  it('spools then commits → arrived, reusing the pure state machine', () => {
    const commit = vi.fn(() => true);
    const outcome = vi.fn();
    const c = new BotTransitController('lwbot-0', bus, SPOOL);
    c.begin({ commit, outcome });

    expect(c.active).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(states).toEqual(['SPOOLING']);

    vi.advanceTimersByTime(SPOOL);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(outcome).toHaveBeenCalledWith('arrived');
    expect(states).toEqual(['SPOOLING', 'IN_TRANSIT', 'ARRIVED']);
    expect(c.active).toBe(false);
  });

  it('aborts when the bot is destroyed mid-spool (commit never runs)', () => {
    const commit = vi.fn(() => true);
    const outcome = vi.fn();
    const c = new BotTransitController('lwbot-1', bus, SPOOL);
    c.begin({ commit, outcome });

    bus.emit('ENTITY_DESTROYED', { type: 'ENTITY_DESTROYED', entityId: 'lwbot-1' });

    expect(outcome).toHaveBeenCalledWith('destroyed');
    expect(commit).not.toHaveBeenCalled();
    expect(states).toEqual(['SPOOLING', 'DOCKED']); // cancel re-emits DOCKED

    // Timer must have been cleared — commit still never fires.
    vi.advanceTimersByTime(SPOOL * 4);
    expect(commit).not.toHaveBeenCalled();
    expect(outcome).toHaveBeenCalledTimes(1);
    expect(c.active).toBe(false);
  });

  it('cancels cleanly when commit reports the bot could not move', () => {
    const commit = vi.fn(() => false); // e.g. destination slot pool full
    const outcome = vi.fn();
    const c = new BotTransitController('lwbot-2', bus, SPOOL);
    c.begin({ commit, outcome });

    vi.advanceTimersByTime(SPOOL);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(outcome).toHaveBeenCalledWith('failed');
    expect(states).toEqual(['SPOOLING', 'DOCKED']);
    expect(c.active).toBe(false);
  });

  it('ignores ENTITY_DESTROYED for a different entity', () => {
    const commit = vi.fn(() => true);
    const outcome = vi.fn();
    const c = new BotTransitController('lwbot-3', bus, SPOOL);
    c.begin({ commit, outcome });

    bus.emit('ENTITY_DESTROYED', { type: 'ENTITY_DESTROYED', entityId: 'someone-else' });
    vi.advanceTimersByTime(SPOOL);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(outcome).toHaveBeenCalledWith('arrived');
  });

  it('dispose() abandons an in-flight spool with no terminal outcome', () => {
    const commit = vi.fn(() => true);
    const outcome = vi.fn();
    const c = new BotTransitController('lwbot-4', bus, SPOOL);
    c.begin({ commit, outcome });

    c.dispose();
    vi.advanceTimersByTime(SPOOL * 4);

    expect(commit).not.toHaveBeenCalled();
    expect(outcome).not.toHaveBeenCalled();
    expect(c.active).toBe(false);
    c.dispose(); // idempotent
  });

  it('refuses a second begin() without an intervening terminal', () => {
    const c = new BotTransitController('lwbot-5', bus, SPOOL);
    c.begin({ commit: () => true, outcome: vi.fn() });
    expect(() => c.begin({ commit: () => true, outcome: vi.fn() })).toThrow(/already in flight/);
  });
});

import { describe, it, expect } from 'vitest';
import { FleetStatusSoon } from './FleetStatusSoon.js';

describe('FleetStatusSoon', () => {
  it('sends a request once, delayTicks after it was made', () => {
    const soon = new FleetStatusSoon(7);
    const sent: string[] = [];
    const send = (s: string): void => { sent.push(s); };
    soon.request('a', 100);
    soon.flush(106, send);
    expect(sent).toEqual([]);
    soon.flush(107, send);
    expect(sent).toEqual(['a']);
    soon.flush(120, send);
    expect(sent).toEqual(['a']);
    expect(soon.size).toBe(0);
  });

  it('a burst of commands sends once, at the earliest due tick', () => {
    const soon = new FleetStatusSoon(7);
    const sent: string[] = [];
    soon.request('a', 100);
    soon.request('a', 103);
    soon.request('b', 101);
    soon.flush(107, (s) => sent.push(s));
    expect(sent).toEqual(['a']);
    soon.flush(108, (s) => sent.push(s));
    expect(sent).toEqual(['a', 'b']);
  });

  it('clear drops a pending send', () => {
    const soon = new FleetStatusSoon(7);
    const sent: string[] = [];
    soon.request('a', 0);
    soon.clear('a');
    soon.flush(50, (s) => sent.push(s));
    expect(sent).toEqual([]);
  });
});

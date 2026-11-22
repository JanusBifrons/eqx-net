import { describe, expect, it } from 'vitest';
import { NET_SLOT_CH, netHealthItems, proseMs, type NetItemKind } from './netHealthItems';
import type { NetHealthView } from './netHealth';

function quiet(): NetHealthView {
  return {
    network: { shown: false, level: 'warn', cause: 'ping', rttMs: 0, latenessMs: 0, gapsPerMin: 0, waitMs: 0 },
    server: { shown: false, level: 'warn', sendGapMs: 0, clockRate: 1 },
    device: { shown: false, level: 'warn', stallsPerS: 0 },
    corrections: { shown: false, perS: 0 },
    drones: { shown: false, perDroneS: 0 },
    link: { shown: false, state: 'down' },
  };
}

function allShown(): NetHealthView {
  const v = quiet();
  v.link = { shown: true, state: 'ws' };
  v.network = { ...v.network, shown: true, level: 'bad', rttMs: 312 };
  v.server = { ...v.server, shown: true, sendGapMs: 1300 };
  v.device = { shown: true, level: 'warn', stallsPerS: 6.4 };
  v.corrections = { shown: true, perS: 7.2 };
  v.drones = { shown: true, perDroneS: 4 };
  return v;
}

describe('netHealthItems', () => {
  it('is empty when nothing is shown', () => {
    expect(netHealthItems(quiet())).toEqual([]);
  });

  it('lists the shown items in cluster order', () => {
    expect(netHealthItems(allShown()).map((i) => i.kind))
      .toEqual(['linkWs', 'network', 'server', 'device', 'corrections', 'drones']);
  });

  it('writes the server paragraph with its averaged number and the attribution', () => {
    const v = quiet();
    v.server = { shown: true, level: 'bad', sendGapMs: 1300, clockRate: 1 };
    const [item] = netHealthItems(v);
    expect(item?.text).toBe('Server — the game server paused for up to 1.3 s in the last second; this is not your connection.');
    expect(item?.readout).toBe('1.3s');
    expect(item?.level).toBe('bad');
  });

  it('describes time dilation as a speed percentage', () => {
    const v = quiet();
    v.server = { shown: true, level: 'warn', sendGapMs: 60, clockRate: 0.82 };
    expect(netHealthItems(v)[0]?.text).toContain('running at 82% speed');
  });

  it('writes the network paragraph for each cause with its number', () => {
    const v = quiet();
    v.network = { shown: true, level: 'warn', cause: 'ping', rttMs: 312, latenessMs: 450, gapsPerMin: 3, waitMs: 1600 };
    expect(netHealthItems(v)[0]?.text).toBe(
      'Network — your ping peaked at 312 ms over the last second. This is your connection, not the game server.');
    v.network.cause = 'late';
    expect(netHealthItems(v)[0]?.text).toContain('up to 450 ms late');
    v.network.cause = 'gaps';
    expect(netHealthItems(v)[0]?.text).toContain('3 times in the last minute');
    v.network.cause = 'wait';
    expect(netHealthItems(v)[0]?.text).toContain('for 1.6 s');
  });

  it('writes the device, correction and drone paragraphs with rounded rates', () => {
    const texts = netHealthItems(allShown()).map((i) => i.text);
    expect(texts).toContain('Device — 6 frames a second took over 50 ms to draw over the last second; this is your device, not the network.');
    expect(texts.some((t) => t.includes('position 7 times a second'))).toBe(true);
    expect(texts.some((t) => t.startsWith('Drones — each drone froze') && t.includes('4 frames a second'))).toBe(true);
  });

  it('uses the singular for one', () => {
    const v = quiet();
    v.corrections = { shown: true, perS: 1 };
    expect(netHealthItems(v)[0]?.text).toContain('position 1 time a second');
  });

  it('keeps every paragraph to at most two sentences', () => {
    for (const item of netHealthItems(allShown())) {
      expect(item.text.split(/\.\s/).length).toBeLessThanOrEqual(2);
    }
  });

  it('covers the disconnected link with an icon-only chip', () => {
    const v = quiet();
    v.link = { shown: true, state: 'down' };
    const [item] = netHealthItems(v);
    expect(item).toMatchObject({ kind: 'linkDown', level: 'bad', readout: '' });
    expect(item?.text).toContain('disconnected');
  });
});

describe('NET_SLOT_CH (fixed readout widths)', () => {
  it('reserves room for the longest readout each item can show', () => {
    const v = allShown();
    const cases: Array<[NetItemKind, () => void]> = [
      ['network', () => { v.network = { ...v.network, cause: 'ping', rttMs: 9999 }; }],
      ['network', () => { v.network = { ...v.network, cause: 'late', latenessMs: 999 }; }],
      ['network', () => { v.network = { ...v.network, cause: 'late', latenessMs: 99_900 }; }],
      ['network', () => { v.network = { ...v.network, cause: 'gaps', gapsPerMin: 999 }; }],
      ['network', () => { v.network = { ...v.network, cause: 'wait', waitMs: 99_900 }; }],
      ['server', () => { v.server = { ...v.server, clockRate: 1, sendGapMs: 999 }; }],
      ['server', () => { v.server = { ...v.server, clockRate: 1, sendGapMs: 99_900 }; }],
      ['server', () => { v.server = { ...v.server, clockRate: 0.1 }; }],
      ['device', () => { v.device = { ...v.device, stallsPerS: 999 }; }],
      ['corrections', () => { v.corrections = { ...v.corrections, perS: 999 }; }],
      ['drones', () => { v.drones = { ...v.drones, perDroneS: 999 }; }],
      ['linkWs', () => undefined],
    ];
    for (const [kind, set] of cases) {
      set();
      const item = netHealthItems(v).find((i) => i.kind === kind);
      expect(item?.readout.length, `${kind} "${item?.readout}"`).toBeLessThanOrEqual(NET_SLOT_CH[kind]);
    }
  });

});

describe('proseMs', () => {
  it('reads milliseconds under a second and seconds above', () => {
    expect(proseMs(450.4)).toBe('450 ms');
    expect(proseMs(1300)).toBe('1.3 s');
  });
});

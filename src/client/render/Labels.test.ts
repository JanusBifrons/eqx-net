import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { formatAiShipCallsign, formatDroneName, formatPlayerLabel, LabelManager } from './Labels.js';

describe('formatDroneName', () => {
  it('zero-pads small ids to 3 hex chars', () => {
    expect(formatDroneName(1)).toBe('AI 001');
    expect(formatDroneName(15)).toBe('AI 00F');
    expect(formatDroneName(255)).toBe('AI 0FF');
  });

  it('uppercases hex digits', () => {
    expect(formatDroneName(2639)).toBe('AI A4F'); // 0xA4F
    expect(formatDroneName(0xfff)).toBe('AI FFF');
  });

  it('does not truncate ids that exceed 3 hex chars', () => {
    expect(formatDroneName(0x1000)).toBe('AI 1000');
    expect(formatDroneName(0xffff)).toBe('AI FFFF');
  });

  it('is deterministic — same id always returns the same string', () => {
    const a = formatDroneName(42);
    const b = formatDroneName(42);
    expect(a).toBe(b);
  });
});

describe('formatPlayerLabel', () => {
  it('uses the displayName when set', () => {
    expect(formatPlayerLabel('player-abc', 'Alice')).toBe('Alice');
  });

  it('trims whitespace from the displayName', () => {
    expect(formatPlayerLabel('player-abc', '  Alice  ')).toBe('Alice');
  });

  it('falls back to a plain "Pilot" label — NEVER any part of the playerId', () => {
    // No ids in the UI: the fallback must not leak even a slice of the id.
    expect(formatPlayerLabel('abcd-efghij')).toBe('Pilot');
    expect(formatPlayerLabel('abcd-efghij', '')).toBe('Pilot');
    expect(formatPlayerLabel('abcd-efghij', '   ')).toBe('Pilot');
    expect(formatPlayerLabel('xyzw-rest')).toBe('Pilot');
  });
});

describe('LabelManager ship labels (RTS Part A)', () => {
  type Entry = { text: { text: string } };
  const ship = (x: number, extra: Record<string, unknown>) => ({ x, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter', ...extra });
  function mirror(): RenderMirror {
    return {
      localPlayerId: 'me',
      ships: new Map([
        ['me', ship(0, { displayName: 'Me' })],
        ['them', ship(100, { displayName: 'Them' })],
        ['their-hull', ship(200, { ownerPlayerId: 'them', isActive: false, displayName: 'Them' })],
        ['my-hull', ship(300, { ownerPlayerId: 'me', isActive: false, displayName: 'Me' })],
      ]),
    } as unknown as RenderMirror;
  }
  const labelsOf = (l: LabelManager): Map<string, Entry> => (l as unknown as { labels: Map<string, Entry> }).labels;

  it('friendly ships (yours and your fleet) carry no label; another pilot keeps a name; an AI-flown ship gets the AI callsign', () => {
    const l = new LabelManager(new Container());
    l.update(mirror());
    const map = labelsOf(l);
    expect(map.has('p:me')).toBe(false);
    expect(map.has('p:my-hull')).toBe(false);
    expect(map.get('p:them')?.text.text).toBe('Them');
    expect(map.get('p:their-hull')?.text.text).toBe(formatAiShipCallsign('their-hull'));
  });

  it('AI-flown ships follow the NPC callsign switch (off for showcase capture)', () => {
    const l = new LabelManager(new Container(), false);
    l.update(mirror());
    expect(labelsOf(l).has('p:their-hull')).toBe(false);
    expect(labelsOf(l).has('p:them')).toBe(true);
  });

  it('the AI callsign is the drone form and never shows the id', () => {
    const c = formatAiShipCallsign('aaaaaaaa-0000-4000-8000-0000000000aa');
    expect(c).toMatch(/^AI [0-9A-F]{3}$/);
    expect(formatAiShipCallsign('aaaaaaaa-0000-4000-8000-0000000000aa')).toBe(c);
  });
});

import { describe, it, expect } from 'vitest';
import { applyHudMode, hudModeFromSearch, isHudMode } from './hudMode.js';

describe('hudMode', () => {
  it('defaults to full', () => {
    expect(hudModeFromSearch('')).toBe('full');
    expect(hudModeFromSearch('?room=feel-test')).toBe('full');
  });

  it('?cinematic=1 means a clean frame', () => {
    expect(hudModeFromSearch('?cinematic=1')).toBe('none');
  });

  it('?hud= wins over ?cinematic', () => {
    expect(hudModeFromSearch('?cinematic=1&hud=minimal')).toBe('minimal');
    expect(hudModeFromSearch('?hud=clean')).toBe('clean');
    expect(hudModeFromSearch('?hud=full&cinematic=1')).toBe('full');
  });

  it('ignores unknown hud values', () => {
    expect(isHudMode('loud')).toBe(false);
    expect(hudModeFromSearch('?hud=loud')).toBe('full');
  });

  it('applyHudMode keeps exactly one hud class', () => {
    const classes = new Set<string>();
    const root = {
      classList: {
        add: (c: string) => void classes.add(c),
        remove: (c: string) => void classes.delete(c),
      } as unknown as DOMTokenList,
    };
    applyHudMode('none', root);
    applyHudMode('minimal', root);
    expect([...classes]).toEqual(['eqx-hud-minimal']);
  });
});

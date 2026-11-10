import { describe, it, expect } from 'vitest';
import {
  applyHudMode, applyHudOverlays, hudModeFromSearch, isHudMode, lockOverlaysVisible, radarVisible,
} from './hudMode.js';

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

describe('lock overlays follow the HUD mode (showcase clips, 2026-11-10)', () => {
  it('world lock marks show only with the full HUD', () => {
    expect(lockOverlaysVisible('full')).toBe(true);
    expect(lockOverlaysVisible('clean')).toBe(false);
    expect(lockOverlaysVisible('minimal')).toBe(false);
    expect(lockOverlaysVisible('none')).toBe(false);
  });

  it('the edge radar shows with the full HUD, or below it only with ?radar=1', () => {
    expect(radarVisible('full', '')).toBe(true);
    for (const m of ['clean', 'minimal', 'none'] as const) {
      expect(radarVisible(m, '?hud=' + m)).toBe(false);
      expect(radarVisible(m, '?hud=' + m + '&radar=1')).toBe(true);
    }
    expect(radarVisible('none', '?radar=10')).toBe(false);
    expect(radarVisible('none', '?xradar=1')).toBe(false);
  });

  it('applyHudOverlays pushes both switches to the renderer', () => {
    const calls: [boolean, boolean][] = [];
    const r = { setHudOverlays: (a: boolean, b: boolean) => void calls.push([a, b]) };
    applyHudOverlays(r, 'minimal', '?hud=minimal');
    applyHudOverlays(r, 'full', '');
    applyHudOverlays(r, 'none', '?radar=1');
    applyHudOverlays(null, 'none', '');
    expect(calls).toEqual([[false, false], [true, true], [false, true]]);
  });
});
// The banner's CSS rule (index.html) is locked by tests/unit/hudLockBandCss.test.ts.

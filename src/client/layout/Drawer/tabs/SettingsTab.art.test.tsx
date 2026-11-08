/**
 * Settings → Graphics (plan iridescent-seeking-rainbow, A5): the Machined
 * art switch defaults ON, and turning it off saves "classic" for this device
 * (read when the game next loads).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../../components/PushNotificationToggle', () => ({ PushNotificationToggle: () => null }));

import { SettingsTab } from './SettingsTab.js';
import { loadArtPreference, loadLightingPreference, loadSpeedFxPreference, resolveShipLighting, resolveSpeedFx } from '../../../render/art/artMode.js';

beforeEach(() => {
  localStorage.clear();
});

describe('SettingsTab — Graphics', () => {
  it('starts on, and saves classic when switched off', () => {
    render(<SettingsTab />);
    const sw = screen.getByTestId('settings-toggle-machined-art') as HTMLInputElement;
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    expect(sw.checked).toBe(false);
    expect(loadArtPreference()).toBe('classic');
    fireEvent.click(sw);
    expect(loadArtPreference()).toBe('machined');
  });

  it('speed effects start on, and switching off saves it for this device', () => {
    render(<SettingsTab />);
    const sw = screen.getByTestId('settings-toggle-speed-fx') as HTMLInputElement;
    expect(sw.checked).toBe(true);
    expect(resolveSpeedFx('', loadSpeedFxPreference())).toBe(true);
    fireEvent.click(sw);
    expect(loadSpeedFxPreference()).toBe(false);
    expect(resolveSpeedFx('', loadSpeedFxPreference())).toBe(false);
    // The URL wins either way (tests).
    expect(resolveSpeedFx('?speedfx=1', false)).toBe(true);
    expect(resolveSpeedFx('?speedfx=0', true)).toBe(false);
  });

  it('shows the saved choice', () => {
    localStorage.setItem('eqxArtStyle', 'classic');
    render(<SettingsTab />);
    expect((screen.getByTestId('settings-toggle-machined-art') as HTMLInputElement).checked).toBe(false);
  });

  it('lighting shows the device default, and a pick is saved for this device and used next load', () => {
    render(<SettingsTab />);
    const g = screen.getByTestId('settings-lighting');
    expect(g.getAttribute('data-value')).toBe('high'); // desktop (jsdom: no touch)
    fireEvent.click(screen.getByTestId('settings-lighting-low'));
    expect(loadLightingPreference()).toBe('low');
    expect(screen.getByTestId('settings-lighting').getAttribute('data-value')).toBe('low');
    expect(resolveShipLighting('', 'machined', { saved: loadLightingPreference() })!.selfShadowSteps).toBe(16);
    fireEvent.click(screen.getByTestId('settings-lighting-baked'));
    expect(resolveShipLighting('', 'machined', { saved: loadLightingPreference() })).toBeUndefined();
  });
});

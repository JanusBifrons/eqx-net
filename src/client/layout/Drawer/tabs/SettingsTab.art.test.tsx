/**
 * Settings → Graphics (plan iridescent-seeking-rainbow, A5): the Machined
 * art switch defaults ON, and turning it off saves "classic" for this device
 * (read when the game next loads).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../../components/PushNotificationToggle', () => ({ PushNotificationToggle: () => null }));

import { SettingsTab } from './SettingsTab.js';
import { loadArtPreference } from '../../../render/art/artMode.js';

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

  it('shows the saved choice', () => {
    localStorage.setItem('eqxArtStyle', 'classic');
    render(<SettingsTab />);
    expect((screen.getByTestId('settings-toggle-machined-art') as HTMLInputElement).checked).toBe(false);
  });
});

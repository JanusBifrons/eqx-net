/**
 * UI plan U2-8b: the desktop header's avatar and gear open the cog panel (the
 * `rightPanel` flag): the avatar on the Profile page, the gear on Settings.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useAuthStore } from '../auth/authStore.js';
import { useUIStore } from '../state/store.js';
import { AppHeader } from './AppHeader.js';

beforeEach(() => {
  useAuthStore.setState({ token: 'tok-123', user: { id: 'u1', email: 'pilot@eqx.test', displayName: 'Pilot' } });
  useUIStore.setState({ phase: 'galaxy-map', rightPanel: null, drawerTab: 'galaxy' });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({ token: null, user: null });
});

describe('AppHeader (U2-8b)', () => {
  it('the avatar opens the cog on the Profile page', () => {
    render(<AppHeader onLoginClick={() => {}} />);
    fireEvent.click(screen.getByTestId('header-avatar'));
    expect(useUIStore.getState().rightPanel).toBe('cog');
    expect(useUIStore.getState().drawerTab).toBe('profile');
  });

  it('the gear opens the cog on the Settings page', () => {
    render(<AppHeader onLoginClick={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-button'));
    expect(useUIStore.getState().rightPanel).toBe('cog');
    expect(useUIStore.getState().drawerTab).toBe('settings');
  });

  it('logged out: Login instead of the avatar', () => {
    useAuthStore.setState({ token: null, user: null });
    render(<AppHeader onLoginClick={() => {}} />);
    expect(screen.queryByTestId('header-avatar')).toBeNull();
    expect(screen.getByText('Login')).toBeTruthy();
  });
});

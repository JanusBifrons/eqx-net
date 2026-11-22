/**
 * UI plan U2-8b: the cog's Profile page shows the account (name, email) and
 * logs out through `useLogout` only after an inline second tap ("Confirm log
 * out" in place of Log out; no dialog). Cancel backs out without logging out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useAuthStore } from '../auth/authStore.js';
import { useUIStore } from '../state/store.js';

const logout = vi.fn();
vi.mock('../auth/useLogout', () => ({ useLogout: () => logout }));

const { CogProfilePage, openCogProfile } = await import('./CogProfilePage.js');

beforeEach(() => {
  logout.mockClear();
  useAuthStore.setState({ token: 'tok-123', user: { id: 'u1', email: 'pilot@eqx.test', displayName: 'Pilot' } });
  useUIStore.setState({ phase: 'game', rightPanel: null, drawerTab: 'galaxy' });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({ token: null, user: null });
});

describe('CogProfilePage (U2-8b)', () => {
  it('shows the name, email and initials', () => {
    render(<CogProfilePage />);
    expect(screen.getByTestId('cog-profile-name').textContent).toBe('Pilot');
    expect(screen.getByTestId('cog-profile-email').textContent).toBe('pilot@eqx.test');
    expect(screen.getByText('PI')).toBeTruthy();
  });

  it('log out needs two taps and calls the logout path once', () => {
    render(<CogProfilePage />);
    fireEvent.click(screen.getByTestId('cog-profile-logout'));
    expect(logout).not.toHaveBeenCalled();
    expect(screen.queryByTestId('cog-profile-logout')).toBeNull();
    fireEvent.click(screen.getByTestId('cog-profile-logout-confirm'));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('Cancel puts Log out back without logging out', () => {
    render(<CogProfilePage />);
    fireEvent.click(screen.getByTestId('cog-profile-logout'));
    fireEvent.click(screen.getByTestId('cog-profile-logout-cancel'));
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByTestId('cog-profile-logout')).toBeTruthy();
    expect(screen.queryByTestId('cog-profile-logout-confirm')).toBeNull();
  });

  it('closing the cog drops a half-made confirm, so reopening shows Log out', () => {
    openCogProfile();
    render(<CogProfilePage />);
    fireEvent.click(screen.getByTestId('cog-profile-logout'));
    expect(screen.getByTestId('cog-profile-logout-confirm')).toBeTruthy();
    act(() => { useUIStore.getState().setRightPanel(null); });
    act(() => { openCogProfile(); });
    expect(screen.getByTestId('cog-profile-logout')).toBeTruthy();
    expect(screen.queryByTestId('cog-profile-logout-confirm')).toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });

  it('a guest gets Sign in, which goes to the auth phase and closes the panel', () => {
    useAuthStore.setState({ token: null, user: null });
    useUIStore.setState({ phase: 'galaxy-map', rightPanel: 'cog', drawerTab: 'profile' });
    render(<CogProfilePage />);
    expect(screen.queryByTestId('cog-profile-logout')).toBeNull();
    fireEvent.click(screen.getByTestId('cog-profile-signin'));
    expect(useUIStore.getState().phase).toBe('auth');
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('openCogProfile opens the cog on the Profile page', () => {
    openCogProfile();
    expect(useUIStore.getState().rightPanel).toBe('cog');
    expect(useUIStore.getState().drawerTab).toBe('profile');
  });
});

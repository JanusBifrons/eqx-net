/**
 * `useLogout` is the single logout ownership site (Invariant #12). It must run
 * the full sequence — clear auth, return to the meta phase, close the drawer —
 * so no entry point (avatar menu / drawer Profile tab) can drift.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuthStore } from './authStore.js';
import { useUIStore } from '../state/store.js';
import { useLogout } from './useLogout.js';

describe('useLogout', () => {
  beforeEach(() => {
    useAuthStore.setState({
      token: 'tok-123',
      user: { id: 'u1', email: 'pilot@eqx.test', displayName: 'Pilot' },
    });
    useUIStore.setState({ phase: 'game', isDrawerOpen: true });
  });

  it('clears auth, returns to meta, and closes the drawer in one call', () => {
    const { result } = renderHook(() => useLogout());

    act(() => result.current());

    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useUIStore.getState().phase).toBe('meta');
    expect(useUIStore.getState().isDrawerOpen).toBe(false);
  });

  it('clears the persisted token from localStorage', () => {
    localStorage.setItem('eqxAuthToken', 'tok-123');
    const { result } = renderHook(() => useLogout());

    act(() => result.current());

    expect(localStorage.getItem('eqxAuthToken')).toBeNull();
  });
});

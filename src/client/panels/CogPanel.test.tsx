/**
 * UI plan U2-8a: the cog panel. One scrolling settings page with the Screen,
 * notification, Profile and Developer rows; Developer and Profile drill in with
 * ← back; the Developer page's snapshot-rate gate is true only on that page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../state/store';
import { selectDrawerTabShown } from '../state/rightPanel';

vi.mock('../layout/Drawer/tabs/SettingsTab', () => ({
  SettingsTab: () => <div data-testid="settings-body"><div data-testid="push-row" /></div>,
}));
vi.mock('./CogProfilePage', () => ({ CogProfilePage: () => <div data-testid="profile-body" /> }));
// The real DebugTab, with its snapshot-rate children stubbed.
vi.mock('../components/ConnectionDiagnostics', () => ({ ConnectionDiagnostics: () => <div data-testid="conn-diag" /> }));
vi.mock('../components/DevOverlay', () => ({ DevOverlay: () => <div data-testid="dev-overlay" /> }));
vi.mock('../components/LogPanel', () => ({ LogPanel: () => <div data-testid="log-panel" /> }));
vi.mock('../layout/useStandalone', () => ({ useStandalone: () => standalone, isIOS: () => false }));

let standalone = false;
const { CogPanel, cogPageFor } = await import('./CogPanel');

const debugShown = (): boolean => selectDrawerTabShown('debug')(useUIStore.getState());

beforeEach(() => {
  standalone = false;
  useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' });
});
afterEach(() => {
  cleanup();
  useUIStore.setState({ rightPanel: null, drawerTab: 'galaxy' });
});

describe('CogPanel (U2-8a)', () => {
  it('the rail cog opens the main page: settings, Screen, Profile and Developer rows', () => {
    render(<CogPanel />);
    act(() => useUIStore.getState().setDrawerTab('settings'));
    expect(useUIStore.getState().rightPanel).toBe('cog');
    expect(screen.getByTestId('cog-panel')).toBeTruthy();
    expect(screen.getByTestId('cog-page-settings')).toBeTruthy();
    expect(screen.getByTestId('settings-body')).toBeTruthy();
    expect(screen.getByTestId('push-row')).toBeTruthy();
    expect(screen.getByTestId('cog-fullscreen')).toBeTruthy();
    expect(screen.getByTestId('cog-install')).toBeTruthy();
    expect(screen.getByTestId('cog-row-profile')).toBeTruthy();
    expect(screen.getByTestId('cog-row-developer')).toBeTruthy();
    // The main page has no ← back.
    expect(screen.queryByTestId('eqx-panel-back')).toBeNull();
  });

  it('Developer drills in (← back returns); the debug gate is true only on that page', () => {
    render(<CogPanel />);
    act(() => useUIStore.getState().setDrawerTab('settings'));
    expect(debugShown()).toBe(false);
    expect(screen.queryByTestId('conn-diag')).toBeNull();

    fireEvent.click(screen.getByTestId('cog-row-developer'));
    expect(useUIStore.getState().drawerTab).toBe('debug');
    expect(useUIStore.getState().rightPanel).toBe('cog');
    expect(debugShown()).toBe(true);
    expect(screen.getByText('Developer')).toBeTruthy();
    expect(screen.getByTestId('conn-diag')).toBeTruthy();
    expect(screen.getByTestId('diag-capture-button')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-dev-overlay')).toBeTruthy();
    expect(screen.queryByTestId('cog-row-developer')).toBeNull();

    fireEvent.click(screen.getByTestId('eqx-panel-back'));
    expect(useUIStore.getState().drawerTab).toBe('settings');
    expect(debugShown()).toBe(false);
    expect(screen.queryByTestId('conn-diag')).toBeNull();
    expect(screen.getByTestId('cog-row-developer')).toBeTruthy();
  });

  it('closing on the Developer page turns the gate off and unmounts the debug content', () => {
    render(<CogPanel />);
    act(() => useUIStore.getState().setDrawerTab('debug'));
    expect(screen.getByTestId('conn-diag')).toBeTruthy();
    fireEvent.click(screen.getByTestId('cog-close'));
    expect(useUIStore.getState().rightPanel).toBeNull();
    expect(debugShown()).toBe(false);
    expect(screen.queryByTestId('conn-diag')).toBeNull();
  });

  it('Profile drills in with ← back', () => {
    render(<CogPanel />);
    act(() => useUIStore.getState().setDrawerTab('settings'));
    fireEvent.click(screen.getByTestId('cog-row-profile'));
    expect(useUIStore.getState().drawerTab).toBe('profile');
    expect(screen.getByTestId('profile-body')).toBeTruthy();
    fireEvent.click(screen.getByTestId('eqx-panel-back'));
    expect(screen.getByTestId('settings-body')).toBeTruthy();
  });

  it('inside an installed app the Full screen and Install rows are hidden', () => {
    standalone = true;
    render(<CogPanel />);
    act(() => useUIStore.getState().setDrawerTab('settings'));
    expect(screen.queryByTestId('cog-fullscreen')).toBeNull();
    expect(screen.queryByTestId('cog-install')).toBeNull();
  });

  it('Install opens the install hint', () => {
    render(<CogPanel />);
    act(() => useUIStore.getState().setDrawerTab('settings'));
    fireEvent.click(screen.getByTestId('cog-install'));
    expect(screen.getByTestId('install-dialog')).toBeTruthy();
  });

  it('cogPageFor: the main page for any non-cog page id', () => {
    expect(cogPageFor('debug')).toBe('debug');
    expect(cogPageFor('profile')).toBe('profile');
    expect(cogPageFor('galaxy')).toBe('settings');
  });
});

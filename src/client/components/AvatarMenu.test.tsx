/**
 * The avatar context menu is the shared logout/display-name surface for both
 * the desktop header and the mobile landing badge. Behaviour under test:
 *   - clicking the avatar opens the popover menu (Display name + Logout);
 *   - "Display name" fires `onProfileClick` (opens the ProfileModal upstream)
 *     and does NOT log out;
 *   - "Logout" opens a confirm dialog and does NOT immediately clear auth
 *     (the confirm-dialog gate — user decision);
 *   - confirming clears auth and returns to the meta phase (real logout).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useAuthStore } from '../auth/authStore.js';
import { useUIStore } from '../state/store.js';
import { AvatarMenu } from './AvatarMenu.js';

function seedLoggedIn(): void {
  useAuthStore.setState({
    token: 'tok-123',
    user: { id: 'u1', email: 'pilot@eqx.test', displayName: 'Pilot' },
  });
  useUIStore.setState({ phase: 'game', isDrawerOpen: false });
}

describe('AvatarMenu', () => {
  beforeEach(() => {
    seedLoggedIn();
  });

  it('renders nothing when logged out', () => {
    useAuthStore.setState({ token: null, user: null });
    const { container } = render(<AvatarMenu onProfileClick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the popover menu with Display name + Logout on click', () => {
    render(<AvatarMenu onProfileClick={() => {}} />);
    fireEvent.click(screen.getByTestId('avatar-menu-trigger'));
    expect(screen.getByTestId('avatar-menu-display-name')).toBeInTheDocument();
    expect(screen.getByTestId('avatar-menu-logout')).toBeInTheDocument();
  });

  it('"Display name" fires onProfileClick and does not log out', () => {
    const onProfileClick = vi.fn();
    render(<AvatarMenu onProfileClick={onProfileClick} />);
    fireEvent.click(screen.getByTestId('avatar-menu-trigger'));
    fireEvent.click(screen.getByTestId('avatar-menu-display-name'));
    expect(onProfileClick).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user).not.toBeNull();
  });

  it('"Logout" opens a confirm dialog without immediately clearing auth', () => {
    render(<AvatarMenu onProfileClick={() => {}} />);
    fireEvent.click(screen.getByTestId('avatar-menu-trigger'));
    fireEvent.click(screen.getByTestId('avatar-menu-logout'));
    expect(screen.getByTestId('avatar-logout-confirm-dialog')).toBeInTheDocument();
    // Still logged in until the user confirms.
    expect(useAuthStore.getState().user).not.toBeNull();
    expect(useUIStore.getState().phase).toBe('game');
  });

  it('confirming logout clears auth and returns to the meta phase', () => {
    render(<AvatarMenu onProfileClick={() => {}} />);
    fireEvent.click(screen.getByTestId('avatar-menu-trigger'));
    fireEvent.click(screen.getByTestId('avatar-menu-logout'));
    fireEvent.click(screen.getByTestId('avatar-logout-confirm-button'));
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
    expect(useUIStore.getState().phase).toBe('meta');
  });

  it('mobile variant renders the badge trigger testid', () => {
    render(<AvatarMenu variant="mobile" onProfileClick={() => {}} />);
    expect(screen.getByTestId('mobile-avatar-badge')).toBeInTheDocument();
  });
});

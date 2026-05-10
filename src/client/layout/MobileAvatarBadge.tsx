import { Avatar, Tooltip } from '@mui/material';
import { useAuthStore } from '../auth/authStore.js';
import { isTouchDevice } from '../input/TouchInput';
import { Slot } from './Slot';

interface Props {
  /** Tap handler — typically opens the ProfileModal so the user can see
   *  display name / email and log out. */
  onClick: () => void;
}

/**
 * Floating avatar pip for the meta-landing splash on mobile.
 *
 * Desktop already surfaces auth state via the persistent `AppHeader` /
 * `AvatarMenu`. On touch the AppBar is hidden, so without this badge the
 * player has no at-a-glance signal that they're logged in on the splash
 * screen. Only mounted on the meta phase — in-game and on the galaxy map
 * the right-edge drawer's Profile tab already covers this.
 *
 * Renders nothing when not on a touch device or not logged in.
 */
function initials(user: { displayName: string | null; email: string }): string {
  const name = user.displayName ?? user.email;
  return name.slice(0, 2).toUpperCase();
}

export function MobileAvatarBadge({ onClick }: Props): JSX.Element | null {
  const user = useAuthStore((s) => s.user);

  if (!user) return null;
  if (!isTouchDevice()) return null;

  // Slotted into top-right at order=1 so on the meta phase it sits ABOVE
  // the FullscreenToggle (order=2). It only renders on the meta phase, so
  // it doesn't collide with the in-game DrawerToggle (also order=1) which
  // is exclusively on the game phase.
  return (
    <Slot anchor="top-right" order={1}>
      <Tooltip title={user.displayName ?? user.email} placement="left">
        <Avatar
          data-testid="mobile-avatar-badge"
          onClick={onClick}
          sx={{
            width: 34,
            height: 34,
            fontSize: 13,
            cursor: 'pointer',
            bgcolor: 'rgba(0, 255, 136, 0.85)',
            color: '#000',
            border: '1px solid rgba(0, 255, 136, 0.55)',
            boxShadow: '0 0 6px rgba(0, 255, 136, 0.35)',
            fontWeight: 700,
            letterSpacing: 0.5,
          }}
        >
          {initials(user)}
        </Avatar>
      </Tooltip>
    </Slot>
  );
}

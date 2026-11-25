import { useAuthStore } from '../auth/authStore.js';
import { isTouchDevice } from '../input/TouchInput';
import { openCogProfile, ProfileAvatar } from '../panels/CogProfilePage.js';
import { Slot } from './Slot';

/**
 * Floating avatar pip for the galaxy map (the homepage) on mobile.
 *
 * Desktop surfaces auth state via the homepage `AppHeader` avatar. On touch
 * the AppBar is hidden, so without this badge the player has no at-a-glance
 * signal that they're logged in on the galaxy map. Only mounted on the
 * galaxy-map phase — in game the rail's cog reaches the same Profile page.
 *
 * A tap opens the cog panel's Profile page (`openCogProfile`), the same page
 * the desktop header avatar opens: name, account and Log out.
 *
 * Renders nothing when not on a touch device or not logged in.
 */
export function MobileAvatarBadge(): JSX.Element | null {
  const user = useAuthStore((s) => s.user);

  if (!user) return null;
  if (!isTouchDevice()) return null;

  // Slotted into top-right at order=1.
  // It only renders on the galaxy-map phase.
  return (
    <Slot anchor="top-right" order={1}>
      <ProfileAvatar name={user.displayName ?? user.email} size={34} onClick={openCogProfile} data-testid="mobile-avatar-badge" />
    </Slot>
  );
}

import { useAuthStore } from '../auth/authStore.js';
import { isTouchDevice } from '../input/TouchInput';
import { AvatarMenu } from '../components/AvatarMenu.js';
import { Slot } from './Slot';

interface Props {
  /** Opens the display-name editor (`ProfileModal`) from the menu's
   *  "Display name" item. */
  onProfileClick: () => void;
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
 * The badge now opens the SAME `AvatarMenu` popover (Display name + Logout) as
 * the desktop header — this component only owns the touch/meta gate and the
 * layout `Slot`; the trigger styling + menu behaviour live in `AvatarMenu`'s
 * `mobile` variant.
 *
 * Renders nothing when not on a touch device or not logged in.
 */
export function MobileAvatarBadge({ onProfileClick }: Props): JSX.Element | null {
  const user = useAuthStore((s) => s.user);

  if (!user) return null;
  if (!isTouchDevice()) return null;

  // Slotted into top-right at order=1 so on the meta phase it sits ABOVE
  // the FullscreenToggle (order=2). It only renders on the meta phase, so
  // it doesn't collide with the in-game DrawerToggle (also order=1) which
  // is exclusively on the game phase.
  return (
    <Slot anchor="top-right" order={1}>
      <AvatarMenu variant="mobile" onProfileClick={onProfileClick} />
    </Slot>
  );
}

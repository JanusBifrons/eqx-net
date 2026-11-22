/**
 * The cog panel's Profile page (UI language plan U2-8b): the one place for the
 * account. It took over the old ProfileTab, ProfileModal, AvatarMenu popover
 * and LogoutConfirmDialog: your avatar, name and email, the display-name
 * editor, and Log out with an INLINE confirm (the button turns into "Confirm
 * log out" + Cancel in place; no dialog). A guest gets Sign in instead.
 *
 * Log out goes through `useLogout` (the single logout ownership site), the
 * same path the old confirm dialog called. `ProfileAvatar` is the initials pip
 * the desktop header and the touch galaxy-map badge draw; both open this page
 * (`openCogProfile`).
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { EqxButton, EqxSection, EqxTextField } from '../../ui/index.js';
import { HUD } from '../hud/tokens';
import { useAuthStore } from '../auth/authStore';
import { useLogout } from '../auth/useLogout';
import { apiUpdateProfile } from '../auth/authApi';
import { useUIStore } from '../state/store';
import { COG_SECTION_STYLE } from './cogRows';

/** Opens the cog panel on the Profile page (header avatar, touch badge). */
export function openCogProfile(): void {
  useUIStore.getState().setDrawerTab('profile');
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

const AVATAR_STYLE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
  borderRadius: '50%', border: `1px solid ${HUD.color.brand}`, padding: 0,
  background: HUD.color.brand, color: HUD.color.onAccent,
  fontFamily: HUD.font.label, fontWeight: 700, letterSpacing: 0.5,
};

export interface ProfileAvatarProps {
  /** Display name, else email: the initials and the accessible name. */
  name: string;
  /** Diameter, px. */
  size: number;
  /** Given: a button (the header / badge); else a plain picture. */
  onClick?: () => void;
  'data-testid'?: string;
}

/** The account's initials pip. */
export function ProfileAvatar({ name, size, onClick, 'data-testid': testId }: ProfileAvatarProps): JSX.Element {
  const style = { ...AVATAR_STYLE, width: size, height: size, fontSize: Math.round(size * 0.38) };
  if (!onClick) return <span style={style} aria-hidden data-testid={testId}>{initials(name)}</span>;
  return (
    <button type="button" style={{ ...style, cursor: 'pointer' }} onClick={onClick}
      aria-label={`Profile: ${name}`} title={name} data-testid={testId}>
      {initials(name)}
    </button>
  );
}

const PAGE_STYLE: CSSProperties = { ...COG_SECTION_STYLE, display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 12 };
const ID_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 };
const NAME_STYLE: CSSProperties = {
  fontFamily: HUD.font.label, fontSize: 14, fontWeight: 600, color: HUD.color.ink,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const NOTE_STYLE: CSSProperties = {
  fontFamily: HUD.font.label, fontSize: HUD.list.rowSmallFont, color: HUD.color.inkDim,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const ROW_STYLE: CSSProperties = { display: 'flex', gap: 8 };

function GuestProfile(): JSX.Element {
  const onSignIn = (): void => {
    const s = useUIStore.getState();
    s.setPhase('auth');
    s.setRightPanel(null);
  };
  return (
    <div style={PAGE_STYLE} data-testid="cog-profile-guest">
      <div style={NOTE_STYLE}>You&rsquo;re playing as a guest.</div>
      <EqxButton tone="primary" fullWidth onClick={onSignIn} data-testid="cog-profile-signin">Sign in</EqxButton>
    </div>
  );
}

/** Log out, then "Confirm log out" + Cancel in its place. */
function LogoutRow(): JSX.Element {
  const logout = useLogout();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return <EqxButton tone="danger" fullWidth onClick={() => setConfirming(true)} data-testid="cog-profile-logout">Log out</EqxButton>;
  }
  return (
    <>
      <div style={NOTE_STYLE}>Your session ends and you go back to the galaxy map.</div>
      <div style={ROW_STYLE}>
        <EqxButton fullWidth onClick={() => setConfirming(false)} data-testid="cog-profile-logout-cancel">Cancel</EqxButton>
        <EqxButton tone="danger" fullWidth onClick={() => { setConfirming(false); logout(); }}
          data-testid="cog-profile-logout-confirm">Confirm log out</EqxButton>
      </div>
    </>
  );
}

export function CogProfilePage(): JSX.Element {
  const { user, token, setAuth } = useAuthStore();
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  useEffect(() => { setDisplayName(user?.displayName ?? ''); }, [user]);

  if (!user) return <GuestProfile />;

  const onSave = async (): Promise<void> => {
    if (!token) return;
    const trimmed = displayName.trim();
    if (!trimmed) { setNameError('Display name cannot be empty'); return; }
    setSaving(true);
    setNameError(undefined);
    try {
      const { user: updated } = await apiUpdateProfile(token, trimmed);
      setAuth(token, updated);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const shown = user.displayName ?? user.email;
  return (
    <div style={PAGE_STYLE} data-testid="cog-profile">
      <div style={ID_STYLE}>
        <ProfileAvatar name={shown} size={44} />
        <div style={{ minWidth: 0 }}>
          <div style={NAME_STYLE} data-testid="cog-profile-name">{shown}</div>
          <div style={NOTE_STYLE} data-testid="cog-profile-email">{user.email}</div>
        </div>
      </div>
      <EqxSection title="Display name">
        <EqxTextField label="Display name" value={displayName} onChange={(v) => setDisplayName(v.slice(0, 32))}
          error={nameError} data-testid="cog-profile-display-name" />
        <EqxButton fullWidth onClick={() => void onSave()} disabled={saving || displayName.trim() === (user.displayName ?? '')}
          data-testid="cog-profile-save">{saving ? 'Saving…' : 'Save'}</EqxButton>
      </EqxSection>
      <EqxSection title="Account">
        <LogoutRow />
      </EqxSection>
    </div>
  );
}

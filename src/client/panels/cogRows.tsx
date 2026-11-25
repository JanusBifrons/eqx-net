/**
 * The cog panel's own rows (UI language plan U2-8a): the Screen section (Full
 * screen switch, Install row), drawn with the catalogue EqxSection / EqxListRow.
 *
 * Full screen reuses `layout/useFullscreen.ts` (the same enter the game's
 * first-tap full screen uses, `layout/useFirstTapFullscreen.ts`); where the
 * browser can't go full screen (iOS Safari) it opens the install hint instead.
 * Both rows hide inside an installed app (`useStandalone`), which is already
 * full screen: an action that can't work is hidden, never shown and refused
 * (plan A4).
 */
import { useState, type CSSProperties } from 'react';
import { EqxListRow, EqxSection, EqxSwitch, EqxWindow } from '../../ui/index.js';
import { useFullscreen } from '../layout/useFullscreen';
import { isIOS, useStandalone } from '../layout/useStandalone';

/** Lines a cog section up with the Settings page above it (16 px sides). */
export const COG_SECTION_STYLE: CSSProperties = { padding: '0 16px' };

const HINT_STYLE: CSSProperties = { padding: '12px 16px', fontSize: 13, lineHeight: 1.5 };

/** The install hint (Add to Home Screen): how to get a browser with no address bar. */
export function InstallDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  return (
    <EqxWindow open={open} onClose={onClose} testId="install-dialog" title="Install for full screen" closeTestId="install-dialog-close">
      <div style={HINT_STYLE}>
        {isIOS() ? (
          <>iOS Safari can&apos;t hide its address bar in a normal tab. Tap the share icon at the bottom of the
            screen, choose <strong>Add to Home Screen</strong>, then launch Equinox from the icon — the address bar
            disappears entirely.</>
        ) : (
          <>Open the browser menu (⋮) and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>,
            then launch Equinox from the icon for a true full-screen experience.</>
        )}
      </div>
    </EqxWindow>
  );
}

/** Full screen switch + Install row. Renders nothing inside an installed app. */
export function CogScreenSection(): JSX.Element | null {
  const { isFullscreen, enterFullscreen, exitFullscreen } = useFullscreen();
  const standalone = useStandalone();
  const [installOpen, setInstallOpen] = useState(false);
  if (standalone) return null;

  const onFullscreen = async (on: boolean): Promise<void> => {
    if (!on) { await exitFullscreen(); return; }
    // iOS Safari has no full screen for a page: show the install hint instead.
    if (!(await enterFullscreen())) setInstallOpen(true);
  };

  return (
    <div style={COG_SECTION_STYLE}><EqxSection title="Screen" data-testid="cog-screen">
      <EqxSwitch checked={isFullscreen} onChange={(on) => void onFullscreen(on)} label="Full screen"
        data-testid="cog-fullscreen" />
      <EqxListRow primary="Install the app" secondary="Add Equinox to your home screen: it opens full screen, with no address bar."
        onOpen={() => setInstallOpen(true)} data-testid="cog-install" />
      <InstallDialog open={installOpen} onClose={() => setInstallOpen(false)} />
    </EqxSection></div>
  );
}

/**
 * The cog panel's own rows (UI language plan U2-8a): the Screen section (Full
 * screen switch, Install row) and the drill-down row that opens a sub-page.
 *
 * Full screen reuses `layout/useFullscreen.ts` (the same enter / exit the top-
 * right FullscreenToggle chip uses); where the browser can't go full screen
 * (iOS Safari) it opens the chip's install hint instead. Both rows hide inside
 * an installed app (`useStandalone`), which is already full screen: an action
 * that can't work is hidden, never shown and refused (plan A4).
 */
import { useState, type CSSProperties } from 'react';
import { EqxSwitch } from '../../ui/index.js';
import { HUD } from '../hud/tokens';
import { useFullscreen } from '../layout/useFullscreen';
import { useStandalone } from '../layout/useStandalone';
import { InstallDialog } from '../layout/FullscreenToggle';

/** A small section heading (the scroll-with-headings pattern, plan A4). */
const HEADING_STYLE: CSSProperties = {
  color: HUD.color.inkDim, fontFamily: HUD.font.label, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', margin: '0 0 4px',
};
const LABEL_STYLE: CSSProperties = { display: 'block', fontSize: 14 };
const CAPTION_STYLE: CSSProperties = { display: 'block', fontSize: 12, color: HUD.color.inkDim, marginTop: 2 };
const ROW_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', textAlign: 'left',
  padding: '10px 12px', minHeight: HUD.touchMin, boxSizing: 'border-box', cursor: 'pointer',
  background: HUD.color.cell, border: `1px solid ${HUD.color.panelEdge}`, borderRadius: 4,
  color: HUD.color.ink, fontFamily: HUD.font.label,
};
const CHEVRON_STYLE: CSSProperties = { color: HUD.color.inkDim, fontSize: 18, lineHeight: 1 };
/** A section of the cog page: its heading, then its rows. */
export const COG_SECTION_STYLE: CSSProperties = { padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 8 };

/** A section heading. */
export function CogHeading({ children }: { children: string }): JSX.Element {
  return <h3 style={HEADING_STYLE}>{children}</h3>;
}

interface CogRowProps {
  label: string;
  caption?: string;
  onClick: () => void;
  testId: string;
  /** Draw the drill-down chevron (the row opens a sub-page). */
  drill?: boolean;
}

/** One tappable panel row: label, optional caption, a chevron when it drills in. */
export function CogRow({ label, caption, onClick, testId, drill = false }: CogRowProps): JSX.Element {
  return (
    <button type="button" style={ROW_STYLE} onClick={onClick} data-testid={testId}>
      <span>
        <span style={LABEL_STYLE}>{label}</span>
        {caption !== undefined && <span style={CAPTION_STYLE}>{caption}</span>}
      </span>
      {drill && <span aria-hidden style={CHEVRON_STYLE}>›</span>}
    </button>
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
    <section style={COG_SECTION_STYLE} data-testid="cog-screen">
      <CogHeading>Screen</CogHeading>
      <EqxSwitch checked={isFullscreen} onChange={(on) => void onFullscreen(on)} label="Full screen"
        data-testid="cog-fullscreen" />
      <CogRow label="Install the app" caption="Add Equinox to your home screen: it opens full screen, with no address bar."
        onClick={() => setInstallOpen(true)} testId="cog-install" />
      <InstallDialog open={installOpen} onClose={() => setInstallOpen(false)} />
    </section>
  );
}

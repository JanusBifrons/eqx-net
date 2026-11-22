/**
 * The cog panel (UI language plan U2-8a): settings as ONE scrolling panel with
 * small section headings (plan A4), opened by the rail's cog (`rightPanel =
 * 'cog'`). It merges the old drawer's Settings page with the desktop
 * SettingsModal's controls: return to menu, graphics, Screen (Full screen,
 * Install), notifications (PushNotificationToggle), then two drill-down rows:
 * Profile (unchanged ProfileTab until U2-8b) and Developer (the old Debug page:
 * the debug overlay / server log / server ghost switches, ConnectionDiagnostics,
 * DevOverlay, LogPanel and the diagnostic capture).
 *
 * The page shown is the store's `drawerTab` (`settings` = the main page,
 * `profile`, `debug` = Developer), the same flag the drawer pages use, so the
 * snapshot-rate gates keep working unchanged: `selectDrawerTabShown('debug')`
 * is true only while the Developer page is on screen, and the debug data push
 * in `net/ColyseusClient.ts` keys on `rightPanel === 'cog' && drawerTab ===
 * 'debug'`. A drill-down page has ← back to the main page.
 *
 * Like every EqxPanel this is a persistent Drawer (children stay mounted while
 * closed); only the current page is rendered, so the Developer page's
 * subscribers do not exist on the main page at all.
 */
import { useCallback, useMemo, type CSSProperties } from 'react';
import { EQX_PANEL_SIZE, EqxPanel } from '../../ui/index.js';
import { useUIStore } from '../state/store';
import { SettingsTab } from '../layout/Drawer/tabs/SettingsTab';
import { ProfileTab } from '../layout/Drawer/tabs/ProfileTab';
import { DebugTab } from '../layout/Drawer/tabs/DebugTab';
import { CogHeading, CogRow, CogScreenSection, COG_SECTION_STYLE } from './cogRows';

/** The cog's pages, keyed by their `drawerTab` id (the main page first). */
export const COG_PAGES = ['settings', 'profile', 'debug'] as const;
export type CogPage = (typeof COG_PAGES)[number];

const TITLE: Readonly<Record<CogPage, string>> = { settings: 'Settings', profile: 'Profile', debug: 'Developer' };

/** The page the cog shows for `drawerTab` (the main page for any other id). */
export function cogPageFor(drawerTab: string): CogPage {
  return (COG_PAGES as readonly string[]).includes(drawerTab) ? (drawerTab as CogPage) : 'settings';
}

const PAGE_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 16 };
/** The Paper carries the visible test id: a persistent Drawer's root is zero-size. */
const PAPER_ATTRS = { 'data-testid': 'cog-panel' } as const;

function MainPage({ open }: { open: (page: CogPage) => void }): JSX.Element {
  return (
    <div style={PAGE_STYLE}>
      <SettingsTab />
      <CogScreenSection />
      <section style={COG_SECTION_STYLE}>
        <CogHeading>More</CogHeading>
        <CogRow label="Profile" caption="Your name and account." onClick={() => open('profile')} testId="cog-row-profile" drill />
        <CogRow label="Developer" caption="Debug overlay, server log, connection stats and diagnostic capture."
          onClick={() => open('debug')} testId="cog-row-developer" drill />
      </section>
    </div>
  );
}

export function CogPanel(): JSX.Element {
  const isOpen = useUIStore((s) => s.rightPanel === 'cog');
  const page = useUIStore((s) => cogPageFor(s.drawerTab));
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const setDrawerTab = useUIStore((s) => s.setDrawerTab);
  const handleClose = useCallback(() => setRightPanel(null), [setRightPanel]);
  const back = useCallback(() => setDrawerTab('settings'), [setDrawerTab]);
  // Memoised so a page keeps its identity across renders (no remount).
  const body = useMemo(() => {
    if (page === 'profile') return <ProfileTab />;
    if (page === 'debug') return <DebugTab />;
    return <MainPage open={setDrawerTab} />;
  }, [page, setDrawerTab]);

  return (
    <EqxPanel
      open={isOpen}
      onClose={handleClose}
      testId="cog-panel-root"
      paperAttrs={PAPER_ATTRS}
      closeTestId="cog-close"
      title={TITLE[page]}
      onBack={page === 'settings' ? undefined : back}
      size={EQX_PANEL_SIZE}
      closeOnEscape
    >
      <div data-testid={`cog-page-${page}`}>{body}</div>
    </EqxPanel>
  );
}

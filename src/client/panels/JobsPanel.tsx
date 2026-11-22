/**
 * The Jobs right panel (UI language plan A4, job U2-5): 2 views of the same
 * board on an `EqxSegmented` under the header, Contracts (elites and the world
 * event) and Bounties (pilots with a price on their head). Opened by the rail's
 * Jobs item (`rightPanel = 'jobs'`).
 *
 * The view shown is the store's `drawerTab` (`contracts` | `bounties`; both map
 * to the `jobs` panel in `DRAWER_TAB_PANEL`), so a rail tap keeps the view you
 * left. The board itself is `ContractsTab`, which polls `GET /galaxy/contracts`
 * only while one of the two views is on screen (`selectDrawerTabShown`). It is
 * one element across both views, so a switch keeps the last reply (no reload).
 */
import { useCallback, type CSSProperties } from 'react';
import { EQX_PANEL_SIZE, EqxPanel, EqxSegmented } from '../../ui/index.js';
import { useUIStore } from '../state/store';
import { ContractsTab, type JobsPage } from '../layout/Drawer/tabs/ContractsTab';

/** The switch's views, keyed by their `drawerTab` id (the first is the default). */
export const JOBS_VIEWS: readonly { id: JobsPage; label: string }[] = [
  { id: 'contracts', label: 'Contracts' },
  { id: 'bounties', label: 'Bounties' },
];

/** The view shown for `drawerTab` (Contracts for any other id). */
export function jobsViewFor(drawerTab: string): JobsPage {
  return drawerTab === 'bounties' ? 'bounties' : 'contracts';
}

/** The Paper carries the visible test id: a persistent Drawer's root is zero-size. */
const PAPER_ATTRS = { 'data-testid': 'jobs-panel' } as const;
const BODY_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 };

export function JobsPanel(): JSX.Element {
  const open = useUIStore((s) => s.rightPanel === 'jobs');
  const view = useUIStore((s) => jobsViewFor(s.drawerTab));
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const setDrawerTab = useUIStore((s) => s.setDrawerTab);
  const onClose = useCallback(() => setRightPanel(null), [setRightPanel]);

  return (
    <EqxPanel
      open={open}
      onClose={onClose}
      testId="jobs-panel-root"
      paperAttrs={PAPER_ATTRS}
      closeTestId="jobs-panel-close"
      title="Jobs"
      size={EQX_PANEL_SIZE}
      closeOnEscape
    >
      <div style={BODY_STYLE}>
        <EqxSegmented options={JOBS_VIEWS} value={view} onChange={setDrawerTab} label="Jobs views"
          data-testid="jobs-view" />
        <ContractsTab page={view} />
      </div>
    </EqxPanel>
  );
}

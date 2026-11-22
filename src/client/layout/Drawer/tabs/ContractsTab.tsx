/**
 * Living World P4c: the Jobs panel's board, what's worth hunting right now.
 * Two pages (UI plan U2-5, `panels/JobsPanel.tsx` switches them):
 * - **Contracts** (`drawerTab = 'contracts'`): named elites (with their bounty)
 *   and the running world event;
 * - **Bounties** (`drawerTab = 'bounties'`): bounties players put on pilots
 *   (P4c-2).
 * Each row says where to go. Rebuilt ONLY from `GET /galaxy/contracts` (#16),
 * polled only while one of the two pages is on screen (drawer-perf rule,
 * `selectDrawerTabShown`). Tapping a row opens the galaxy map so the pilot can
 * warp there. No raw ids: sectors show by name. Rows are catalogue
 * `EqxSection` / `EqxListRow`.
 */
import { memo, useEffect, useState, type CSSProperties } from 'react';
import { EqxListRow, EqxSection } from '../../../../ui/index.js';
import { useUIStore } from '../../../state/store';
import { selectDrawerTabShown } from '../../../state/rightPanel';
import type { UIStore } from '../../../state/storeTypes';
import { fetchContracts, formatReward, formatTimeLeft } from '../../../net/contractsApi';
import { sectorName } from '../../../net/tradeView';
import type { Contract, ContractKind } from '../../../../shared-types/contracts';

const POLL_MS = 4000;

/** The Jobs panel's pages, keyed by their `drawerTab` id. */
export type JobsPage = 'contracts' | 'bounties';

/** The sections of each page, in order: heading and the contract kind listed. */
const PAGE_SECTIONS: Readonly<Record<JobsPage, readonly { title: string; kind: ContractKind }[]>> = {
  contracts: [
    { title: 'Elites', kind: 'elite' },
    { title: 'Events', kind: 'event' },
  ],
  bounties: [{ title: 'Wanted pilots', kind: 'player' }],
};

const EMPTY_LINE: Readonly<Record<JobsPage, string>> = {
  contracts: 'Elites and events appear every few minutes.',
  bounties: 'No pilot has a price on their head.',
};

const showsContracts = selectDrawerTabShown('contracts');
const showsBounties = selectDrawerTabShown('bounties');
/** True while either Jobs page is on screen (the poll gate). */
export const selectJobsShown = (s: Pick<UIStore, 'rightPanel' | 'drawerTab'>): boolean =>
  showsContracts(s) || showsBounties(s);

const PAGE_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };

function openMap(): void {
  const st = useUIStore.getState();
  st.setRightPanel(null);
  st.setGalaxyMapOpen(true);
}

/** "Gunship elite · Greenfall · 1:05 left" */
function detailLine(c: Contract, now: number): string {
  const where = c.sectorKey === '' ? 'Location unknown' : sectorName(c.sectorKey);
  const left = c.endsAtMs !== null ? ` · ${formatTimeLeft(c.endsAtMs, now)} left` : '';
  return `${c.detail} · ${where}${left}`;
}

export const ContractsTab = memo(function ContractsTab({ page = 'contracts' }: { page?: JobsPage }): JSX.Element {
  const visible = useUIStore(selectJobsShown);
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    const load = async (): Promise<void> => {
      const c = await fetchContracts();
      if (cancelled) return;
      if (c !== null) setContracts(c);
      setNow(Date.now());
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [visible]);

  const sections = PAGE_SECTIONS[page];
  const listed = contracts?.filter((c) => sections.some((s) => s.kind === c.kind)) ?? null;

  return (
    <div style={PAGE_STYLE} data-testid="contracts-tab" data-page={page}>
      {listed === null && <EqxListRow primary="Loading…" />}
      {listed !== null && listed.length === 0 && (
        <EqxListRow primary="Nothing on the board right now" secondary={EMPTY_LINE[page]} data-testid="contracts-empty" />
      )}
      {listed !== null && listed.length > 0 && sections.map((s) => {
        const rows = listed.filter((c) => c.kind === s.kind);
        if (rows.length === 0) return null;
        return (
          <EqxSection key={s.kind} title={s.title} data-testid={`contracts-section-${s.kind}`}>
            {rows.map((c) => (
              <EqxListRow key={c.id} primary={c.title} secondary={detailLine(c, now)} side={formatReward(c)}
                onOpen={openMap} data-testid="contract-row" />
            ))}
          </EqxSection>
        );
      })}
    </div>
  );
});

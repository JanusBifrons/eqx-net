/**
 * The Orders panel (UI language plan A4, job U3-5): the one right panel for
 * the selected own ships, opened by ⚙ on the left strip's fleet section or the
 * rail's Fleet item in Command (`rightPanel = 'orders'`). It replaces the old
 * FleetPanel (desktop), FleetStrip (phone) and HelmPanel (speed telegraph).
 *
 * - Order, Stance and Speed are EqxSegmented controls. A pick is a draft until
 *   Apply: the changed segment shows amber (`appliedValue`), Apply sends only
 *   what changed (`ordersDraft.ts`) and folds the panel away. Patrol / Escort /
 *   Retreat start the map pick instead of sending (the left strip shows its tools).
 * - A mixed selection selects nothing and says "mixed" in the heading.
 * - Speed shows only in Command (`helmOrdersAllowed`), never Fly or Build.
 * - Stop (footer) halts the selection at once. Form / disband squad and Take
 *   controls send at once, as before. The ship list caps at
 *   {@link ORDERS_MAX_ROWS} rows, then "+N more". Names only, never ids.
 * - Sends go through `fleet/fleetCommands.ts` (`resolveFleetCommands`, overridable per instance via `commands`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FLEET_STATUS_MODES, FLEET_STATUS_STANCES, type FleetMode, type FleetStance,
} from '@shared-types/messages/fleetStatusMessages';
import {
  EQX_PANEL_SIZE, EqxButton, EqxListRow, EqxPanel, EqxSection, EqxSegmented, type EqxPanelApply,
} from '../../ui/index.js';
import { useUIStore } from '../state/store.js';
import { helmOrdersAllowed } from '../helm/helmModeGate.js';
import { MODE_LABELS, STANCE_LABELS, describeShieldHull } from '../fleet/fleetView.js';
import type { FleetCommands } from '../fleet/fleetCommands.js';
import { resolveFleetCommands, useFleetSelectionView, type FleetSelectionView } from '../fleet/useFleetSelectionView.js';
import {
  SPEED_LABELS, applyOrders, changedOrders, chooseSpeed, type OrdersApplied, type OrdersDraft, type SpeedStep,
} from './ordersDraft.js';

/** Ship rows shown before the "+N more" line. */
export const ORDERS_MAX_ROWS = 8;

const MODE_OPTIONS = FLEET_STATUS_MODES.map((m) => ({ id: m, label: MODE_LABELS[m] }));
const STANCE_OPTIONS = FLEET_STATUS_STANCES.map((s) => ({ id: s, label: STANCE_LABELS[s] }));
const SPEED_OPTIONS = SPEED_LABELS.map((label, i) => ({ id: String(i), label }));
const NONE = '';
const EMPTY_DRAFT: OrdersDraft = {};

/** A single shared value, or null for mixed / not yet reported. */
function known<T extends string>(v: T | 'mixed' | null): T | null {
  return v === null || v === 'mixed' ? null : v;
}

const heading = (title: string, v: string | null): string => (v === 'mixed' ? `${title} · mixed` : title);

interface Props {
  /** Override some commands (tests, hosts); the rest come from `fleetCommands()`. */
  commands?: Partial<FleetCommands>;
}

export function OrdersPanel({ commands }: Props = {}): JSX.Element {
  const open = useUIStore((s) => s.rightPanel === 'orders');
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const setPick = useUIStore((s) => s.setFleetPick);
  const commandSpeed = useUIStore((s) => s.commandSpeed) as SpeedStep;
  const speedShown = useUIStore(helmOrdersAllowed); // Command only, never Fly or Build
  const view = useFleetSelectionView();
  const { ids } = view;
  const [draft, setDraft] = useState<OrdersDraft>(EMPTY_DRAFT);
  // A new selection, or closing the panel, drops the unapplied picks.
  useEffect(() => setDraft(EMPTY_DRAFT), [ids, open]);

  const applied: OrdersApplied = useMemo(
    () => ({ mode: known(view.mode), stance: known(view.stance), speed: commandSpeed }),
    [view.mode, view.stance, commandSpeed],
  );
  const changed = changedOrders(draft, applied, speedShown);
  const dirty = Object.keys(changed).length > 0;
  const onClose = useCallback(() => setRightPanel(null), [setRightPanel]);

  const apply: EqxPanelApply | undefined = view.active ? {
    dirty,
    onApply: () => {
      applyOrders(ids, changed, { commands: resolveFleetCommands(commands), setPick, setSpeed: chooseSpeed });
      setDraft(EMPTY_DRAFT);
      setRightPanel(null); // plan A4: after Apply the panel folds away (a map pick has closed it already)
    },
    secondary: { label: 'Stop', onClick: () => resolveFleetCommands(commands).stop(ids), testId: 'fleet-stop' },
  } : undefined;

  const n = ids.length;
  const title = !view.active ? 'Orders' : n === 1 ? '1 ship selected' : `${n} ships selected`;
  const paperAttrs = useMemo(() => ({ 'data-testid': 'orders-panel', 'data-fleet-count': String(view.active ? n : 0) }), [view.active, n]);

  return (
    <EqxPanel open={open} onClose={onClose} testId="orders-panel-root" paperAttrs={paperAttrs}
      closeTestId="orders-panel-close" title={title} size={EQX_PANEL_SIZE} closeOnEscape {...(apply ? { apply } : {})}>
      {open && view.active && (
        <OrdersBody view={view} draft={draft} applied={applied} speedShown={speedShown} setDraft={setDraft} commands={commands} />
      )}
    </EqxPanel>
  );
}

interface BodyProps {
  view: FleetSelectionView;
  draft: OrdersDraft;
  applied: OrdersApplied;
  speedShown: boolean;
  setDraft: (d: OrdersDraft) => void;
  commands: Partial<FleetCommands> | undefined;
}

function OrdersBody({ view, draft, applied, speedShown, setDraft, commands }: BodyProps): JSX.Element {
  const { ids } = view;
  const n = ids.length;
  const squad = view.squadId;
  const shown = view.ships.slice(0, ORDERS_MAX_ROWS);
  const more = n - shown.length;
  const speed = draft.speed ?? applied.speed;
  return (
    <>
      <EqxSection title={heading('Order', view.mode)} data-testid="fleet-mode-section">
        <EqxSegmented label="Order" options={MODE_OPTIONS} data-testid="fleet-mode"
          value={draft.mode ?? applied.mode ?? NONE} appliedValue={applied.mode ?? NONE}
          onChange={(m) => setDraft({ ...draft, mode: m as FleetMode })} />
      </EqxSection>
      <EqxSection title={heading('Stance', view.stance)} data-testid="fleet-stance-section">
        <EqxSegmented label="Stance" options={STANCE_OPTIONS} data-testid="fleet-stance"
          value={draft.stance ?? applied.stance ?? NONE} appliedValue={applied.stance ?? NONE}
          onChange={(s) => setDraft({ ...draft, stance: s as FleetStance })} />
      </EqxSection>
      {speedShown && (
        <EqxSection title="Speed">
          <EqxSegmented label="Speed" options={SPEED_OPTIONS} data-testid="helm-speed"
            value={String(speed)} appliedValue={String(applied.speed)}
            onChange={(v) => setDraft({ ...draft, speed: Number(v) as SpeedStep })} />
        </EqxSection>
      )}
      <EqxSection title="Squad">
        <EqxButton size="small" disabled={n < 2} data-testid="fleet-form-squad"
          onClick={() => resolveFleetCommands(commands).formSquad(ids)}>Form squad</EqxButton>
        {squad !== null && (
          <EqxButton size="small" disabled={squad === 'mixed'} data-testid="fleet-disband-squad"
            onClick={() => { if (squad !== 'mixed') resolveFleetCommands(commands).disbandSquad(squad); }}>Disband squad</EqxButton>
        )}
        <EqxButton size="small" disabled={n !== 1} data-testid="fleet-take-controls"
          onClick={() => { if (n === 1) resolveFleetCommands(commands).takeControls(ids[0]!); }}>Take controls</EqxButton>
      </EqxSection>
      <EqxSection title="Ships" data-testid="fleet-ship-list">
        {shown.map((s) => (
          <EqxListRow key={s.id} primary={s.name} secondary={s.activity} side={describeShieldHull(s.shieldPct, s.hullPct)}
            dataAttrs={{ 'ship-id': s.id }} data-testid="fleet-ship-row" />
        ))}
        {more > 0 && <EqxListRow primary={`+${more} more`} dim data-testid="fleet-more" />}
      </EqxSection>
    </>
  );
}

import { Box } from '@mui/material';
import { useInspectorPhoneAttrs } from './inspectorSizes';
import { useSelectionPanelData, type PanelData } from './selectionPanelData';
// The body's three parts (identity, readout bars, inspector sections) live beside it.
import { EntityStatsHeader } from './EntityStatsHeader';
import { EntityStatsBars } from './EntityStatsBars';
import { EntityStatsActions } from './EntityStatsActions';

// The readout moved to selectionPanelData.ts (the left strip reads it too);
// re-exported so existing importers keep working.
export { panelDataEqual, type PanelData } from './selectionPanelData';

/**
 * The selection's details: the body of the Details panel (`panels/DetailsPanel.tsx`,
 * opened by ⚙ on the left strip; UI language plan U3-2). Name or building card,
 * readout bars and the inspector sections (owner services, bounty, blueprints,
 * unpack, lab, teleporters). The one-tap actions (Target, cargo, pod, Pilot) are
 * on the left strip (`layout/selectionStripItems.tsx`).
 *
 * Renders while an entity is focused (`selection.focusId`); its numbers come from
 * `useSelectionPanelData` (polled, commits only on change; invariant #2: only the
 * discrete id lives in Zustand). The data attributes are the e2e read-outs.
 */
export function EntityStatsPanel(): JSX.Element | null {
  const data = useSelectionPanelData();
  const phoneAttrs = useInspectorPhoneAttrs();
  if (data === null) return null;
  return <EntityStatsBody data={data} phoneAttrs={phoneAttrs} />;
}

function EntityStatsBody({ data, phoneAttrs }: { data: PanelData; phoneAttrs: Record<string, string> }): JSX.Element {
  const hasCharge = data.storedPowerMax !== undefined && data.storedPowerMax > 0;
  const chargePct = hasCharge ? ((data.storedPower ?? 0) / data.storedPowerMax!) * 100 : 0;
  return (
    <Box
      data-testid="entity-stats-panel"
      {...phoneAttrs}
      data-entity-name={data.name}
      data-hull-pct={Math.round(data.hpPct)}
      {...(data.buildPct !== undefined ? { 'data-build-pct': Math.round(data.buildPct * 100) } : {})}
      {...(data.powered !== undefined ? { 'data-powered': data.powered ? '1' : '0' } : {})}
      {...(data.netPower !== undefined ? { 'data-net-power': Math.round(data.netPower) } : {})}
      {...(data.selfPower !== undefined ? { 'data-self-power': Math.round(data.selfPower) } : {})}
      {...(hasCharge ? { 'data-charge-pct': Math.round(chargePct) } : {})}
      {...(data.owner !== undefined ? { 'data-structure-owner': data.owner } : {})}
      {...(data.level !== undefined && data.level > 1 ? { 'data-structure-level': data.level } : {})}
      {...(data.pending ? { 'data-stats-pending': '1' } : {})}
      {...(data.infoLine !== undefined ? { 'data-entity-info': data.infoLine } : {})}
      sx={ROOT_SX}
    >
      <EntityStatsHeader data={data} />
      <EntityStatsBars data={data} />
      <EntityStatsActions data={data} />
    </Box>
  );
}

// Inside the panel body: one column of rows, no frame of its own (the panel
// draws it).
const ROOT_SX = {
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'stretch',
  gap: '6px',
  fontFamily: 'system-ui, sans-serif',
};

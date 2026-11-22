/**
 * The Galaxy right panel (UI language plan A4, job U2-2a): one scrolling page
 * with small section headings, opened by the rail's Galaxy item
 * (`rightPanel = 'galaxy'`). It is the only place the in-system warp list
 * lives (the old drawer Galaxy tab and WarpPicker card are folded in here):
 *
 *  - **Sector:** where you are; "Open full map" toggles the galaxy map Window
 *    (`isGalaxyMapOpen`, drawn by App.tsx / `app/galaxyOverlay.ts`; M too).
 *    Opening it folds this panel away.
 *  - **Nearby / Far:** warp within this solar system (SOLAR_SECTORS with a
 *    current sector). A row warps to the pocket's warp target, like the card:
 *    its rim when the line is clear, else the near side of what is in the way;
 *    a pocket too close to warp to stays listed with the reason and does not
 *    open. `WarpStatusChip` then shows the held warp with a Cancel.
 *  - **Arrival:** where you land on a sector warp (`panels/galaxyArrival.tsx`).
 *
 * The map and warp rows are hidden mid-transit (an action that can't work is
 * hidden). The ship pose is read from the render mirror at 4 Hz only while the
 * panel is open (`usePolledShip`, the card's sanctioned low-cadence read).
 * In Command view there is no flown ship, so no pose and no warp rows: a fleet
 * warps by sector from the full map (`sendWarpHere`, `engage_transit.shipIds`).
 */
import { useCallback, useMemo, type CSSProperties } from 'react';
import { EQX_PANEL_SIZE, EqxListRow, EqxPanel, EqxSection } from '../../ui/index.js';
import { HUD } from '../hud/tokens.js';
import { useUIStore } from '../state/store';
import { getSector } from '../../core/galaxy/galaxy';
import { getGameClient } from '../net/clientSingleton';
import { SOLAR_SECTORS } from '../../shared-types/sectorBounds';
import { formatKm, warpStateLabel, type WarpDestination } from '../components/warpDestinations';
import { destinationsFrom, usePolledShip } from '../components/WarpPicker';
import { GalaxyArrivalSection } from './galaxyArrival';

const PAPER_ATTRS = { 'data-testid': 'galaxy-panel' } as const;
const BODY_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: HUD.panel.bodyGap, minWidth: 0 };
const EMPTY: readonly WarpDestination[] = [];
/** The panel's own reused destination list. */
const panelDests: WarpDestination[] = [];

/** A row's dim second line: the transit pad, then why it is short or refused. */
export function warpRowNote(d: WarpDestination): string | undefined {
  const pad = d.padTo ? `pad to ${d.padTo} (instant)` : null;
  const state = d.here ? null : warpStateLabel(d);
  if (pad && state) return `${pad} · ${state}`;
  return pad ?? state ?? undefined;
}

function WarpRow({ d, onWarp }: { d: WarpDestination; onWarp: (d: WarpDestination) => void }): JSX.Element {
  const canPick = !d.here && d.reachable;
  return (
    <EqxListRow primary={d.label} secondary={warpRowNote(d)} side={d.here ? 'here' : formatKm(d.distKm)}
      onOpen={canPick ? () => onWarp(d) : undefined} dataAttrs={{ 'warp-state': d.state, km: Math.round(d.distKm) }}
      data-testid={`galaxy-warp-${d.id}`} />
  );
}

/** Nearby / Far: the system's pockets, polled while the panel is open. */
function GalaxyWarpSections({ sectorKey, on }: { sectorKey: string; on: boolean }): JSX.Element | null {
  const { pose } = usePolledShip(on);
  const setHeldTo = useUIStore((s) => s.setWarpHeldTo);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const dests = useMemo(() => (pose ? destinationsFrom(sectorKey, pose, panelDests) : EMPTY), [sectorKey, pose]);
  const onWarp = useCallback((d: WarpDestination) => {
    if (d.here || !d.reachable) return;
    getGameClient()?.requestWarp(d.targetX, d.targetY);
    setHeldTo(d.label);
    setRightPanel(null);
  }, [setHeldTo, setRightPanel]);
  if (dests.length === 0) return null;
  const near = dests.filter((d) => !d.far);
  const far = dests.filter((d) => d.far);
  return (
    <>
      {near.length > 0 && (
        <EqxSection title="Nearby" data-testid="galaxy-nearby">
          {near.map((d) => <WarpRow key={d.id} d={d} onWarp={onWarp} />)}
        </EqxSection>
      )}
      {far.length > 0 && (
        <EqxSection title="Far" data-testid="galaxy-far">
          {far.map((d) => <WarpRow key={d.id} d={d} onWarp={onWarp} />)}
        </EqxSection>
      )}
    </>
  );
}

export function GalaxyPanel(): JSX.Element {
  const open = useUIStore((s) => s.rightPanel === 'galaxy');
  const transitState = useUIStore((s) => s.transitState);
  const currentSectorKey = useUIStore((s) => s.currentSectorKey);
  const mapOpen = useUIStore((s) => s.isGalaxyMapOpen);
  const toggleGalaxyMapOpen = useUIStore((s) => s.toggleGalaxyMapOpen);
  const setRightPanel = useUIStore((s) => s.setRightPanel);

  const inTransit = transitState !== 'DOCKED';
  const sector = currentSectorKey ? getSector(currentSectorKey) : null;
  const sectorName = sector?.name ?? currentSectorKey ?? 'Engineering room';
  const canWarp = SOLAR_SECTORS && currentSectorKey !== null && !inTransit;

  const onClose = useCallback(() => setRightPanel(null), [setRightPanel]);
  const onMap = useCallback(() => {
    const opening = !useUIStore.getState().isGalaxyMapOpen;
    toggleGalaxyMapOpen();
    // The map Window takes the screen: fold the panel away when it opens.
    if (opening) setRightPanel(null);
  }, [toggleGalaxyMapOpen, setRightPanel]);

  return (
    <EqxPanel
      open={open}
      onClose={onClose}
      // The test id goes on the Paper: the persistent Drawer root is a zero-size
      // docked div (the Paper is fixed), so e2e would never see it visible.
      testId="galaxy-panel-root"
      paperAttrs={PAPER_ATTRS}
      closeTestId="galaxy-panel-close"
      title="Galaxy"
      size={EQX_PANEL_SIZE}
      closeOnEscape
    >
      <div style={BODY_STYLE} data-testid="galaxy-panel-body">
        <EqxSection title="Sector" data-testid="galaxy-sector">
          <EqxListRow primary={sectorName} secondary={inTransit ? 'Transit in progress: the map is read-only.' : undefined}
            data-testid="galaxy-sector-name" />
          {!inTransit && (
            <EqxListRow primary={mapOpen ? 'Close full map' : 'Open full map'}
              secondary="Tap a sector for its breakdown, your ships, and to warp or join. (Or press M.)"
              onOpen={onMap} data-testid="galaxy-open-map" />
          )}
        </EqxSection>
        {canWarp && currentSectorKey !== null && <GalaxyWarpSections sectorKey={currentSectorKey} on={open} />}
        <GalaxyArrivalSection shown={open} inTransit={inTransit} />
      </div>
    </EqxPanel>
  );
}

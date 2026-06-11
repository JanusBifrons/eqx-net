import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { useUIStore } from '../state/store';
import { selectionStats } from '../net/selectionStats';
import { toSelectWire } from '../net/selectionClient';
import { getGameClient } from '../net/clientSingleton';
import { hullColor } from './ShieldHullBar';
import type { PickedEntityKind } from '../render/pickEntity';
import type { StructureRenderState } from '@core/contracts/IRenderer';

/**
 * Click-to-inspect live stats panel (structures follow-up Item B6).
 *
 * Visible only while an entity is selected (`selectedEntityId` in Zustand — the
 * discrete, purity-clean selection id). Tiny, anchored via the Slot system
 * (App mounts it in a `<Slot>`, like `ShieldHullBar`). Shows the entity name +
 * a hull bar (+ a shield bar for ships).
 *
 * Number source by kind:
 *   - SHIP / STRUCTURE → the `selectionStats` MODULE SINGLETON, pushed by the
 *     server at ~5 Hz and POLLED here at ~1 Hz (no 5 Hz React re-renders;
 *     invariant #2 — only the discrete id lives in Zustand).
 *   - DRONE / WRECK → read directly from the render mirror (sanctioned
 *     low-cadence `getGameClient().mirror` read, like `SectorInfoPanel`): the
 *     snapshot already carries drone `healthFrac` + wreck `health`, so no server
 *     stats channel is used.
 */
const POLL_MS = 1000;

interface PanelData {
  name: string;
  hpPct: number;
  shieldPct: number | null;
  /** Structure-only extras (playtest 2026-06-10 Issue 8). Undefined otherwise. */
  buildPct?: number; // [0..1]; < 1 ⇒ under construction
  powered?: boolean;
  netPower?: number;
  /** Battery-only — stored power + capacity (batteries plan). */
  storedPower?: number;
  storedPowerMax?: number;
}

export function EntityStatsPanel(): JSX.Element | null {
  const selectedId = useUIStore((s) => s.selectedEntityId);
  const selectedKind = useUIStore((s) => s.selectedEntityKind);
  const [data, setData] = useState<PanelData | null>(null);

  useEffect(() => {
    if (selectedId === null) {
      setData(null);
      return;
    }
    const tick = (): void => setData(readData(selectedId, selectedKind));
    tick();
    const handle = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(handle);
  }, [selectedId, selectedKind]);

  if (selectedId === null || data === null) return null;

  const building = data.buildPct !== undefined && data.buildPct < 1;
  const hasCharge = data.storedPowerMax !== undefined && data.storedPowerMax > 0;
  const chargePct = hasCharge ? ((data.storedPower ?? 0) / data.storedPowerMax!) * 100 : 0;
  return (
    <Box
      data-testid="entity-stats-panel"
      data-entity-name={data.name}
      data-hull-pct={Math.round(data.hpPct)}
      {...(data.buildPct !== undefined ? { 'data-build-pct': Math.round(data.buildPct * 100) } : {})}
      {...(data.powered !== undefined ? { 'data-powered': data.powered ? '1' : '0' } : {})}
      {...(data.netPower !== undefined ? { 'data-net-power': Math.round(data.netPower) } : {})}
      {...(hasCharge ? { 'data-charge-pct': Math.round(chargePct) } : {})}
      sx={ROOT_SX}
    >
      <Box sx={NAME_SX} data-testid="entity-stats-name">{data.name}</Box>
      {data.shieldPct !== null && (
        <>
          <Cap>SHLD</Cap>
          <Bar pct={data.shieldPct} color={SHIELD_COLOR} />
        </>
      )}
      <Cap>HULL</Cap>
      <Bar pct={data.hpPct} color={hullColor(data.hpPct)} />
      {building && (
        <>
          <Cap>BUILD</Cap>
          <Bar pct={(data.buildPct ?? 0) * 100} color={BUILD_COLOR} />
        </>
      )}
      {hasCharge && (
        <>
          <Cap>CHRG</Cap>
          <Bar pct={chargePct} color={CHARGE_COLOR} />
        </>
      )}
      {data.powered !== undefined && (
        <Box sx={POWER_SX} data-testid="entity-stats-power">
          {data.powered ? `PWR ${(data.netPower ?? 0) >= 0 ? '+' : ''}${Math.round(data.netPower ?? 0)}` : 'UNPOWERED'}
        </Box>
      )}
    </Box>
  );
}

/** Resolve the display data for the current selection (pure-ish read). */
function readData(id: string, kind: PickedEntityKind | null): PanelData | null {
  if (kind === 'ship' || kind === 'structure') {
    // Only trust stats that are FOR this selection (the singleton may briefly
    // hold the prior entity's numbers between a re-select and the next packet).
    // Compare against the WIRE id, not the Zustand selection id: a structure is
    // selected as `swarm-<entityId>` (mirror form) but the server echoes the
    // STRIPPED numeric id, so the raw comparison never matched for structures —
    // the "building health doesn't work when selected" bug (playtest 2026-06-10
    // Issue 3). `toSelectWire` is the single id-mapping site (ships pass through
    // unchanged, so ships were always fine).
    const wireId = toSelectWire(id, kind)?.id ?? id;
    if (selectionStats.id !== wireId) {
      return { name: kind === 'structure' ? 'Structure' : 'Ship', hpPct: 0, shieldPct: kind === 'ship' ? 0 : null };
    }
    const hpPct = selectionStats.hpMax > 0 ? (selectionStats.hp / selectionStats.hpMax) * 100 : 0;
    const shieldPct =
      selectionStats.shield !== undefined && selectionStats.shieldMax !== undefined && selectionStats.shieldMax > 0
        ? (selectionStats.shield / selectionStats.shieldMax) * 100
        : null;
    const base: PanelData = {
      name: selectionStats.name || (kind === 'structure' ? 'Structure' : 'Ship'),
      hpPct,
      shieldPct,
    };
    if (kind === 'structure') {
      // Richer stats (Issue 8): merge the grid slice for this structure — build
      // %, powered, net power. Keyed by the numeric entityId in `mirror.structures`.
      const st = structureSliceFor(id);
      if (st) {
        base.buildPct = st.buildPct;
        base.powered = st.powered;
        base.netPower = st.netPower;
        base.storedPower = st.storedPower;
        base.storedPowerMax = st.storedPowerMax;
      }
    }
    return base;
  }

  // drone / wreck — read the render mirror directly.
  const client = getGameClient();
  if (!client) return null;
  if (kind === 'drone' && id.startsWith('swarm-')) {
    const swarmId = parseInt(id.slice('swarm-'.length), 10);
    const sw = Number.isNaN(swarmId) ? undefined : client.mirror.swarm?.get(swarmId);
    if (!sw) return null;
    const frac = sw.healthFrac ?? 1;
    return { name: droneName(sw.shipKind), hpPct: frac * 100, shieldPct: null };
  }
  if (kind === 'wreck') {
    const w = client.mirror.wrecks?.get(id);
    if (!w) return null;
    const hpPct = w.maxHealth > 0 ? (w.health / w.maxHealth) * 100 : 0;
    return { name: 'Wreck', hpPct, shieldPct: null };
  }
  return null;
}

function droneName(shipKind: string | undefined): string {
  if (!shipKind) return 'Drone';
  // The name is cosmetic; a capitalised kind id reads fine.
  return `${shipKind.charAt(0).toUpperCase()}${shipKind.slice(1)} drone`;
}

/** The grid slice entry for a selected structure, keyed by the numeric entityId
 *  (`mirror.structures` uses the bare entityId; the selection id is the mirror
 *  form `swarm-<entityId>`). Returns undefined if absent. */
function structureSliceFor(id: string): StructureRenderState | undefined {
  const client = getGameClient();
  if (!client) return undefined;
  const entityId = parseInt(id.startsWith('swarm-') ? id.slice('swarm-'.length) : id, 10);
  if (Number.isNaN(entityId)) return undefined;
  return client.mirror.structures?.get(entityId);
}

const SHIELD_COLOR = '#36c8ff';
const BUILD_COLOR = '#ffc24d';
const CHARGE_COLOR = '#cc8844';
const TRACK_W = 72;
const BAR_H = 4;

function Bar({ pct, color }: { pct: number; color: string }): JSX.Element {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <Box sx={BAR_TRACK_SX}>
      <Box sx={{ width: `${clamped}%`, height: '100%', backgroundColor: color, transition: 'width 1000ms linear' }} />
    </Box>
  );
}

function Cap({ children }: { children: string }): JSX.Element {
  return <Box component="span" sx={CAP_SX}>{children}</Box>;
}

const ROOT_SX = {
  display: 'grid',
  gridTemplateColumns: 'auto auto',
  alignItems: 'center',
  columnGap: 0.75,
  rowGap: '3px',
  p: 0.5,
  borderRadius: 1,
  bgcolor: 'rgba(5,7,15,0.7)',
  border: '1px solid rgba(120,200,255,0.25)',
  pointerEvents: 'none' as const,
  userSelect: 'none' as const,
  fontFamily: 'system-ui, sans-serif',
};
const NAME_SX = {
  gridColumn: '1 / -1',
  fontSize: 10,
  fontWeight: 700,
  color: '#cde',
  letterSpacing: 0.3,
  whiteSpace: 'nowrap' as const,
};
const BAR_TRACK_SX = {
  width: TRACK_W,
  height: BAR_H,
  borderRadius: '2px',
  backgroundColor: 'rgba(255,255,255,0.12)',
  overflow: 'hidden' as const,
};
const CAP_SX = {
  fontSize: 8,
  letterSpacing: 0.5,
  color: 'rgba(255,255,255,0.45)',
  textTransform: 'uppercase' as const,
};
const POWER_SX = {
  gridColumn: '1 / -1',
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: 0.4,
  color: 'rgba(180,220,255,0.85)',
  textTransform: 'uppercase' as const,
};

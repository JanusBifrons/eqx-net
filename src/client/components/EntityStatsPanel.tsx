import { useEffect, useState } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { useUIStore } from '../state/store';
import { selectionStats } from '../net/selectionStats';
import { toSelectWire } from '../net/selectionClient';
import { getGameClient } from '../net/clientSingleton';
import { hullColor } from './ShieldHullBar';
import { getStructureKind } from '@shared-types/structureKinds';
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
// WS-9/R2.8 — was 1000 ms ("stats pop in after a second"); 150 ms makes the
// worst-case re-read ~150 ms behind the 200 ms server push. The client-resident
// data (structure slice, asteroid/lingering) shows INSTANTLY on selection
// regardless of the poll; only the server-only hp/shield wait a packet.
const POLL_MS = 150;

interface PanelData {
  name: string;
  hpPct: number;
  shieldPct: number | null;
  /** WS-9/R2.8 — hp/shield are awaiting the FIRST server `entity_stats` packet;
   *  show a spinner for those bars (the rest renders instantly). */
  pending?: boolean;
  /** WS-9/R2.23 — asteroid/lingering have no hull bar; show `infoLine` instead. */
  noHull?: boolean;
  /** Asteroid size/resources OR lingering-hull owner readout. */
  infoLine?: string;
  /** Structure-only extras (playtest 2026-06-10 Issue 8). Undefined otherwise. */
  buildPct?: number; // [0..1]; < 1 ⇒ under construction
  powered?: boolean;
  /** Component (whole-grid) net power — kept on the `data-net-power` attr.
   *  NOT the visible PWR line (that's `selfPower`, per Phase-4 C5). */
  netPower?: number;
  /** Phase-4 C5 — this BUILDING's own power figure (catalogue
   *  `powerOutput − powerConsumption`): +gen for a solar/capital, −drain for a
   *  turret/miner/pylon, 0 for a passive node. Shown on the PWR line so each
   *  building reads its OWN draw, not the shared grid aggregate. */
  selfPower?: number;
  /** Battery-only — stored power + capacity (batteries plan). */
  storedPower?: number;
  storedPowerMax?: number;
  /** Connector-only (Phase-4 C4) — current vs max grid connections ("N / 6").
   *  Set ONLY for a selected CONNECTOR; absent for every other structure/entity
   *  (the user: "It shouldn't really apply to other structures"). */
  connCount?: number;
  connMax?: number;
  /** Owning playerId in display form ("you" for the local player, else a
   *  truncated id) — set for structures so players can identify whose base it is
   *  (other players' bases are a core part of the game, not a bug). */
  owner?: string;
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
      {...(data.selfPower !== undefined ? { 'data-self-power': Math.round(data.selfPower) } : {})}
      {...(hasCharge ? { 'data-charge-pct': Math.round(chargePct) } : {})}
      {...(data.connCount !== undefined ? { 'data-conn-count': data.connCount } : {})}
      {...(data.owner !== undefined ? { 'data-structure-owner': data.owner } : {})}
      {...(data.pending ? { 'data-stats-pending': '1' } : {})}
      {...(data.infoLine !== undefined ? { 'data-entity-info': data.infoLine } : {})}
      sx={ROOT_SX}
    >
      <Box sx={NAME_SX} data-testid="entity-stats-name">{data.name}</Box>
      {data.noHull ? (
        // R2.23 — asteroid (size/resources) or lingering hull (owner): no bars.
        <Box sx={INFO_SX} data-testid="entity-stats-info">{data.infoLine}</Box>
      ) : data.pending ? (
        // R2.8 — hp/shield awaiting the first server packet: a spinner, not a 0-bar.
        <Box sx={PENDING_SX} data-testid="entity-stats-spinner">
          <CircularProgress size={12} thickness={6} sx={SPINNER_SX} />
        </Box>
      ) : (
        <>
          {data.shieldPct !== null && (
            <>
              <Cap>SHLD</Cap>
              <Bar pct={data.shieldPct} color={SHIELD_COLOR} />
            </>
          )}
          <Cap>HULL</Cap>
          <Bar pct={data.hpPct} color={hullColor(data.hpPct)} />
        </>
      )}
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
        // C5 — the PWR line is this BUILDING's own gen/drain (`selfPower`), not
        // the grid aggregate. UNPOWERED (grid-unreachable) is orthogonal + kept.
        <Box sx={POWER_SX} data-testid="entity-stats-power">
          {data.powered ? `PWR ${(data.selfPower ?? 0) >= 0 ? '+' : ''}${Math.round(data.selfPower ?? 0)}` : 'UNPOWERED'}
        </Box>
      )}
      {data.connCount !== undefined && (
        // C4 — connector-only connection count. Same muted POWER_SX styling.
        <Box sx={POWER_SX} data-testid="entity-stats-conn">
          {`CONN ${data.connCount} / ${data.connMax ?? 0}`}
        </Box>
      )}
      {data.owner !== undefined && (
        // Owner readout — identifies whose base this is ("you" vs a truncated id).
        <Box sx={POWER_SX} data-testid="entity-stats-owner">
          {`OWNER ${data.owner}`}
        </Box>
      )}
    </Box>
  );
}

/** Resolve the display data for the current selection (pure-ish read). */
function readData(id: string, kind: PickedEntityKind | null): PanelData | null {
  // The id-match guard: the singleton may briefly hold the PRIOR entity's
  // numbers between a re-select and the next packet. Compare against the WIRE id
  // (`toSelectWire`) — a structure is selected as `swarm-<id>` but the server
  // echoes the stripped numeric id (the 2026-06-10 Issue 3 bug). `haveStats`
  // gates ONLY the server-only hp/shield; everything client-resident is instant.
  const haveStats = (k: PickedEntityKind): boolean =>
    selectionStats.id === (toSelectWire(id, k)?.id ?? id);

  // STRUCTURE (R2.8 instant) — the grid slice (build %, power, charge) is
  // client-resident and renders IMMEDIATELY; only hull awaits the server packet.
  if (kind === 'structure') {
    const got = haveStats('structure');
    const st = structureSliceFor(id);
    // C3 — hull from the CLIENT-RESIDENT slice first (instant, no round-trip);
    // the server entity_stats packet only refines it. The spinner shows ONLY when
    // neither the slice nor a server packet has hull yet (was: spinner until the
    // packet ALWAYS → the "hull pops in" lag).
    const sliceHull = st?.hpPct; // [0..1] or undefined
    const data: PanelData = {
      name: (got && selectionStats.name) || structureName(id) || 'Structure',
      hpPct:
        sliceHull !== undefined
          ? sliceHull * 100
          : got && selectionStats.hpMax > 0
            ? (selectionStats.hp / selectionStats.hpMax) * 100
            : 0,
      shieldPct: null, // structures are shieldless
      pending: sliceHull === undefined && !got, // spinner only if NEITHER source has hull
    };
    if (st) {
      data.buildPct = st.buildPct;
      data.powered = st.powered;
      data.netPower = st.netPower;
      data.storedPower = st.storedPower;
      data.storedPowerMax = st.storedPowerMax;
      const subtype = structureSubtype(id);
      // C5 — the building's OWN power figure (catalogue gen − drain), so each
      // structure reads its own +/- rather than the grid aggregate every member
      // shares. Pure catalogue lookup → instant, no server round-trip.
      if (subtype) {
        const k = getStructureKind(subtype);
        data.selfPower = k.powerOutput - k.powerConsumption;
      }
      // C4 — connection count "N / 6", CONNECTORS ONLY. Client-resident (slice
      // connTo.length + catalogue maxConnections), so it renders instantly with
      // no server round-trip; never surfaced for other kinds.
      if (subtype === 'connector') {
        data.connCount = st.connTo.length;
        data.connMax = getStructureKind('connector').maxConnections;
      }
      // Owner readout — the player's DISPLAY NAME so you can identify whose base
      // it is ("you" for the local player). An absent ownerName means the owner
      // didn't resolve to a DB user — an orphaned structure (the server logs it)
      // → "Unknown". NEVER a raw playerId.
      if (st.owner) {
        const localId = getGameClient()?.mirror.localPlayerId ?? null;
        data.owner = st.owner === localId ? 'you' : (st.ownerName ?? 'Unknown');
      }
    }
    return data;
  }

  // SHIP — hp/shield are SERVER-only; spinner until the first packet (R2.8).
  if (kind === 'ship') {
    if (!haveStats('ship')) return { name: selectionStats.name || 'Ship', hpPct: 0, shieldPct: 0, pending: true };
    const hpPct = selectionStats.hpMax > 0 ? (selectionStats.hp / selectionStats.hpMax) * 100 : 0;
    const shieldPct =
      selectionStats.shield !== undefined && selectionStats.shieldMax !== undefined && selectionStats.shieldMax > 0
        ? (selectionStats.shield / selectionStats.shieldMax) * 100
        : null;
    return { name: selectionStats.name || 'Ship', hpPct, shieldPct };
  }

  // The rest read the render mirror directly (no server stats channel).
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
  // ASTEROID (R2.23) — indestructible rock: no hull bar; show resources when the
  // rock is being mined, else a SIZE proxy from radius (untouched rocks carry no
  // resources/mass on the wire — real mass is a future server-touching change).
  if (kind === 'asteroid' && id.startsWith('swarm-')) {
    const swarmId = parseInt(id.slice('swarm-'.length), 10);
    const sw = Number.isNaN(swarmId) ? undefined : client.mirror.swarm?.get(swarmId);
    if (!sw) return null;
    const hasRes = sw.resourcesMax !== undefined && sw.resourcesMax > 0;
    return {
      name: 'Asteroid',
      hpPct: 0,
      shieldPct: null,
      noHull: true,
      infoLine: hasRes
        ? `RES ${Math.round(sw.resources ?? 0)} / ${Math.round(sw.resourcesMax!)}`
        : `SIZE ${Math.round(sw.radius)}`,
    };
  }
  // LINGERING HULL (R2.23) — show WHOSE displaced hull it is (no live hp on the mirror).
  if (kind === 'lingering') {
    const l = client.mirror.lingeringShips?.get(id);
    if (!l) return null;
    const owner = l.ownerPlayerId.length > 10 ? `${l.ownerPlayerId.slice(0, 8)}…` : l.ownerPlayerId;
    return {
      name: l.displayName || 'Abandoned hull',
      hpPct: 0,
      shieldPct: null,
      noHull: true,
      infoLine: `${l.kind ?? 'ship'} · ${owner}`,
    };
  }
  return null;
}

/** A structure's catalogue display name (INSTANT — from the swarm mirror's
 *  subtype byte), so the panel names it before the first server packet. */
function structureName(id: string): string | undefined {
  const client = getGameClient();
  if (!client) return undefined;
  const entityId = parseInt(id.startsWith('swarm-') ? id.slice('swarm-'.length) : id, 10);
  if (Number.isNaN(entityId)) return undefined;
  const sw = client.mirror.swarm?.get(entityId);
  return sw?.shipKind ? getStructureKind(sw.shipKind).displayName : undefined;
}

/** A structure's raw subtype id (the swarm `shipKind` byte) — used to gate the
 *  connector-only connection count (C4). Undefined when the swarm entry is gone. */
function structureSubtype(id: string): string | undefined {
  const client = getGameClient();
  if (!client) return undefined;
  const entityId = parseInt(id.startsWith('swarm-') ? id.slice('swarm-'.length) : id, 10);
  if (Number.isNaN(entityId)) return undefined;
  return client.mirror.swarm?.get(entityId)?.shipKind;
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
  // WS-9 (R2.30) — world-anchored: position:fixed, moved to the selected entity's
  // projected screen point by gameRafLoop each frame. The translate anchors the
  // box's bottom-centre at that point so it floats just above the entity. Starts
  // off-screen until the first frame positions it (avoids a top-left flash).
  position: 'fixed' as const,
  left: 0,
  top: -9999,
  transform: 'translate(-50%, -100%)',
  zIndex: 1400,
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
const INFO_SX = {
  gridColumn: '1 / -1',
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: 0.3,
  color: 'rgba(200,225,255,0.9)',
  whiteSpace: 'nowrap' as const,
};
const PENDING_SX = {
  gridColumn: '1 / -1',
  display: 'flex',
  justifyContent: 'center',
  py: '2px',
};
const SPINNER_SX = { color: 'rgba(180,220,255,0.8)' };

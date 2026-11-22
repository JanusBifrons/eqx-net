/**
 * The selection's live readout (moved out of EntityStatsPanel.tsx for the left
 * strip, UI language plan U3-1/U3-2): one polled `PanelData` read for the
 * focused entity, shared by the left strip (identity health ring and quick
 * actions) and the Details panel (bars and inspector sections).
 */
import { useEffect, useState } from 'react';
import { useUIStore } from '../state/store';
import { selectionStats } from '../net/selectionStats';
import { toSelectWire } from '../net/selectionClient';
import { isOwnedByMe, isParkedHull } from '../render/shipOwnership';
import { getGameClient } from '../net/clientSingleton';
import { decodeGood, isProcessorKind, prodStatusLine, type ProdState } from '@shared-types/production';
import type { RecipeId } from '@shared-types/recipes';
import { makesThings, readProduction } from './structureSettingsProduction';
import { gateTypeOf } from '@core/structures/gateGeometry';
import { gateAccessFromIndex, type GateAccess } from '@shared-types/gateAccess';
import { asteroidPanelRow, podPanelRow } from './swarmTerrainInfo';
import { isAlienGateKind, isTeleporterKind } from '../../shared-types/teleport';
import { alienGateLine } from './alienGateInfo';
import { getStructureKind } from '@shared-types/structureKinds';
import { structureGunLines } from './structureGunLines';
import { hasPowerSwitch, structureSelfPower } from './structureSettingsPower';
import type { PickedEntityKind } from '../render/pickEntity';
import { droneName, parkedHullLabels, parseEntityId, structureName, structureSliceFor, structureSubtype } from './entityStatsLookups';
import { buildStalledLine, isBuildAwaitingClear } from '../structures/buildAwaitingClear';
import { structureOwnerLabel } from './structureSettingsStatus';
import { focusStance, type ContactStance } from './contactRows';

/**
 * Number source by kind:
 *   - SHIP / STRUCTURE → the `selectionStats` MODULE SINGLETON, pushed by the
 *     server at ~5 Hz and POLLED here every `POLL_MS` (150 ms ≈ 6.7 Hz — the
 *     poll only COMMITS a re-render when the data actually changed, see
 *     `panelDataEqual`; invariant #2 — only the discrete id lives in Zustand).
 *   - DRONE → read directly from the render mirror (sanctioned
 *     low-cadence `getGameClient().mirror` read, like `SectorInfoPanel`): the
 *     snapshot already carries drone `healthFrac`, so no server
 *     stats channel is used.
 */
// WS-9/R2.8 — was 1000 ms ("stats pop in after a second"); 150 ms makes the
// worst-case re-read ~150 ms behind the 200 ms server push. The client-resident
// data (structure slice, asteroid/lingering) shows INSTANTLY on selection
// regardless of the poll; only the server-only hp/shield wait a packet.
const POLL_MS = 150;

export interface PanelData {
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
  /** Build done but still a blueprint: a ship inside its footprint (`buildAwaitingClear.ts`). */
  buildBlocked?: boolean;
  /** Why a paused build is paused (`buildStalledLine`): dry bank or not connected. */
  buildStalled?: string;
  powered?: boolean;
  /** Built (not a blueprint): an unbuilt one is off the grid, so never UNPOWERED. */
  built?: boolean;
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
  /** The owner switched it Off (power icon grey). */
  switchedOff?: boolean;
  /** My own building of a kind its owner may switch On/Off (`hasPowerSwitch`): the strip's Power fly-out. */
  powerSwitch?: boolean;
  /** Owner in display form ("you", their name or "Unknown"; never a raw id) —
   *  so players can identify whose base it is. */
  owner?: string;
  /** Phase-1 issue 6 — the structure's numeric swarm entityId (for action
   *  sends) and whether the LOCAL player owns it (gates the action buttons). */
  entityId?: number;
  isOwn?: boolean;
  /** A structure: render the compact building card (structureCard.tsx). */
  isStructure?: boolean;
  /** Phase 4 WS-B4 — the structure's level (≥ 1), "Lv N" on the card. */
  level?: number;
  /** Gates — who it opens for (an access id). Absent for non-gates. */
  gateAccess?: GateAccess;
  /** P2b — a processor's recipe, state and status line ("Running", "Waiting for Minerals", …). */
  recipe?: RecipeId;
  prodState?: number;
  prodStatus?: string;
  /** A building that makes things: the card's "making" slot and its cycle progress (0..100). */
  makes?: boolean;
  prodPct?: number;
  /** Coastal defences — per-gun-size reload + arc lines, newline-joined
   *  (`16" ×2 · reload 30 s · arc 144°`). Naval-mount structures only. */
  gunLine?: string;
  /** P2d — an ammo-using turret is out of munitions. */
  noAmmo?: boolean;
  /** D1 — a Reactor has no fuel. */
  noFuel?: boolean;
  /** C2 — someone is breaking into its cargo. */
  breach?: boolean;
  /** Phase 4 WS-A2 — set for an OWNED in-sector lingering hull (the local
   *  player's own parked ship). Drives the in-world "Pilot" action; the value is
   *  the shipInstanceId to `pilot_ship`. Absent for another player's hull / a
   *  hull the local player can't reclaim. */
  pilotShipId?: string;
  /** Living World P1a-2 — an OWNED storage structure's contents line (gates
   *  Repair; the line itself shows in the settings panel's status block), and
   *  whether Refine (salvage → minerals, Capital only) is available. */
  holdLine?: string;
  canRefine?: boolean;
  /** Economy v2 W3 — my own BUILT Research Lab: show the lab panel. */
  isLab?: boolean;
  /** v4 T1 — the pilot's own built teleporter. */
  isTeleporter?: boolean;
  /** v4 T4 — someone else's built teleporter (ask to pair). */
  isForeignTeleporter?: boolean;
  /** v4 A — an alien gate: where it leads and when it next jumps. */
  alienGateLine?: string;
  /** C1 — a BUILT storage structure (anyone's) or (C3) an NPC ship: offer
   *  "Open cargo" by `entityId`. The server decides whether it opens. */
  hasCargo?: boolean;
  /** C3 — another player's ship (playerId) or a parked hull (shipInstanceId):
   *  offer "Open cargo" (yours opens; anyone else's needs a break-in). */
  cargoShip?: string;
  /** Living World P4c-2 — a selected REMOTE player ship: its playerId, the
   *  target of the Bounty action (never displayed). */
  bountyTarget?: string;
  /** Living World P5 — an OWNED storage's blueprint ids, comma-joined (the
   *  Install actions). Empty / absent when it holds none. */
  blueprints?: string;
  /** Economy v2 W5a — an OWNED storage's packed product ids, comma-joined
   *  (the Unpack-hull chips). Absent when it holds none. */
  packed?: string;
  /** Cargo pods 16 — a selected pod: is my ship within the open reach?
   *  (the same `withinLootOpenReach` the server gates on). */
  podOpen?: boolean;
  /** Its stance to you (`focusStance`, the contacts table's rule); absent for a rock / pod. */
  stance?: ContactStance;
}

// Every PanelData field is a primitive, so a keyed shallow compare is an exact
// equality check. Listed explicitly (not Object.keys) so a future non-primitive
// field forces a deliberate decision here instead of silently mis-comparing.
const PANEL_DATA_KEYS: ReadonlyArray<keyof PanelData> = [
  'name', 'hpPct', 'shieldPct', 'pending', 'noHull', 'infoLine', 'buildPct', 'buildBlocked', 'buildStalled', 'powered', 'built',
  'netPower', 'selfPower', 'storedPower', 'storedPowerMax', 'switchedOff', 'powerSwitch', 'owner',
  'entityId', 'isOwn', 'isStructure', 'level', 'pilotShipId',
  'holdLine', 'canRefine', 'gateAccess', 'bountyTarget', 'blueprints',
  'recipe', 'prodState', 'prodStatus', 'makes', 'prodPct', 'gunLine', 'noAmmo', 'noFuel', 'breach',
  'isLab', 'hasCargo', 'cargoShip', 'packed', 'isTeleporter', 'isForeignTeleporter', 'alienGateLine', 'podOpen', 'stance',
];

/** True when two polled PanelData reads carry identical values (Wave-3 3.3 —
 *  gates the poll's setState so unchanged data never commits a re-render). */
export function panelDataEqual(a: PanelData, b: PanelData): boolean {
  for (const k of PANEL_DATA_KEYS) {
    if (a[k] !== b[k]) return false;
  }
  return true;
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
      data.isStructure = true;
      data.buildPct = st.buildPct;
      if (isBuildAwaitingClear(st)) data.buildBlocked = true;
      const stalled = buildStalledLine(st);
      if (stalled !== undefined) data.buildStalled = stalled;
      data.powered = st.powered;
      data.built = st.built;
      if (st.switchedOff === true) data.switchedOff = true;
      data.netPower = st.netPower;
      data.storedPower = st.storedPower;
      data.storedPowerMax = st.storedPowerMax;
      const subtype = structureSubtype(id);
      // C5 — the building's OWN power figure (catalogue gen − drain), so each
      // structure reads its own +/- rather than the grid aggregate every member
      // shares. Pure catalogue lookup → instant, no server round-trip.
      if (subtype) {
        const k = getStructureKind(subtype);
        // Active power — what it draws NOW (full while active, else idle).
        // Output is level-scaled like the server grid's (#15).
        data.selfPower = structureSelfPower(subtype, st);
        // Coastal defences — reload + firing arc per gun size (catalogue read).
        const guns = structureGunLines(k);
        if (guns.length > 0) data.gunLine = guns.join('\n');
      }
      // Owner readout — the player's DISPLAY NAME so you can identify whose base
      // it is ("you" for the local player; "Unknown" for an orphan). NEVER a raw playerId.
      if (st.owner) {
        const localId = getGameClient()?.mirror.localPlayerId ?? null;
        data.owner = structureOwnerLabel(st.owner, st.ownerName, localId);
        // Phase-1 issue 6 — action buttons are OWN-only.
        data.isOwn = st.owner === localId;
        // The strip's Power fly-out: my own building of a kind its owner may switch.
        if (data.isOwn && subtype && hasPowerSwitch(subtype)) data.powerSwitch = true;
      }
      // The numeric id to act on; the render gates the buttons on `isOwn`.
      const eid = parseEntityId(id);
      if (eid !== undefined) data.entityId = eid;
      if (gateTypeOf(subtype) !== null) data.gateAccess = gateAccessFromIndex(st.gateAccess);
      if (st.noAmmo === true) data.noAmmo = true;
      if (st.noFuel === true) data.noFuel = true;
      if (st.breach === true) data.breach = true;
      const prod = subtype !== undefined && isProcessorKind(subtype) && eid !== undefined ? readProduction(eid) : null;
      if (prod !== null && subtype !== undefined) {
        // P2b — what it makes and how it's going (the card's chip + slot).
        data.recipe = prod.recipe;
        data.prodState = st.prodState ?? 0;
        data.prodStatus = prodStatusLine((st.prodState ?? 0) as ProdState, decodeGood(st.prodMissing), prod.recipe);
        if (makesThings(subtype)) {
          data.makes = true;
          if (st.prodFrac !== undefined) data.prodPct = Math.round(st.prodFrac * 100);
        }
      }
      // WS-B4 — the level (≥ 1; absent on the slice ⇒ level 1).
      data.level = st.level ?? 1;
      if (subtype === 'research_lab' && data.isOwn === true && st.built === true) data.isLab = true;
      // v4 T1 — your own built teleporter shows its charge, pairing, rules and pad.
      if (isTeleporterKind(subtype) && data.isOwn === true && st.built === true) data.isTeleporter = true;
      // T4 — someone else's teleporter: ask its owner to pair it with one of yours.
      // (An NPC's teleporters are pre-linked; nobody answers a request for them.)
      if (isTeleporterKind(subtype) && !isAlienGateKind(subtype) && data.isOwn !== true && st.built === true && !(st.owner ?? '').startsWith('npc:')) data.isForeignTeleporter = true;
      // v4 A — an alien gate says where it leads and when it next jumps.
      if (isAlienGateKind(subtype)) {
        const e = getGameClient()?.mirror.swarm?.get(parseInt(id.startsWith('swarm-') ? id.slice(6) : id, 10));
        const line = e ? alienGateLine(useUIStore.getState().currentSectorKey, e.x, e.y, Date.now()) : null;
        if (line !== null) data.alienGateLine = line;
      }
      if (subtype !== undefined && (getStructureKind(subtype).holdCapacity ?? 0) > 0 && st.built === true) data.hasCargo = true;
      // Living World P1a-2 — owned storage contents (the server only sends them
      // to the owner) + the Refine gate (a Capital with salvage in its network
      // view — the contents line reflects THIS structure's hold).
      if (got && selectionStats.holdLine !== undefined) {
        data.holdLine = selectionStats.holdLine;
        data.canRefine = data.isOwn === true && subtype === 'capital' && selectionStats.holdSalvage > 0;
        if (data.isOwn === true && selectionStats.holdBlueprints !== '') data.blueprints = selectionStats.holdBlueprints;
        if (data.isOwn === true && selectionStats.holdPacked !== '') data.packed = selectionStats.holdPacked;
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
    // P4c-2 — a remote player's ship (ships are selected by playerId; the own
    // ship is never pickable) can carry a bounty.
    return { name: selectionStats.name || 'Ship', hpPct, shieldPct, bountyTarget: id, cargoShip: id };
  }

  // The rest read the render mirror directly (no server stats channel).
  const client = getGameClient();
  if (!client) return null;
  if (kind === 'drone' && id.startsWith('swarm-')) {
    const swarmId = parseInt(id.slice('swarm-'.length), 10);
    const sw = Number.isNaN(swarmId) ? undefined : client.mirror.swarm?.get(swarmId);
    if (!sw) return null;
    const frac = sw.healthFrac ?? 1;
    // C3 — an NPC ship carries a hold (its loot); breaking in is a hostile act.
    return { name: droneName(sw.shipKind), hpPct: frac * 100, shieldPct: null, entityId: swarmId, hasCargo: true };
  }
  // ASTEROID / CARGO POD — indestructible terrain, no hull bar (swarmTerrainInfo.ts).
  if ((kind === 'asteroid' || kind === 'pod') && id.startsWith('swarm-')) {
    const swarmId = parseInt(id.slice('swarm-'.length), 10);
    const sw = Number.isNaN(swarmId) ? undefined : client.mirror.swarm?.get(swarmId);
    if (!sw) return null;
    return kind === 'asteroid' ? asteroidPanelRow(sw) : podPanelRow(client.mirror, swarmId, sw);
  }
  // LINGERING HULL (R2.23) — the name line already shows WHOSE hull it is (the
  // owner's server-propagated display name); never surface the raw ownerPlayerId
  // (no ids in the UI). Labels come from parkedHullLabels (mine reads as mine).
  if (kind === 'lingering') {
    // A parked hull lives in the one ship list under its shipInstanceId
    // (RTS Part A S3); only a parked hull gets this panel (#17).
    const l = client.mirror.ships.get(id);
    if (!l || !isParkedHull(client.mirror, id, l)) return null;
    const mine = isOwnedByMe(client.mirror, id, l);
    const data: PanelData = {
      ...parkedHullLabels(l.displayName, l.kind, mine),
      hpPct: 0,
      shieldPct: null,
      noHull: true,
      // C3 — a parked hull's cargo: yours opens (move cargo between your
      // ships); anyone else's needs a break-in.
      cargoShip: id,
    };
    // WS-A2 — a lingering hull the LOCAL player owns is reclaimable via the
    // in-world Pilot action. The selection id IS the shipInstanceId (the
    // its `mirror.ships` key), which is exactly what `pilot_ship` needs.
    if (mine) data.pilotShipId = id;
    return data;
  }
  return null;
}

/**
 * The focused entity's PanelData, re-read every `POLL_MS` while something is
 * focused; null when nothing is. A poll only commits a re-render when a value
 * changed (`panelDataEqual`), so a still readout never re-renders.
 */
export function useSelectionPanelData(): PanelData | null {
  const selectedId = useUIStore((s) => s.selection.focusId);
  const selectedKind = useUIStore((s) => s.selection.focusKind);
  const [data, setData] = useState<PanelData | null>(null);

  useEffect(() => {
    if (selectedId === null) {
      setData(null);
      return;
    }
    // Wave-3 3.3 — diff before committing: `readData` builds a FRESH object
    // every poll, so an unconditional `setData` re-rendered ~6.7×/s even while
    // the numbers sat still. Returning the PREVIOUS reference when
    // shallow-equal lets React bail out of the commit entirely.
    const tick = (): void =>
      setData((prev) => {
        const next = readData(selectedId, selectedKind);
        const mirror = getGameClient()?.mirror;
        const stance = next !== null && mirror !== undefined && selectedKind !== null ? focusStance(mirror, selectedId, selectedKind) : null;
        if (next !== null && stance !== null) next.stance = stance;
        return prev !== null && next !== null && panelDataEqual(prev, next) ? prev : next;
      });
    tick();
    const handle = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(handle);
  }, [selectedId, selectedKind]);

  return selectedId === null ? null : data;
}

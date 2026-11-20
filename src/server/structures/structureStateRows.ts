/**
 * Structure room-state row writers moved out of SectorRoom verbatim: a
 * teleporter's fields and a structure's `connTo` / `connSock` lists. Each field is
 * assigned only on change (A2), and nothing allocates when nothing changed.
 */
import { holdWeight } from '../../core/cargo/hold.js';
import { encodeGood } from '../../shared-types/production.js';
import { STRUCTURE_DEFAULTS as SD, encodeConnSock } from '../../shared-types/structureStateWire.js';
import {
  TP_PARTNER_REMOTE,
  TP_RULE_BOARDS,
  TP_RULE_CHARGED,
  TP_RULE_KEEP,
  TP_RULE_LOADED,
  TP_RULE_TOLL_HOSTILE,
} from '../../shared-types/teleport.js';
import type { StructureState } from '../rooms/schema/SectorState.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';
import type { TeleporterSubsystem } from './TeleporterSubsystem.js';

/** v4 T1 — a teleporter's room-state fields (A2: assign only on change).
 *  `entityIdOf` maps a structure id to its swarm entity id. */
export function writeTeleporterRow(
  rec: StructureRecord, st: StructureState, nowMs: number,
  teleporters: Pick<TeleporterSubsystem, 'required' | 'partnerOf'>,
  entityIdOf: (id: string) => number | undefined,
): void {
  const phase = rec.tpPhase ?? 0;
  if ((st.tpPhase ?? SD.tpPhase) !== phase) {
    st.tpPhase = phase;
    // The phase's length rides along only when the phase changes (the client
    // times the animation from when the change arrives).
    const ms = phase === 0 ? 0 : Math.max(0, Math.min(65535, Math.round((rec.tpPhaseEndsAtMs ?? 0) - nowMs)));
    if ((st.tpPhaseMs ?? SD.tpPhaseMs) !== ms) st.tpPhaseMs = ms;
  }
  const req = teleporters.required(rec);
  const pct = req > 0 ? Math.min(100, Math.floor(((rec.tpCharge ?? 0) / req) * 100)) : 0;
  if ((st.tpChargePct ?? SD.tpChargePct) !== pct) st.tpChargePct = pct;
  const p = teleporters.partnerOf(rec);
  const partner = p !== null ? (entityIdOf(p.id) ?? -1) : rec.tpPartner !== undefined ? TP_PARTNER_REMOTE : -1;
  if ((st.tpPartner ?? SD.tpPartner) !== partner) st.tpPartner = partner;
  const r = rec.tpRules;
  const bits = r === undefined ? 0
    : (r.whenCharged ? TP_RULE_CHARGED : 0) | (r.shipBoards ? TP_RULE_BOARDS : 0) | (r.loaded ? TP_RULE_LOADED : 0) | (r.keepLoaded ? TP_RULE_KEEP : 0);
  const tollBits = rec.tpToll?.nonPayer === 'hostile' ? TP_RULE_TOLL_HOSTILE : 0;
  const tollPer = rec.tpToll?.per1000 ?? 0;
  if ((st.tpToll ?? SD.tpToll) !== tollPer) st.tpToll = tollPer;
  if ((st.tpRules ?? SD.tpRules) !== (bits | tollBits)) st.tpRules = bits | tollBits;
  const lg = r?.loaded ? (r.loaded.good === null ? 0 : encodeGood(r.loaded.good)) : 0;
  if ((st.tpLoadGood ?? SD.tpLoadGood) !== lg) st.tpLoadGood = lg;
  const lq = r?.loaded?.qty ?? 0;
  if ((st.tpLoadQty ?? SD.tpLoadQty) !== lq) st.tpLoadQty = lq;
  const kg = r?.keepLoaded ? encodeGood(r.keepLoaded.good) : 0;
  if ((st.tpKeepGood ?? SD.tpKeepGood) !== kg) st.tpKeepGood = kg;
  const kq = r?.keepLoaded?.qty ?? 0;
  if ((st.tpKeepQty ?? SD.tpKeepQty) !== kq) st.tpKeepQty = kq;
  const w = rec.padHold ? Math.min(65535, Math.round(holdWeight(rec.padHold))) : 0;
  if ((st.padWeight ?? SD.padWeight) !== w) st.padWeight = w;
}

/** Mirror a structure's connections into its room-state `connTo` and, in
 *  the same change check, each link's cable sockets into the parallel
 *  `connSock` (this end + the other end, `encodeConnSock`). Both arrays are
 *  rewritten together when either differs, so their entries always line up;
 *  compared in place — no allocation when unchanged.
 *  `entityIdOf` maps a structure id to its swarm entity id. */
export function writeConnToRow(
  id: string, st: StructureState, registry: Pick<StructureRegistry, 'connectionsOf'>,
  entityIdOf: (id: string) => number | undefined,
): void {
  const conns = registry.connectionsOf(id);
  let n = 0;
  let same = true;
  for (const c of conns) {
    const other = c.getOtherNode(id);
    if (other === null) continue;
    const eid = entityIdOf(other);
    if (eid === undefined) continue;
    if (n >= st.connTo.length || st.connTo.at(n) !== eid) same = false;
    else if (n >= st.connSock.length || st.connSock.at(n) !== encodeConnSock(c.socketAt(id), c.socketAt(other))) same = false;
    n++;
  }
  if (same && n === st.connTo.length && n === st.connSock.length) return;
  st.connTo.clear();
  st.connSock.clear();
  for (const c of conns) {
    const other = c.getOtherNode(id);
    if (other === null) continue;
    const eid = entityIdOf(other);
    if (eid === undefined) continue;
    st.connTo.push(eid);
    st.connSock.push(encodeConnSock(c.socketAt(id), c.socketAt(other)));
  }
}

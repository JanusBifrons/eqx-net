/**
 * A2 (plan soft-leaping-truffle v2) — room-state `structures` (join payload +
 * delta patches) into `mirror.structures`, in place. Built once by
 * `ColyseusClient`; `syncStructures` calls `sync()` each snapshot. Callbacks
 * are bound once and nothing is allocated once every row exists (#14).
 *
 * Only CHANGED rows are decoded. The schema decoder's change feed
 * (`decoder.triggerChanges`, the hook colyseus.js's own `getStateCallbacks`
 * uses) names every instance a patch touched; a row is re-decoded when it (or
 * its `connTo` / `connSock` array) is in that set, when it is new or replaced,
 * when its swarm kind changed (the rig clip needs it), or when the owner
 * tables changed. With no change feed (no schema serializer) every row is
 * decoded every sync, as before. Every row is still walked each sync, so the
 * mirror converges from room state alone (#16).
 */
import type { DeckPlatesMirror, RenderMirror, StructureRenderState } from '@core/contracts/IRenderer';
import type { StructureStateView } from '../../../shared-types/structureStateWire.js';
import { SWARM_KIND_STRUCTURE } from '../../../shared-types/swarmWireFormat.js';
import { decodeStructureState, emptyStructureRow } from '../structureStateDecode.js';
import { PlateSet } from '../../../core/hex/plateSet.js';

type StrMap = { forEach(cb: (v: string, k: string) => void): void };

/** The slice of `room.state` this sync reads. */
export interface StructureRoomState {
  structures?: { size: number; forEach(cb: (v: StructureStateView, k: string) => void): void };
  structureOwners?: StrMap;
  structureOwnerNames?: StrMap;
  /** Base platforms: the room floors its plates. */
  deck?: boolean;
}

/** The schema decoder's change hook (`@colyseus/schema` `Decoder`). */
type ChangeFeed = (changes: ReadonlyArray<{ readonly ref: unknown }>) => void;
interface DecoderHook { triggerChanges?: ChangeFeed }

/** The slice of the Colyseus room this sync reads. */
export interface StructureRoom { readonly state?: unknown }

export class StructureRowSync {
  /** Base platforms — the derived plate set, the same core module the server
   *  registry keeps (#15): refreshed as rows decode (owner / kind / pose) and
   *  leave. Read it; never write it. */
  readonly plates = new PlateSet<number>();
  /** entityId → generation last seen in room state (stale sweep). */
  private readonly gen = new Map<number, number>();
  private genN = 0;
  private map: Map<number, StructureRenderState> | null = null;
  /** entityId → the room-state row instance last decoded into its mirror row. */
  private readonly decodedRow = new Map<number, StructureStateView>();
  /** entityId → the swarm kind that decode used (rig clips need it). */
  private readonly decodedKind = new Map<number, string | undefined>();
  /** Schema instances touched by a patch since the last sync. */
  private readonly dirty = new Set<unknown>();
  /** Decode every row this sync (no change feed, or it was just (re)hooked). */
  private all = true;
  private decoder: DecoderHook | null = null;
  private hook: ChangeFeed | null = null;
  private lastMap: Map<number, StructureRenderState> | null = null;
  /** The plate-set version / deck flag last written to `mirror.deckPlates`. */
  private deckPlatesVersion = -1;
  private deckOn = false;
  /** Writes one plate into `mirror.deckPlates` (bound once, #14). */
  private readonly writePlate = (_owner: string, i: number, j: number): void => {
    const dp = this.mirror.deckPlates!;
    const n = dp.count;
    if (2 * n + 2 > dp.ij.length) {
      // Grows on a plate-set change only (never per frame): double capacity.
      const grown = new Int32Array(dp.ij.length * 2);
      grown.set(dp.ij);
      dp.ij = grown;
    }
    dp.ij[2 * n] = i;
    dp.ij[2 * n + 1] = j;
    dp.count = n + 1;
  };

  constructor(
    private readonly mirror: RenderMirror,
    /** Interned owner tables (index → id / name), shared with `MineSync`. */
    private readonly owners: { ids: string[]; names: string[] },
  ) {}

  private readonly readOwner = (v: string, k: string): void => { this.owners.ids[Number(k)] = v; };
  private readonly readOwnerName = (v: string, k: string): void => { this.owners.names[Number(k)] = v; };

  private readonly markDirty: ChangeFeed = (changes) => {
    for (let i = 0; i < changes.length; i++) this.dirty.add(changes[i]!.ref);
  };

  /** Hook the room's schema decoder (once per decoder). False ⇒ no feed. */
  private watch(room: StructureRoom): boolean {
    const dec = (room as { serializer?: { decoder?: DecoderHook } }).serializer?.decoder;
    if (!dec) {
      this.decoder = null;
      this.hook = null;
      return false;
    }
    if (dec === this.decoder && dec.triggerChanges === this.hook) return true;
    // New decoder, or someone replaced our hook: we may have missed changes.
    const prev = dec.triggerChanges;
    const mark = this.markDirty;
    // Chains any existing hook (colyseus.js state callbacks); built once per decoder.
    this.hook = prev ? (c) => { mark(c); prev(c); } : mark;
    dec.triggerChanges = this.hook;
    this.decoder = dec;
    this.dirty.clear();
    this.all = true;
    return true;
  }

  /** Decode one room-state row into its mirror row in place (changed rows only). */
  private readonly decodeRow = (v: StructureStateView, key: string): void => {
    const id = Number(key);
    const map = this.map!;
    let row = map.get(id);
    let fresh = false;
    if (!row) {
      row = emptyStructureRow();
      map.set(id, row);
      fresh = true;
    }
    const kind = this.mirror.swarm?.get(id)?.shipKind;
    const d = this.dirty;
    if (
      fresh || this.all || this.decodedRow.get(id) !== v || this.decodedKind.get(id) !== kind ||
      d.has(v) || d.has(v.connTo) || (v.connSock !== undefined && d.has(v.connSock))
    ) {
      decodeStructureState(v, this.owners, row, kind);
      const sw = this.mirror.swarm?.get(id);
      this.plates.upsert(id, row.owner ?? '', kind, sw?.x ?? 0, sw?.y ?? 0);
      this.decodedRow.set(id, v);
      this.decodedKind.set(id, kind);
    }
    // Snapshot cosmetics are refilled after this pass (beam links, angles).
    row.turretTargetId = undefined;
    row.turretTargetPlayerId = undefined;
    row.miningTargetId = undefined;
    // Coastal defences — refilled from this snapshot's angles (empty = at rest).
    if (row.mountAngles) row.mountAngles.length = 0;
    this.gen.set(id, this.genN);
  };

  /** Mirror `state.structures` into `mirror.structures`; a row gone from room
   *  state is gone (with its pose entry: room state owns a structure's
   *  lifetime, the binary full refresh never sweeps structures). */
  sync(room: StructureRoom | null | undefined): void {
    this.syncRows(room);
    this.syncDeckPlates((room?.state as StructureRoomState | undefined)?.deck === true);
  }

  /**
   * Base platforms: copy the plate set into `mirror.deckPlates` (the same
   * mirror channel as the rows) when it or the room's deck flag changed.
   * Off ⇒ count 0. An unchanged sync writes nothing.
   */
  private syncDeckPlates(deck: boolean): void {
    if (deck === this.deckOn && this.plates.version === this.deckPlatesVersion) return;
    this.deckOn = deck;
    this.deckPlatesVersion = this.plates.version;
    let dp: DeckPlatesMirror | undefined = this.mirror.deckPlates;
    if (!dp) { dp = { version: 0, count: 0, ij: new Int32Array(32) }; this.mirror.deckPlates = dp; }
    dp.version++;
    dp.count = 0;
    dp.deck = deck;
    if (deck) this.plates.forEachOwnerPlate(this.writePlate);
  }

  private syncRows(room: StructureRoom | null | undefined): void {
    const state = room?.state as StructureRoomState | undefined;
    const rows = state?.structures;
    if (!room || !this.watch(room)) this.all = true;
    // Owner names feed every row's `ownerName`: a table change re-decodes all.
    if (state?.structureOwners && this.dirty.has(state.structureOwners)) this.all = true;
    if (state?.structureOwnerNames && this.dirty.has(state.structureOwnerNames)) this.all = true;
    // Owners are few (one per base): re-read the tables each sync (no alloc —
    // writes into persistent arrays).
    state?.structureOwners?.forEach(this.readOwner);
    state?.structureOwnerNames?.forEach(this.readOwnerName);
    if (!rows || rows.size === 0) {
      if (this.mirror.structures && this.mirror.structures.size > 0) this.mirror.structures.clear();
      this.gen.clear();
      this.decodedRow.clear();
      this.decodedKind.clear();
      this.dirty.clear();
      this.plates.clear();
      return;
    }
    let map = this.mirror.structures;
    if (!map) { map = new Map(); this.mirror.structures = map; }
    if (map !== this.lastMap) this.all = true; // a replaced mirror map holds none of our rows
    this.lastMap = map;
    this.map = map;
    this.genN++;
    rows.forEach(this.decodeRow);
    this.dirty.clear();
    this.all = false;
    for (const [id, g] of this.gen) {
      if (g === this.genN) continue;
      this.gen.delete(id);
      this.decodedRow.delete(id);
      this.decodedKind.delete(id);
      this.plates.remove(id);
      map.delete(id);
      const sw = this.mirror.swarm?.get(id);
      if (sw && sw.kind === SWARM_KIND_STRUCTURE) this.mirror.swarm!.delete(id);
    }
  }
}

/**
 * A shell's hits and kills show when the DRAWN shell gets there
 * (docs/architecture/shell-events.md). `ColyseusClient`'s collaborator for
 * the event-shell timeline: it wires the salvo store (`ShellSalvoStore`) to
 * the held hits (`NavalHitHold`) and holds deaths for them.
 *
 * Kills wait for the drawn shell (same guide, "Kills wait for the drawn
 * shell"). A `destroy` arrives in the same server flush as the killing hit's
 * damage, but the shell is drawn on the display timeline, ~`DISPLAY_DELAY_MS` +
 * RTT/2 behind it: killing on arrival split the hull and showed its number
 * frames before the drawn shell got there (rail take 6 review). While the
 * KILLING hit is held for its drawn shell (`NavalHitHold.holdsKill`), the
 * ship stays drawn alive; it dies when that hit is released (`release`, each
 * frame from `place`) or its deadline passes (#16: `MAX_HOLD_MS`). Its
 * new wreck pieces wait too (`mirror.wreckRevealFromTick`).
 *
 * Records are pooled and mutated in place; no allocation once warm (#14).
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { DamageEvent, LaserFiredEvent } from '@shared-types/messages';
import type { ShellEnd, ShellSalvo } from '@shared-types/messages/shellEvents';
import { MAX_HOLD_MS, type HeldDamageSink, type NavalHitHold } from './navalHitHold';
import type { ShellSalvoStore } from './shellSalvoStore';

/** A ship's death held for its drawn shell: its wire id, the kind it was (an
 *  id recycled meanwhile is not killed), the game-ms deadline, and whether
 *  its destroy said `vaporised` (re-marked on the release frame). */
interface DeferredKill { wireId: string; kind: number; shipKind: string | undefined; deadline: number; vaporised: boolean }

/** Ticks before the newest snapshot tick from which a held death's wreck
 *  pieces wait (`RenderMirror.wreckRevealFromTick`): the kill tick is at or
 *  before the newest tick heard of, give or take a DataChannel refresh. */
const DEFERRED_KILL_TICK_SLACK = 30;

/** What it needs from its owner (`ColyseusClient`); read lazily, so the
 *  owner may build it before these fields exist. Built once (#14). */
export interface DrawnShellTimingHost {
  mirror(): RenderMirror;
  store(): ShellSalvoStore;
  hold(): NavalHitHold;
  sink(): HeldDamageSink;
  /** Are shells sent as events (`?shellEvents`)? */
  shellEvents(): boolean;
  /** Game-clock ms. */
  now(): number;
  /** Newest snapshot server tick heard of. */
  anchorTick(): number;
  killSwarmEntity(wireId: string): void;
  killEntity(id: string): void;
  /** Despawn a parked hull's predWorld body. */
  despawnLinger(id: string): void;
}

export class DrawnShellTiming {
  /** Swarm ships killed by an event shell, still drawn alive, keyed by entity
   *  id (the decoder's full-snapshot sweep skips them: `decodeSwarmPacket`
   *  `keep`). */
  readonly swarmKills = new Map<number, DeferredKill>();
  /** Pilot hulls (parked, or another pilot's) whose death is held, keyed by
   *  wire id; the snapshot routing keeps them meanwhile (`keepLingering`,
   *  `syncMirror`'s departed sweep). */
  readonly shipKills = new Map<string, DeferredKill>();
  private readonly free: DeferredKill[] = [];

  constructor(private readonly host: DrawnShellTimingHost) {}

  /** A welcome: the old shells, held hits and held deaths are gone; with
   *  shells as events, take the shells already in flight (#16). */
  onWelcome(shellEvents: boolean, inFlight: readonly ShellSalvo[] | undefined): void {
    const store = this.host.store();
    const mirror = this.host.mirror();
    store.clear();
    this.host.hold().flush(this.host.sink());
    if (this.pending) this.release();
    if (shellEvents) {
      mirror.shellSalvos = store.map;
      if (inFlight !== undefined) for (const s of inFlight) store.applySalvo(s);
    } else {
      mirror.shellSalvos = undefined;
    }
  }

  /** A naval shell hit's FX wait for the frame its shell's burst is drawn
   *  (`navalHitHold.ts`). Returns whether the hit was held. */
  holdHit(evt: DamageEvent, suppressNumber: boolean): boolean {
    return this.host.shellEvents()
      && this.host.hold().maybeHold(evt, suppressNumber, this.host.store().map, this.host.now());
  }

  /** A `shell_end`: mark the shells, and match held naval hits to it. */
  onShellEnd(msg: ShellEnd): void {
    const store = this.host.store();
    const hold = this.host.hold();
    const mirror = this.host.mirror();
    store.applyEnd(msg, mirror.pendingShellEnds ??= []);
    if (hold.size === 0) return;
    const now = this.host.now();
    // Held hits wait for the drawn shell to REACH the hit, a fraction of a
    // step after the reported tick (`ShellSalvoStore.hitTick`), like its burst.
    for (const e of msg.e) hold.onShellEnd(store.hitTick(e[0], e[1], e[2], e[3]), e[2], e[3], now);
  }

  /** One frame of event shells at `displayTick`: draw, burst, and release
   *  the held hits whose burst is now drawn (or whose safety ran out), and
   *  the deaths held for them. */
  place(displayTick: number): void {
    const mirror = this.host.mirror();
    const hold = this.host.hold();
    if (mirror.projectiles) {
      this.host.store().place(mirror.projectiles, displayTick, mirror.pendingShellEnds ??= []);
    }
    if (hold.size > 0) hold.release(displayTick, this.host.now(), this.host.sink());
    if (this.pending) this.release();
  }

  /** Any death held? */
  get pending(): boolean {
    return this.swarmKills.size > 0 || this.shipKills.size > 0;
  }

  /**
   * A `destroy` for `wireId` while a hit on it is still held for its drawn
   * shell: keep it drawn alive and kill it when that hit is released.
   * Returns whether it was deferred. Only the KILLING hit counts
   * (`holdsKill`): shells still in flight to it that did not kill it never
   * hold a death (heavy-beam take 8: a beam kill waited ~0.9 s for unrelated
   * 5" shells). `vaporised` (the destroy's, fracture v11) rides the record:
   * `mirror.vaporisedShips` is one-frame, so the release marks it again.
   */
  deferKill(wireId: string, vaporised: boolean): boolean {
    const hold = this.host.hold();
    if (!this.host.shellEvents() || hold.size === 0 || !hold.holdsKill(wireId)) return false;
    if (!wireId.startsWith('swarm-')) return this.deferShipKill(wireId, vaporised);
    const entityId = parseInt(wireId.slice('swarm-'.length), 10);
    const entry = Number.isNaN(entityId) ? undefined : this.host.mirror().swarm?.get(entityId);
    if (entry === undefined) return false;
    let k = this.swarmKills.get(entityId);
    if (k === undefined) {
      k = this.free.pop() ?? { wireId: '', kind: 0, shipKind: undefined, deadline: 0, vaporised: false };
      this.swarmKills.set(entityId, k);
    }
    k.wireId = wireId; k.kind = entry.kind; k.shipKind = entry.shipKind; k.vaporised = vaporised;
    k.deadline = this.host.now() + MAX_HOLD_MS;
    this.holdWrecks();
    return true;
  }

  /**
   * The same deferral for a pilot's hull: a parked (lingering) hull, keyed by
   * shipInstanceId, or another pilot's active ship. Rail take 7: the heavy
   * cruiser the slug passed through was the spectating pilot's PARKED hull;
   * its destroy went to `killEntity` at once and the next snapshot (which no
   * longer lists it) evicted it, ~6 frames before the drawn slug got there.
   * The local pilot's own active ship still dies on the event (its death
   * drives the spectator flip).
   */
  private deferShipKill(wireId: string, vaporised: boolean): boolean {
    const mirror = this.host.mirror();
    if (wireId === mirror.localPlayerId) return false;
    if (mirror.lingeringShips?.has(wireId) !== true && !mirror.ships.has(wireId)) return false;
    let k = this.shipKills.get(wireId);
    if (k === undefined) {
      k = this.free.pop() ?? { wireId: '', kind: 0, shipKind: undefined, deadline: 0, vaporised: false };
      this.shipKills.set(wireId, k);
    }
    k.wireId = wireId; k.kind = 0; k.shipKind = undefined; k.vaporised = vaporised;
    k.deadline = this.host.now() + MAX_HOLD_MS;
    this.holdWrecks();
    return true;
  }

  /** A held death's new wreck pieces wait (`mirror.wreckRevealFromTick`):
   *  the kill happened at or before the newest tick heard of; the slack
   *  covers a binary refresh (DataChannel) that ran ahead of this event. */
  private holdWrecks(): void {
    const mirror = this.host.mirror();
    const from = this.host.anchorTick() - DEFERRED_KILL_TICK_SLACK;
    const cur = mirror.wreckRevealFromTick;
    mirror.wreckRevealFromTick = cur === undefined ? from : Math.min(cur, from);
  }

  /**
   * A beam hit (`laser_fired`, sent after its damage and destroy): a hit
   * held at the beam's end point was matched to a live shell's path only by
   * position. It is the beam's, shown on arrival: release it, and with it a
   * death held for it, in this frame.
   */
  onBeamFired(evt: LaserFiredEvent): void {
    const hold = this.host.hold();
    if (!evt.hit || evt.targetId === undefined || hold.size === 0) return;
    if (!hold.releaseHitAt(evt.targetId, evt.toX, evt.toY, this.host.sink())) return;
    if (this.pending) this.release();
  }

  /** Kill each deferred ship whose killing hit has been released (its drawn
   *  shell reached it) or whose deadline passed, in this frame; a vaporised
   *  one goes into `mirror.vaporisedShips` in that same frame. */
  release(): void {
    const host = this.host;
    const hold = host.hold();
    const mirror = host.mirror();
    const now = host.now();
    for (const [entityId, k] of this.swarmKills) {
      if (now < k.deadline && hold.holdsKill(k.wireId)) continue;
      this.swarmKills.delete(entityId);
      this.free.push(k);
      // The id was recycled for a new entity meanwhile: that one is not dead.
      const e = mirror.swarm?.get(entityId);
      if (e !== undefined && (e.kind !== k.kind || e.shipKind !== k.shipKind)) continue;
      // Vaporised: marked in the same frame as its explosion (one-frame set).
      if (k.vaporised) mirror.vaporisedShips?.add(k.wireId);
      host.killSwarmEntity(k.wireId);
    }
    for (const [id, k] of this.shipKills) {
      if (now < k.deadline && hold.holdsKill(id)) continue;
      this.shipKills.delete(id);
      this.free.push(k);
      if (k.vaporised) mirror.vaporisedShips?.add(id);
      host.killEntity(id);
      // A parked hull: gone with its explosion (the snapshot routing kept it
      // while its death was held, so nothing else evicts it this frame).
      if (mirror.lingeringShips?.delete(id) === true) host.despawnLinger(id);
    }
    if (!this.pending) mirror.wreckRevealFromTick = undefined;
  }

  /** A new sector: held deaths belong to the old one. */
  reset(): void {
    for (const k of this.swarmKills.values()) this.free.push(k);
    this.swarmKills.clear();
    for (const k of this.shipKills.values()) this.free.push(k);
    this.shipKills.clear();
    this.host.mirror().wreckRevealFromTick = undefined;
  }
}

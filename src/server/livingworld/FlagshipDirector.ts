/**
 * Flagship fleets (wrap-up plan W2a, capitals Phase 5).
 *
 * Keeps `fleetCount` (default 1) capital fleets alive across the galaxy. A
 * fleet is one capital ship (the flagship, named and never load-shed: it is
 * marked an elite) plus escorts that flock round it. It roams a solar-system
 * sector pocket to pocket: the whole fleet spools and warps together (the NPC
 * warp, `LivingWorldRoom.warpBot`), the capital's slow turn making its spool
 * the long one. Every few moves it heads for a gate pocket and crosses into
 * the neighbouring system, arriving at that system's gate facing back.
 *
 * The capital's class follows the sector's power: a power's heartland fields
 * battleships and battlecruisers, neutral ground cruisers.
 *
 * Driven by the drone director's `onTick` (control cadence, ~1.5 s), so
 * allocation here is fine. The galaxy map learns of a fleet from the galaxy
 * snapshot (`SectorLiveState.capital`, via `sectorCapital`); world notices
 * are accelerators only (#16). Persisted (`allegiance_director_state` row
 * `flagships`) so a restart resumes each fleet where it was.
 */
import { sectorSites, warpDropPoint, type SectorSite } from '../../core/galaxy/sectorSites.js';
import { sectorController } from '../../core/galaxy/control.js';
import { getNeighbours, getSector } from '../../core/galaxy/galaxy.js';
import type { Bus } from '../../core/events/Bus.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { CAPITAL_STYLE_VARIANTS } from '../../shared-types/shipKinds/capitals/index.js';
import type { WorldNotice } from '../../shared-types/worldNotice.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { FLAGSHIP_BOT_ID_PREFIX } from './directorBotIds.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';
import type { Rng } from './population.js';
import { gameNow } from '../time/gameTime.js';

export const FLEET_COUNT = 1;
/** A destroyed fleet's replacement arrives this long after, elsewhere. */
export const FLEET_RESPAWN_MS = 15 * 60_000;
/** Time a fleet holds a pocket before it moves on. */
export const FLEET_DWELL_MS = 4 * 60_000;
/** Every this many pocket moves, the fleet leaves for a neighbouring system. */
export const FLEET_SECTOR_HOP_EVERY = 3;
/** The flagship wanders its pocket, picking a new point this often. */
export const FLEET_WANDER_MS = 45_000;
/** Escorts: a pair of destroyers and four gunships. */
export const FLEET_ESCORT_KINDS: readonly ShipKindId[] = ['destroyer', 'destroyer', 'gunship', 'gunship', 'gunship', 'gunship'];
/**
 * Escort station distance from the flagship's centre (u): both hulls' radii
 * plus a fifth of the capital's, so escorts sit clear of it at any ship scale
 * (invariant #18: sizes come from the scaled kind, never a constant). A
 * fighter-scale flock distance put escorts inside a battleship's hull, and the
 * first integration run rammed two of them to death.
 */
export function escortRing(capital: ShipKindId, escort: ShipKindId): number {
  const rc = getShipKind(capital).radius;
  return rc * 1.2 + getShipKind(escort).radius;
}
/** The flagship's hull bonus over its class (elites use 4×; a capital is big already). */
const FLAGSHIP_HEALTH_MUL = 1.5;
const FLAGSHIP_BOUNTY = 2500;
/** A warp takes the spool (3 s) + the run; give the move this long before the next decision. */
const MOVE_SETTLE_MS = 20_000;
/** An escort's spool (3 s) plus a control tick: send escorts when the flagship
 *  will face its jump within this (s). */
const ESCORT_SPOOL_LEAD_S = 4.5;

const HULL_NAMES = ['Resolute', 'Indomitable', 'Vanguard', 'Sovereign', 'Tempest', 'Warspite', 'Valiant', 'Dauntless', 'Implacable', 'Majestic', 'Thunderer', 'Formidable'];

/** The capital class for a fleet in `sectorKey` (pure; tests). */
export function fleetCapitalKind(sectorKey: string, rng: Rng): ShipKindId {
  const held = sectorController(sectorKey) !== null;
  const pool: ShipKindId[] = held ? ['battleship', 'battlecruiser'] : ['light-cruiser', 'heavy-cruiser'];
  return pool[Math.floor(rng() * pool.length) % pool.length]!;
}

/**
 * W2b — a capital's hull style (A, B or C), seeded from the ship's own id so
 * a fleet's ships differ and the same ship keeps its style. Non-capital kinds
 * pass through. Pure (tests).
 */
export function styledKind(kind: ShipKindId, shipId: string): ShipKindId {
  const styles = CAPITAL_STYLE_VARIANTS[kind];
  if (!styles) return kind;
  let h = 2166136261;
  for (let i = 0; i < shipId.length; i++) { h ^= shipId.charCodeAt(i); h = Math.imul(h, 16777619); }
  return styles[(h >>> 0) % styles.length] as ShipKindId;
}

/** The class of a capital kind (a style variant's base). */
function classOf(kind: ShipKindId): string {
  return kind.replace(/-[bc]$/, '');
}

const CLASS_PREFIX: Partial<Record<string, string>> = {
  battleship: 'Battleship', battlecruiser: 'Battlecruiser', 'heavy-cruiser': 'Cruiser', 'light-cruiser': 'Cruiser', destroyer: 'Destroyer',
};

export interface FleetSummary {
  name: string;
  kind: ShipKindId;
  sectorKey: string;
  escorts: number;
}

/** One fleet as persisted (abstract: no poses, no ids). */
export interface FleetState {
  sectorKey: string;
  pocketId: string;
  kind: ShipKindId;
  name: string;
  moves: number;
  escorts: ShipKindId[];
}
export interface FlagshipStatePayload { version: number; fleets: FleetState[] }
export const FLAGSHIP_STATE_VERSION = 1;

export interface FlagshipDirectorOptions {
  rng?: Rng;
  nowMs?: () => number;
  fleetCount?: number;
  respawnMs?: number;
  dwellMs?: number;
  /** Restrict the first spawn to this sector (tests). */
  firstSector?: string;
  /** Persisted state to resume (null ⇒ fresh). */
  restore?: FlagshipStatePayload | null;
  /** Write the state (throttled by the caller's cadence: every `persistMs`). */
  save?: (payload: FlagshipStatePayload) => void;
  persistMs?: number;
}

interface Fleet {
  alive: boolean;
  sectorKey: string | null;
  pocketId: string;
  leadId: string;
  escorts: Array<{ id: string; kind: ShipKindId }>;
  kind: ShipKindId;
  name: string;
  moves: number;
  respawnAtMs: number;
  nextMoveAtMs: number;
  nextWanderAtMs: number;
  /** Set while heading for a gate to leave the system: the neighbour. */
  leavingFor: string | null;
  /** Restored state to spawn from (once). */
  resume: FleetState | null;
  /** The pocket the fleet guards, cached by (sector, pocket) so the control
   *  tick doesn't rebuild the sector's site list every time (invariant #14). */
  guardSite?: SectorSite | null;
  guardSiteSector?: string | null;
  guardSitePocket?: string;
  /** Where the escorts warp to, once the flagship has nearly turned to face
   *  its jump (a capital turns slowly; escorts sent at once jumped first). */
  escortDrop: { x: number; y: number } | null;
}

export class FlagshipDirector {
  private readonly fleets: Fleet[] = [];
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly respawnMs: number;
  private readonly dwellMs: number;
  private readonly subs: Array<{ bus: Bus; fn: (e: { type: 'ENTITY_DESTROYED'; entityId: string }) => void }> = [];
  private generation = 0;
  private nextPersistAtMs = 0;

  constructor(
    private readonly rooms: ReadonlyMap<string, LivingWorldRoom>,
    private readonly opts: FlagshipDirectorOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.nowMs ?? gameNow;
    this.respawnMs = opts.respawnMs ?? FLEET_RESPAWN_MS;
    this.dwellMs = opts.dwellMs ?? FLEET_DWELL_MS;
    const n = opts.fleetCount ?? FLEET_COUNT;
    const restored = opts.restore?.version === FLAGSHIP_STATE_VERSION ? opts.restore.fleets : [];
    for (let i = 0; i < n; i++) {
      this.fleets.push({
        alive: false, sectorKey: null, pocketId: '', leadId: '', escorts: [], kind: 'light-cruiser', name: '',
        moves: 0, respawnAtMs: 0, nextMoveAtMs: 0, nextWanderAtMs: 0, leavingFor: null, resume: restored[i] ?? null, escortDrop: null,
      });
    }
  }

  start(): void {
    for (const room of this.rooms.values()) {
      const bus = room.eventBus();
      const fn = (e: { type: 'ENTITY_DESTROYED'; entityId: string }): void => {
        if (e.entityId.startsWith(FLAGSHIP_BOT_ID_PREFIX)) this.onShipDestroyed(e.entityId);
      };
      bus.on('ENTITY_DESTROYED', fn);
      this.subs.push({ bus, fn });
    }
    this.tick(this.now());
  }

  stop(): void {
    for (const s of this.subs) s.bus.off('ENTITY_DESTROYED', s.fn);
    this.subs.length = 0;
  }

  /** Control-tick step: spawn due fleets, move the living ones. */
  tick(nowMs: number): void {
    for (const f of this.fleets) {
      if (!f.alive) {
        if (nowMs >= f.respawnAtMs) this.spawn(f, nowMs);
        continue;
      }
      this.steer(f, nowMs);
    }
    if (this.opts.save && nowMs >= this.nextPersistAtMs) {
      this.nextPersistAtMs = nowMs + (this.opts.persistMs ?? 60_000);
      this.persist();
    }
  }

  /** The living fleets (galaxy map, `/dev` inspection). */
  fleetsView(): FleetSummary[] {
    const out: FleetSummary[] = [];
    for (const f of this.fleets) {
      if (f.alive && f.sectorKey !== null) out.push({ name: f.name, kind: f.kind, sectorKey: f.sectorKey, escorts: f.escorts.length });
    }
    return out;
  }

  /** A fleet's flagship in `sectorKey` (galaxy-snapshot hook), or null. */
  sectorCapital(sectorKey: string): { name: string; kind: ShipKindId } | null {
    for (const f of this.fleets) if (f.alive && f.sectorKey === sectorKey) return { name: f.name, kind: f.kind };
    return null;
  }

  /** The abstract state to persist (also on shutdown). */
  state(): FlagshipStatePayload {
    const fleets: FleetState[] = [];
    for (const f of this.fleets) {
      if (!f.alive || f.sectorKey === null) continue;
      fleets.push({ sectorKey: f.sectorKey, pocketId: f.pocketId, kind: f.kind, name: f.name, moves: f.moves, escorts: f.escorts.map((e) => e.kind) });
    }
    return { version: FLAGSHIP_STATE_VERSION, fleets };
  }

  persist(): void {
    this.opts.save?.(this.state());
  }

  // ── spawning ──────────────────────────────────────────────────────────

  private spawn(f: Fleet, nowMs: number): void {
    const resume = f.resume;
    f.resume = null;
    const sectorKey = resume && this.rooms.has(resume.sectorKey) ? resume.sectorKey : this.pickSector();
    if (sectorKey === null) return;
    const sites = sectorSites(sectorKey);
    // A fleet arrives through a gate (fresh) or where it was (restored).
    const site = (resume ? sites.find((s) => s.id === resume.pocketId) : undefined)
      ?? this.pick(sites.filter((s) => s.kind === 'gate'))
      ?? sites[0];
    if (!site) return;
    const escorts = resume?.escorts ?? [...FLEET_ESCORT_KINDS];
    this.assignIds(f, escorts);
    // Each capital in the fleet takes its own hull style (W2b).
    const kind = resume?.kind ?? styledKind(fleetCapitalKind(sectorKey, this.rng), f.leadId);
    if (!resume) for (const e of f.escorts) e.kind = styledKind(e.kind, e.id);
    const name = resume?.name ?? `${CLASS_PREFIX[classOf(kind)] ?? 'Capital'} ${this.pick(HULL_NAMES) ?? 'Resolute'}`;
    if (!this.spawnFleetAt(f, sectorKey, site, kind, name)) return;
    Object.assign(f, { alive: true, sectorKey, pocketId: site.id, kind, name, moves: resume?.moves ?? 0, leavingFor: null });
    f.nextMoveAtMs = nowMs + this.dwellMs;
    f.nextWanderAtMs = nowMs;
    serverLogEvent('flagship_spawned', { name, kind, sectorKey, pocket: site.id, escorts: f.escorts.length });
    if (!resume) this.announce({ type: 'world_notice', kind: 'elite_spawned', message: `Capital ship sighted: the ${name}!` });
  }

  /** Spawn the flagship on `site`'s rim and the escorts round it. False when
   *  the room is full (the fleet retries next tick). */
  private spawnFleetAt(f: Fleet, sectorKey: string, site: SectorSite, kind: ShipKindId, name: string): boolean {
    const room = this.rooms.get(sectorKey);
    if (!room || !room.hasFreeSlot()) return false;
    const a = this.rng() * Math.PI * 2;
    const x = site.x + Math.cos(a) * site.r, y = site.y + Math.sin(a) * site.r;
    if (!room.spawnLivingWorldBot({ botId: f.leadId, kind, x, y })) return false;
    if (room.markElite?.(f.leadId, name, FLAGSHIP_HEALTH_MUL, FLAGSHIP_BOUNTY) !== true) {
      room.despawnLivingWorldBot(f.leadId);
      return false;
    }
    const kept: Array<{ id: string; kind: ShipKindId }> = [];
    for (let i = 0; i < f.escorts.length; i++) {
      const e = f.escorts[i]!;
      const ea = (i / f.escorts.length) * Math.PI * 2;
      const ring = escortRing(kind, e.kind);
      if (room.spawnLivingWorldBot({ botId: e.id, kind: e.kind, x: x + Math.cos(ea) * ring, y: y + Math.sin(ea) * ring })) kept.push(e);
    }
    f.escorts = kept;
    f.kind = kind;
    this.formUp(room, f);
    return true;
  }

  /** Escorts hold stations round the flagship, turned with its heading;
   *  refreshed every control tick (a capital moves slowly). */
  private formUp(room: LivingWorldRoom, f: Fleet): void {
    const lead = room.getBotPose(f.leadId);
    if (!lead) return;
    for (let i = 0; i < f.escorts.length; i++) {
      const e = f.escorts[i]!;
      const ring = escortRing(f.kind, e.kind);
      const a = lead.angle + (i / f.escorts.length) * Math.PI * 2;
      room.setBotMoveTarget(e.id, lead.x + Math.cos(a) * ring, lead.y + Math.sin(a) * ring);
    }
  }

  /** Fresh ids for the flagship and each escort (unique per spawn). */
  private assignIds(f: Fleet, escorts: readonly ShipKindId[]): void {
    const gen = this.generation++;
    f.leadId = `${FLAGSHIP_BOT_ID_PREFIX}${gen}-lead`;
    f.escorts = escorts.map((kind, i) => ({ id: `${FLAGSHIP_BOT_ID_PREFIX}${gen}-e${i}`, kind }));
  }

  private pickSector(): string | null {
    const keys = [...this.rooms.keys()].filter((k) => getSector(k) !== undefined && sectorSites(k).length > 1);
    if (this.opts.firstSector !== undefined && this.rooms.has(this.opts.firstSector) && this.generation === 0) return this.opts.firstSector;
    const taken = new Set<string>();
    for (const f of this.fleets) if (f.alive && f.sectorKey !== null) taken.add(f.sectorKey);
    const free = keys.filter((k) => !taken.has(k));
    return this.pick(free.length > 0 ? free : keys) ?? null;
  }

  private pick<T>(xs: readonly T[]): T | undefined {
    return xs.length === 0 ? undefined : xs[Math.floor(this.rng() * xs.length) % xs.length];
  }

  // ── moving ────────────────────────────────────────────────────────────

  private steer(f: Fleet, nowMs: number): void {
    const room = f.sectorKey !== null ? this.rooms.get(f.sectorKey) : undefined;
    if (!room) return;
    const lead = room.getBotPose(f.leadId);
    if (!lead) return; // mid-hop or gone (the destroyed handler owns that)
    // The fleet guards the pocket it holds (owner 2026-11-11: a defender
    // "should stay close to the thing it's defending"): its capitals fight from
    // there instead of steaming off to their gun stand-off. Refreshed every
    // control tick, so a warp to a new pocket moves the post with it.
    this.guardPocket(f, room);
    // Still warping (a capital's spool + run): leave it be.
    const ph = room.botWarpPhase?.(f.leadId) ?? 0;
    if (f.escortDrop !== null && (ph !== 1 || this.flagshipNearlyAligned(f, lead))) this.sendEscorts(f, room);
    if (ph === 1 || ph === 2) return;
    this.formUp(room, f);
    // Leaving the system: once at the gate, cross.
    if (f.leavingFor !== null && nowMs >= f.nextMoveAtMs) {
      this.crossTo(f, room, f.leavingFor, nowMs);
      return;
    }
    if (nowMs >= f.nextMoveAtMs) {
      this.move(f, room, lead, nowMs);
      return;
    }
    if (nowMs >= f.nextWanderAtMs) {
      // Drift round the pocket at cruise; escorts follow.
      const site = sectorSites(f.sectorKey!).find((s) => s.id === f.pocketId);
      if (site) {
        const a = this.rng() * Math.PI * 2, r = this.rng() * site.r * 0.6;
        room.setBotFlockLeaderCourse(f.leadId, site.x + Math.cos(a) * r, site.y + Math.sin(a) * r);
      }
      f.nextWanderAtMs = nowMs + FLEET_WANDER_MS;
    }
  }

  /** Post every ship of the fleet on its current pocket (centre + radius). */
  private guardPocket(f: Fleet, room: LivingWorldRoom): void {
    if (!room.setBotGuardPost || f.sectorKey === null) return;
    if (f.guardSiteSector !== f.sectorKey || f.guardSitePocket !== f.pocketId) {
      // The pocket changed (spawn or warp): look it up once.
      // TODO: alloc-debt (sectorSites builds the list; only on a pocket change).
      f.guardSiteSector = f.sectorKey;
      f.guardSitePocket = f.pocketId;
      f.guardSite = null;
      for (const s of sectorSites(f.sectorKey)) if (s.id === f.pocketId) { f.guardSite = s; break; }
    }
    const site = f.guardSite;
    if (!site) return;
    room.setBotGuardPost(f.leadId, site.x, site.y, site.r);
    for (const e of f.escorts) room.setBotGuardPost(e.id, site.x, site.y, site.r);
  }

  /** Warp the whole fleet to another pocket (or a gate, to leave). */
  private move(f: Fleet, room: LivingWorldRoom, lead: { x: number; y: number; angle: number }, nowMs: number): void {
    const sites = sectorSites(f.sectorKey!);
    const hop = (f.moves + 1) % FLEET_SECTOR_HOP_EVERY === 0;
    let dest: SectorSite | undefined;
    if (hop) {
      const neighbours = getNeighbours(f.sectorKey!).filter((n) => this.rooms.has(n.key));
      const to = this.pick(neighbours);
      if (to) {
        dest = sites.find((s) => s.id === `gate:${to.key}`);
        if (dest) f.leavingFor = to.key;
      }
    }
    dest ??= this.pick(sites.filter((s) => s.id !== f.pocketId && s.kind !== 'gate'));
    if (!dest) return;
    const drop = warpDropPoint(dest, lead.x, lead.y);
    if (room.warpBot?.(f.leadId, drop.x, drop.y) !== true) return;
    room.setBotMoveTarget(f.leadId, drop.x, drop.y);
    // The escorts follow once the flagship has nearly turned to face the
    // jump (steer → sendEscorts), so the whole fleet goes together.
    f.escortDrop = { x: drop.x, y: drop.y };
    if (this.flagshipNearlyAligned(f, lead)) this.sendEscorts(f, room);
    f.pocketId = dest.id;
    f.moves++;
    // A gate is a short stop before crossing; a pocket is a full dwell.
    f.nextMoveAtMs = nowMs + (f.leavingFor !== null ? MOVE_SETTLE_MS : this.dwellMs + MOVE_SETTLE_MS);
    f.nextWanderAtMs = nowMs + MOVE_SETTLE_MS;
    serverLogEvent('flagship_warp', { name: f.name, sectorKey: f.sectorKey, to: dest.id });
  }

  /** True when the flagship's remaining turn to face its jump takes no longer
   *  than an escort's spool (3 s) plus one control tick. */
  private flagshipNearlyAligned(f: Fleet, lead: { x: number; y: number; angle: number }): boolean {
    const d = f.escortDrop;
    if (d === null) return true;
    const want = Math.atan2(-(d.x - lead.x), d.y - lead.y);
    const a = lead.angle;
    const off = Math.abs(Math.atan2(Math.sin(want - a), Math.cos(want - a)));
    return off / Math.max(1e-4, getShipKind(f.kind).maxAngvel) <= ESCORT_SPOOL_LEAD_S;
  }

  /** Warp the escorts to their places round the flagship's drop point. */
  private sendEscorts(f: Fleet, room: LivingWorldRoom): void {
    const drop = f.escortDrop;
    f.escortDrop = null;
    if (drop === null) return;
    for (let i = 0; i < f.escorts.length; i++) {
      const ea = (i / f.escorts.length) * Math.PI * 2;
      const ring = escortRing(f.kind, f.escorts[i]!.kind);
      room.warpBot?.(f.escorts[i]!.id, drop.x + Math.cos(ea) * ring, drop.y + Math.sin(ea) * ring);
    }
  }

  /** Cross into the neighbouring system: leave this room, arrive at its gate facing back. */
  private crossTo(f: Fleet, from: LivingWorldRoom, toKey: string, nowMs: number): void {
    const to = this.rooms.get(toKey);
    const fromKey = f.sectorKey!;
    f.leavingFor = null;
    const arrival = sectorSites(toKey).find((s) => s.id === `gate:${fromKey}`) ?? sectorSites(toKey).find((s) => s.kind === 'gate');
    if (!to || !arrival || !to.hasFreeSlot()) {
      f.nextMoveAtMs = nowMs + this.dwellMs; // try again later, from here
      return;
    }
    const escorts = f.escorts.map((e) => e.kind);
    from.despawnLivingWorldBot(f.leadId);
    for (const e of f.escorts) from.despawnLivingWorldBot(e.id);
    this.assignIds(f, escorts);
    if (!this.spawnFleetAt(f, toKey, arrival, f.kind, f.name)) {
      // Destination full after all: the fleet comes back where it was next tick.
      f.alive = false;
      f.respawnAtMs = nowMs;
      f.resume = { sectorKey: fromKey, pocketId: f.pocketId, kind: f.kind, name: f.name, moves: f.moves, escorts };
      return;
    }
    f.sectorKey = toKey;
    f.pocketId = arrival.id;
    f.nextMoveAtMs = nowMs + this.dwellMs;
    f.nextWanderAtMs = nowMs + MOVE_SETTLE_MS;
    serverLogEvent('flagship_crossed', { name: f.name, from: fromKey, to: toKey });
  }

  // ── losses ────────────────────────────────────────────────────────────

  private onShipDestroyed(id: string): void {
    for (const f of this.fleets) {
      if (!f.alive) continue;
      if (f.leadId === id) {
        // The flagship is down: the escorts break off and jump out.
        const room = f.sectorKey !== null ? this.rooms.get(f.sectorKey) : undefined;
        for (const e of f.escorts) room?.despawnLivingWorldBot(e.id);
        f.escorts = [];
        f.alive = false;
        f.respawnAtMs = this.now() + this.respawnMs;
        serverLogEvent('flagship_destroyed', { name: f.name, sectorKey: f.sectorKey });
        this.announce({ type: 'world_notice', kind: 'elite_killed', message: `The ${f.name} has been destroyed!` });
        f.sectorKey = null;
        return;
      }
      const i = f.escorts.findIndex((e) => e.id === id);
      if (i >= 0) { f.escorts.splice(i, 1); return; }
    }
  }

  private announce(notice: WorldNotice): void {
    for (const room of this.rooms.values()) room.broadcastWorldNotice?.(notice);
  }
}

/**
 * ConvoyDirector — trade between NPC bases (plan soft-leaping-truffle v3, T2).
 * Process-global, unref'd ~1 s control loop (discrete logic, never the 60 Hz
 * tick). Every galaxy room is live (rooms are created at boot and simulate when
 * empty), so each NPC base runs its real production; convoys move the goods
 * the chain needs between them.
 *
 * Planning (every `planIntervalMs`): every room reports its NPC bases' stock
 * and use/make rates; the pure `matchConvoys` decides who ships what to whom.
 *
 * One convoy = one `trader-hauler` (id prefix `hauler-convoy-`, so every
 * existing hauler rule applies — a killed hauler spills its hold):
 *   pickup   — enters the exporter's sector at the edge on the base's own
 *              side (just clear of its footprint), flies to the nearest point
 *              of the base's expanded box (fenced bases block every ship, so
 *              the dock is OUTSIDE the footprint) and loads: one atomic
 *              `tradeTransfer` take into its hold;
 *   outbound — flies back to that edge point and leaves;
 *   transit  — abstract, `hopMs` per galaxy hop (skipped in the same sector);
 *   delivery — enters the importer's sector and docks the same way; unloads:
 *              one atomic `tradeTransfer` release (overflow drops as a pod);
 *   leaving  — flies away and leaves.
 *
 * NPC bases are not persisted, so neither are convoys: on start, any convoy
 * hold left by a crash is discarded (NPC value only).
 */
import type { Bus } from '../../core/events/Bus.js';
import { emptyHold } from '../../core/cargo/hold.js';
import { matchConvoys, type BaseTradeView, type ConvoyPlan } from '../../core/economy/convoys.js';
import type { Hold, GoodId } from '../../shared-types/goods.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';
import type { HoldStore } from '../cargo/HoldStore.js';
import type { TradeTransferResult, TradeTransferSpec } from '../cargo/StorageService.js';
import { CONVOY_HAULER_ID_PREFIX } from '../livingworld/directorBotIds.js';
import { hopDistance } from '../livingworld/population.js';
import { getSector } from '../../core/galaxy/galaxy.js';
import { regionPriceFactors, type RegionBase } from '../../core/economy/regionalPrices.js';
import { setRegionalPrices } from './regionalPrices.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { guarded } from '../rooms/guardedLoop.js';

/** Ops kill switch: `EQX_DISABLE_CONVOYS=1` (also off when NPC bases are). */
export function isConvoysDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env['EQX_DISABLE_CONVOYS'];
  return v === '1' || v === 'true';
}

/** One NPC base as its room reports it. */
export interface NpcBaseTrade {
  owner: string;
  /** Uid of a storage structure in the base's network (the trade anchor). */
  networkUid: string;
  view: Omit<BaseTradeView, 'key' | 'sectorKey'>;
  /** The base's footprint box (world). */
  box: { x0: number; x1: number; y0: number; y1: number };
}

/** The room surface the convoy director drives (SectorRoom implements it). */
export interface ConvoyRoom {
  eventBus(): Bus;
  hasFreeSlot(): boolean;
  spawnLivingWorldBot(spec: { botId: string; kind: ShipKindId; x: number; y: number }): boolean;
  despawnLivingWorldBot(botId: string): unknown;
  getBotPose(botId: string): { x: number; y: number; angle: number } | null;
  setBotMoveTarget(botId: string, x: number, y: number): void;
  tradeTransfer(ownerId: string, networkUid: string, spec: TradeTransferSpec): TradeTransferResult | null;
  tradeDropAt(hold: Hold, x: number, y: number): void;
  /** T2 — this room's NPC bases. */
  npcBaseTrade(): NpcBaseTrade[];
  /** T2 — the nearest point clear of every structure (hauler spawns). */
  clearPointNear(x: number, y: number): { x: number; y: number };
}

export interface ConvoyDirectorOptions {
  controlIntervalMs: number;
  planIntervalMs: number;
  /** Abstract travel time per galaxy hop. */
  hopMs: number;
  /** A phase that runs longer than this gives up (see `timeout`). */
  phaseTimeoutMs: number;
  /** A hauler's cargo capacity (weight). */
  haulerCapacity: number;
  /** Convoys in flight across the galaxy. */
  maxActive: number;
  /** Convoy haulers flying in one sector at once. */
  maxPerSector: number;
  /** Dock this far outside a base's footprint box. */
  dockMargin: number;
  /** Arrival radius at a dock / edge point. */
  arriveRadius: number;
  /** Distance from the sector centre where haulers enter and leave. */
  edgeRadius: number;
}

export const DEFAULT_CONVOY_OPTIONS: ConvoyDirectorOptions = {
  controlIntervalMs: 1000,
  planIntervalMs: 15_000,
  hopMs: 20_000,
  phaseTimeoutMs: 240_000,
  haulerCapacity: 400,
  maxActive: 12,
  maxPerSector: 4,
  dockMargin: 250,
  arriveRadius: 300,
  edgeRadius: SECTOR_PLAYABLE_HALF_EXTENT * 0.9,
};

type Phase = 'pickup' | 'outbound' | 'transit' | 'delivery' | 'leaving';

interface Convoy {
  id: string;
  haulerId: string;
  plan: ConvoyPlan;
  fromSector: string;
  toSector: string;
  from: { owner: string; uid: string; box: NpcBaseTrade['box'] };
  to: { owner: string; uid: string; box: NpcBaseTrade['box'] };
  phase: Phase;
  /** The sector the hauler is currently in (null while in transit). */
  inSector: string | null;
  phaseAtMs: number;
  transitUntilMs: number;
  target: { x: number; y: number };
}

/** Nearest point of `box` expanded by `m` to (x, y) — a dock outside the base. */
export function dockPoint(box: NpcBaseTrade['box'], m: number, x: number, y: number): { x: number; y: number } {
  const x0 = box.x0 - m, x1 = box.x1 + m, y0 = box.y0 - m, y1 = box.y1 + m;
  let px = Math.min(Math.max(x, x0), x1);
  let py = Math.min(Math.max(y, y0), y1);
  if (px > x0 && px < x1 && py > y0 && py < y1) {
    // Inside: push to the nearest side.
    const d = [px - x0, x1 - px, py - y0, y1 - py];
    const i = d.indexOf(Math.min(...d));
    if (i === 0) px = x0; else if (i === 1) px = x1; else if (i === 2) py = y0; else py = y1;
  }
  return { x: px, y: py };
}

/**
 * Where a hauler enters and leaves a sector for this base: the edge point on
 * the base's own side (haulers fly ~40 u/s, so a far-side entry made every leg
 * minutes long), stepped back toward the centre until it is `clear` u outside
 * the footprint box (a base can reach the edge; never spawn inside its fence).
 */
export function edgeNear(box: NpcBaseTrade['box'], r: number, clear: number): { x: number; y: number } {
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const len = Math.hypot(cx, cy);
  const dx = len < 1 ? 1 : cx / len, dy = len < 1 ? 0 : cy / len;
  const outside = (x: number, y: number): boolean =>
    x < box.x0 - clear || x > box.x1 + clear || y < box.y0 - clear || y > box.y1 + clear;
  for (let d = r; d >= 0; d -= 200) {
    if (outside(dx * d, dy * d)) return { x: dx * d, y: dy * d };
  }
  // The box covers the whole ray (a base around the centre): its nearest side.
  return dockPoint(box, clear, 0, 0);
}

export class ConvoyDirector {
  private readonly convoys = new Map<string, Convoy>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPlanMs = -Infinity;
  private seq = 0;
  private readonly subs: Array<{ bus: Bus; fn: (e: { type: 'ENTITY_DESTROYED'; entityId: string }) => void }> = [];

  constructor(
    private readonly rooms: Map<string, ConvoyRoom>,
    private readonly holds: HoldStore,
    private readonly opts: ConvoyDirectorOptions = DEFAULT_CONVOY_OPTIONS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Discard convoy holds a crash left behind, subscribe, start the loop. */
  start(): void {
    for (const r of this.holds.ofType('hauler')) {
      if (r.holderUid.startsWith(CONVOY_HAULER_ID_PREFIX)) this.holds.delete(r.holderUid);
    }
    for (const room of this.rooms.values()) {
      const bus = room.eventBus();
      const fn = (e: { type: 'ENTITY_DESTROYED'; entityId: string }): void => {
        if (e.entityId.startsWith(CONVOY_HAULER_ID_PREFIX)) this.onDestroyed(e.entityId);
      };
      bus.on('ENTITY_DESTROYED', fn);
      this.subs.push({ bus, fn });
    }
    this.timer = setInterval(guarded('convoy-director', () => this.tick()), this.opts.controlIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const { bus, fn } of this.subs) bus.off('ENTITY_DESTROYED', fn);
    this.subs.length = 0;
  }

  /** Diagnostics (`GET /dev/convoys`): every convoy with its hauler's live
   *  pose and its current target. */
  debugView(): Array<Record<string, unknown>> {
    const now = this.now();
    return [...this.convoys.values()].map((c) => {
      const room = c.inSector !== null ? this.rooms.get(c.inSector) : undefined;
      const pose = room?.getBotPose(c.haulerId) ?? null;
      return {
        haulerId: c.haulerId, phase: c.phase, inSector: c.inSector, from: c.plan.from, to: c.plan.to,
        good: c.plan.good, qty: c.plan.qty, phaseAgeMs: now - c.phaseAtMs,
        pose: pose ? { x: Math.round(pose.x), y: Math.round(pose.y) } : null,
        target: { x: Math.round(c.target.x), y: Math.round(c.target.y) },
        dist: pose ? Math.round(Math.hypot(pose.x - c.target.x, pose.y - c.target.y)) : null,
      };
    });
  }

  /** Convoys in flight (tests / diagnostics). */
  active(): ReadonlyArray<{ id: string; haulerId: string; phase: Phase; from: string; to: string; good: GoodId; qty: number; inSector: string | null }> {
    return [...this.convoys.values()].map((c) => ({
      id: c.id, haulerId: c.haulerId, phase: c.phase, from: c.plan.from, to: c.plan.to, good: c.plan.good, qty: c.plan.qty, inSector: c.inSector,
    }));
  }

  /** One control step: advance every convoy, re-plan on cadence. */
  tick(): void {
    const now = this.now();
    for (const c of [...this.convoys.values()]) this.advance(c, now);
    if (now - this.lastPlanMs >= this.opts.planIntervalMs) {
      this.lastPlanMs = now;
      this.plan(now);
    }
  }

  private plan(now: number): void {
    const views = this.collect();
    // T3 — the regional price factors follow the same stock and rates.
    const regional: RegionBase[] = [];
    for (const v of views) {
      const region = getSector(v.sectorKey)?.region;
      if (region !== undefined) regional.push({ region, stock: v.stock, uses: v.uses });
    }
    setRegionalPrices(regionPriceFactors(regional));
    if (this.convoys.size >= this.opts.maxActive) return;
    const plans = this.match(views);
    for (const p of plans) {
      const from = this.bases.get(p.from)!, to = this.bases.get(p.to)!;
      this.launch(p, from.sectorKey, from.base, to.sectorKey, to.base, now);
    }
  }

  /** Every room's NPC bases as planning views (last pass kept in `bases`). */
  private readonly bases = new Map<string, { sectorKey: string; base: NpcBaseTrade }>();

  private collect(): BaseTradeView[] {
    this.bases.clear();
    const views: BaseTradeView[] = [];
    for (const [sectorKey, room] of this.rooms) {
      for (const b of room.npcBaseTrade()) {
        const key = `${sectorKey}|${b.owner}`;
        views.push({ key, sectorKey, ...b.view });
        this.bases.set(key, { sectorKey, base: b });
      }
    }
    return views;
  }

  private match(raw: readonly BaseTradeView[]): ConvoyPlan[] {
    // Goods promised to convoys that haven't loaded yet aren't spare.
    const promised = new Map<string, number>();
    for (const c of this.convoys.values()) {
      if (c.phase !== 'pickup') continue;
      const k = `${c.plan.from}|${c.plan.good}`;
      promised.set(k, (promised.get(k) ?? 0) + c.plan.qty);
    }
    const views = raw.map((v) => {
      const stock = { ...v.stock };
      for (const g of Object.keys(stock) as GoodId[]) {
        const p = promised.get(`${v.key}|${g}`);
        if (p !== undefined) stock[g] = Math.max(0, (stock[g] ?? 0) - p);
      }
      return { ...v, stock };
    });
    const inFlight = new Set<string>();
    for (const c of this.convoys.values()) inFlight.add(`${c.plan.to}|${c.plan.good}`);
    return matchConvoys(views, {
      haulerCapacity: this.opts.haulerCapacity,
      maxConvoys: this.opts.maxActive - this.convoys.size,
      hops: hopDistance,
      inFlight,
    });
  }

  private inSectorCount(sectorKey: string): number {
    let n = 0;
    for (const c of this.convoys.values()) if (c.inSector === sectorKey) n++;
    return n;
  }

  /** Spawn a hauler at the edge facing away from `box`. Null when it can't. */
  private enter(sectorKey: string, haulerId: string, box: NpcBaseTrade['box']): { x: number; y: number } | null {
    const room = this.rooms.get(sectorKey);
    if (!room || !room.hasFreeSlot() || this.inSectorCount(sectorKey) >= this.opts.maxPerSector) return null;
    const edge = edgeNear(box, this.opts.edgeRadius, this.opts.dockMargin + 300);
    const at = room.clearPointNear(edge.x, edge.y);
    return room.spawnLivingWorldBot({ botId: haulerId, kind: 'trader-hauler', x: at.x, y: at.y }) ? at : null;
  }

  private launch(plan: ConvoyPlan, fromSector: string, from: NpcBaseTrade, toSector: string, to: NpcBaseTrade, now: number): void {
    const id = `${now.toString(36)}${(this.seq++).toString(36)}`;
    const haulerId = `${CONVOY_HAULER_ID_PREFIX}${id}`;
    const at = this.enter(fromSector, haulerId, from.box);
    if (at === null) return;
    const c: Convoy = {
      id, haulerId, plan, fromSector, toSector,
      from: { owner: from.owner, uid: from.networkUid, box: from.box },
      to: { owner: to.owner, uid: to.networkUid, box: to.box },
      phase: 'pickup', inSector: fromSector, phaseAtMs: now, transitUntilMs: 0,
      target: dockPoint(from.box, this.opts.dockMargin, at.x, at.y),
    };
    this.convoys.set(id, c);
    serverLogEvent('convoy_launch', { haulerId, from: plan.from, to: plan.to, good: plan.good, qty: plan.qty });
  }

  private setPhase(c: Convoy, phase: Phase, now: number): void {
    c.phase = phase;
    c.phaseAtMs = now;
  }

  private advance(c: Convoy, now: number): void {
    if (c.phase === 'transit') {
      if (now < c.transitUntilMs) return;
      const at = this.enter(c.toSector, c.haulerId, c.to.box);
      if (at === null) { c.transitUntilMs = now + 5_000; return; } // sector busy: wait
      c.inSector = c.toSector;
      c.target = dockPoint(c.to.box, this.opts.dockMargin, at.x, at.y);
      this.setPhase(c, 'delivery', now);
      return;
    }
    const room = c.inSector !== null ? this.rooms.get(c.inSector) : undefined;
    if (!room) { this.finish(c, false); return; }
    const pose = room.getBotPose(c.haulerId);
    if (pose === null) return; // destroyed — the bus handler finishes it
    const arrived = Math.hypot(pose.x - c.target.x, pose.y - c.target.y) <= this.opts.arriveRadius;
    const timedOut = now - c.phaseAtMs >= this.opts.phaseTimeoutMs;
    if (!arrived && !timedOut) {
      room.setBotMoveTarget(c.haulerId, c.target.x, c.target.y);
      return;
    }
    switch (c.phase) {
      case 'pickup': {
        if (!arrived) { this.leave(c, room); return; } // never reached the base
        const want = emptyHold();
        want.goods[c.plan.good] = c.plan.qty;
        const res = room.tradeTransfer(c.from.owner, c.from.uid, { take: { want, intoUid: c.haulerId, intoOwner: null } });
        const got = res?.taken.goods[c.plan.good] ?? 0;
        if (got <= 0) { this.holds.delete(c.haulerId); this.depart(c, now); return; } // nothing to carry
        serverLogEvent('convoy_loaded', { haulerId: c.haulerId, good: c.plan.good, qty: got });
        if (c.toSector === c.fromSector) {
          c.target = dockPoint(c.to.box, this.opts.dockMargin, pose.x, pose.y);
          this.setPhase(c, 'delivery', now);
        } else {
          c.target = edgeNear(c.from.box, this.opts.edgeRadius, this.opts.dockMargin + 300);
          this.setPhase(c, 'outbound', now);
        }
        return;
      }
      case 'outbound': {
        room.despawnLivingWorldBot(c.haulerId);
        c.inSector = null;
        c.transitUntilMs = now + Math.max(1, hopDistance(c.fromSector, c.toSector)) * this.opts.hopMs;
        this.setPhase(c, 'transit', now);
        return;
      }
      case 'delivery': {
        const res = room.tradeTransfer(c.to.owner, c.to.uid, { release: [c.haulerId] });
        if (res === null) {
          // The importer is gone: the cargo drops where the hauler is.
          const h = this.holds.get(c.haulerId)?.hold;
          if (h) room.tradeDropAt(h, pose.x, pose.y);
          this.holds.delete(c.haulerId);
        } else if (res.overflow.goods && Object.keys(res.overflow.goods).length > 0) {
          room.tradeDropAt(res.overflow, c.target.x, c.target.y);
        }
        serverLogEvent('convoy_delivered', { haulerId: c.haulerId, to: c.plan.to, good: c.plan.good, timedOut: !arrived });
        this.depart(c, now);
        return;
      }
      case 'leaving':
        this.leave(c, room);
        return;
    }
  }

  /** Head for the edge, away from the base it's at. */
  private depart(c: Convoy, now: number): void {
    const box = c.phase === 'pickup' ? c.from.box : c.to.box;
    c.target = edgeNear(box, this.opts.edgeRadius, this.opts.dockMargin + 300);
    this.setPhase(c, 'leaving', now);
  }

  private leave(c: Convoy, room: ConvoyRoom): void {
    room.despawnLivingWorldBot(c.haulerId);
    this.finish(c, true);
  }

  private finish(c: Convoy, clean: boolean): void {
    // A hauler leaving with cargo still aboard (it never unloaded): NPC value
    // only — discard it rather than leak a hold row.
    if (clean && this.holds.get(c.haulerId) !== undefined) this.holds.delete(c.haulerId);
    this.convoys.delete(c.id);
  }

  private onDestroyed(haulerId: string): void {
    for (const c of this.convoys.values()) {
      if (c.haulerId !== haulerId) continue;
      // The room's kill path already spilled the hold where it died.
      serverLogEvent('convoy_raided', { haulerId, from: c.plan.from, to: c.plan.to, good: c.plan.good });
      this.convoys.delete(c.id);
      return;
    }
  }
}

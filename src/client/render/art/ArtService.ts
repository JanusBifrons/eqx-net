/**
 * Machined art — the renderer's art service (plan iridescent-seeking-rainbow, A2).
 *
 * The renderer asks for art by kind and gets a HANDLE back at once. The
 * handle starts `pending`; the bake runs off the main path (worker pool, or
 * inline as a fallback), lands in the cross-session cache, and is packed into
 * the atlas within a per-frame time budget, at which point the handle turns
 * `ready`. A sprite keeps drawing today's look until then, so nothing ever
 * waits on a bake.
 *
 * Handles are created once per distinct (kind, paint, seed, turn, sun) and
 * reused, so a sprite holds its handle and checks it each frame without
 * allocating (invariant #14).
 */
import { Rectangle, Texture } from 'pixi.js';
import { FX_SPECS, isFxId, type FxId, type FxSpec } from './fx/fxTextures.js';
import { Atlas, type AtlasOpts } from './atlas.js';
import { bakeKey, runBake, seedVariant, type Baked, type BakeJob } from './bake.js';
import { loadBakes, saveBakes, storeKey } from './bakeStore.js';
import type { Frame, LightRig } from './shade.js';
import { sunRigForSector } from './sunRig.js';
import { shipScaleWorkerName } from '../../../shared-types/shipScale/config.js';

export type ArtState = 'pending' | 'ready' | 'failed';

export interface ShipArt {
  /** One frame per baked sun angle (SUN_STEPS), cross-faded at run time;
   *  with tiles, sun-major (`sun * tiles + tile`). */
  frames: Texture[];
  w: number;
  h: number;
  /** Tiles per sun frame along the hull (1 = untiled), and rows per tile. */
  tiles: number;
  tileH: number;
  /** Texels per world unit: a sprite's scale is 1 / density. */
  density: number;
  nozzles: Baked['nozzles'];
  navLights: Baked['navLights'];
}

export interface StructArt {
  tex: Texture;
  /** Unlit copy at half resolution: what blast light lifts. */
  albedo: Texture;
  w: number;
  h: number;
  density: number;
  navLights: Baked['navLights'];
}

/** An effect or backdrop texture; `frames` holds a flipbook's cells (else [tex]). */
export interface FxArt {
  tex: Texture;
  frames: Texture[];
  w: number;
  h: number;
}

export interface ArtHandle {
  readonly key: string;
  readonly job: BakeJob;
  /** The sun it is baked under (the sector's when it was requested). */
  readonly rig: LightRig;
  state: ArtState;
  ship: ShipArt | null;
  struct: StructArt | null;
  fx?: FxArt | null;
  /** Why it failed (bake error, too big, over the memory budget). */
  reason?: string;
  /** Atlas group: 0 for effect textures (shared by every sector), otherwise
   *  the sector visit it was requested in. */
  group?: number;
  /** Replaced or released by `collect`: ask the service for this art again. */
  stale?: boolean;
  /** Its replacement in the current group (set when re-homed). */
  next?: ArtHandle;
  /** For a replacement: the original it re-homes (restored if it won't fit). */
  prev?: ArtHandle;
  /** A re-home of it didn't fit: don't retry until pages are freed. */
  stuck?: boolean;
}

/** Packs frames into GPU pages. `Atlas` in the game; a fake in tests. */
export interface ArtPacker {
  /** Would these frames fit, still leaving `reservePages` pages unopened? */
  canFit(frames: readonly Frame[], reservePages?: number): boolean;
  add(fr: Frame, out: Texture[], idx: number): boolean;
  commit(): void;
  /** A texture outside the pages (wrapping textures). */
  standalone(fr: Frame, repeat: boolean, mip: boolean): Texture;
  readonly pageCount: number;
  /** The most pages the budget allows (undefined: no cap). */
  readonly maxPageCount?: number;
  /** Pack into this group's pages from now on (see Atlas.setGroup). */
  setGroup?(group: number): void;
  /** Free a group's pages and textures; returns pages freed. */
  freeGroup?(group: number): number;
  readonly gpuBytes: number;
  destroy(): void;
}

/** Runs bakes somewhere other than the caller's stack. */
export interface BakeRunner {
  /** `urgent`: something on screen is waiting for it, so it goes ahead of
   *  queued warm-up work. */
  run(job: BakeJob, rig: LightRig, urgent?: boolean): Promise<Baked>;
  /** Move a queued (not yet started) job to the front. */
  promote?(job: BakeJob): void;
  readonly workers: number;
  destroy(): void;
}

export interface BakeCache {
  load(keys: string[]): Promise<Map<string, Baked>>;
  save(entries: Array<[string, Baked]>): Promise<void>;
}

export interface ArtServiceDeps {
  packer: ArtPacker;
  runner: BakeRunner;
  cache: BakeCache | null;
  now: () => number;
  /** Most ms per `tick()` spent packing (at least one bake is packed). */
  packBudgetMs: number;
  /** Bakes in flight, by store key, shared across services: joining the game
   *  replaces the galaxy map's renderer (and its service), and the new one
   *  picks up a bake the old one started instead of re-running it. */
  inflight?: Map<string, Promise<Baked>>;
  /** False when the runner is shared (page-lifetime worker pool): destroying
   *  this service leaves it running. Default true. */
  ownsRunner?: boolean;
}

export interface ArtStats {
  ready: number;
  pending: number;
  failed: number;
  fromCache: number;
  pages: number;
  gpuBytes: number;
  workers: number;
  /** Effect textures ready / still baking. */
  fxReady: number;
  fxPending: number;
  /** The most recent failure (job key and reason), for diagnosis. */
  lastFailure?: string;
  /** Diagnostic: the art kinds using the most packed texels. */
  topTexels?: string[];
  /** Diagnostic: atlas page (re)uploads so far, and the texels they sent. */
  /** Diagnostic: atlas pages freed by `collect`, and the page budget. */
  freedPages?: number;
  maxPages?: number;
  /** Current art visit, and what pinned a past one at the last collect. */
  visit?: number;
  pins?: string[];
  /** Failed bakes by art type (diagnostic). */
  failedKinds?: Record<string, number>;
  uploads?: number;
  uploadTexels?: number;
}

/** Defaults by device: phones get small pages and a tight page budget. */
/**
 * The atlas budget for this device. Pages are 2048² (16 MB each with mips).
 * Desktop: 16 pages. Phones: by the memory the device reports
 * (`navigator.deviceMemory`, GB, capped at 8 by the browser): a budget too
 * small left base-heavy sectors drawing bare art (phone run 2026-11-07); too
 * big risks a low-memory phone. Unknown memory keeps the old 6 pages.
 */
export function atlasOptsFor(touch: boolean, deviceMemoryGb?: number): AtlasOpts {
  if (touch) {
    const gb = deviceMemoryGb;
    // Chrome reports only 0.25/0.5/1/2/4/8 GB (4 = "4 to 8 GB") and hides it
    // on plain-http pages; iPhones never report it. Unknown is the common
    // case, so it gets the full phone budget (phone run 2026-11-07: the old
    // 6-page fallback left a base-heavy sector's asteroids bare).
    const pages = gb === undefined || !Number.isFinite(gb) ? 14 : gb < 2 ? 4 : gb < 4 ? 6 : gb < 8 ? 10 : 14;
    return { pageSize: 2048, maxPages: pages };
  }
  // Desktop: the same 64M-texel budget as 16 pages of 2048² (was 4 of 4096²).
  // Adding art re-uploads its WHOLE page (+ mips): a 4096² page is ~64 MB per
  // upload, a visible GPU stall (~0.4 s on integrated graphics) whenever new
  // art lands, e.g. flying into a new sector (Phase 4 travel state, 2026-11-07).
  return { pageSize: 2048, maxPages: 16 };
}

/** Cut a flipbook sheet texture into its cells (same source, so they batch). */
export function flipCells(sheet: Texture, flip: NonNullable<FxSpec['flip']>): Texture[] {
  const out: Texture[] = [];
  const f = sheet.frame;
  const ch = f.height / Math.ceil(flip.frames / flip.cols);
  for (let i = 0; i < flip.frames; i++) {
    // Cells can be non-square (fence strips): height = sheet height / rows.
    // Inset 1 texel so linear filtering never bleeds a neighbouring cell in.
    out.push(new Texture({ source: sheet.source, frame: new Rectangle(f.x + (i % flip.cols) * flip.cell + 1, f.y + Math.floor(i / flip.cols) * ch + 1, flip.cell - 2, ch - 2) }));
  }
  return out;
}

/** Why a bake that didn't fit failed (collect retries these after a free). */
const OVER_BUDGET = 'over the texture memory budget';
/** Art re-packed per `collect` (each re-uploads a page; keep it gentle). */
const REHOME_PER_COLLECT = 8;

export class ArtService {
  private readonly handles = new Map<string, ArtHandle>();
  /** Finished bakes waiting to be packed, oldest first. */
  private readonly toPack: Array<{ h: ArtHandle; b: Baked; cached: boolean }> = [];
  private rig: LightRig = sunRigForSector(null);
  private rigTag = rigTag(this.rig);
  private fromCache = 0;
  /** Packed texels by art kind (diagnostic; see `stats().topTexels`). */
  private readonly texels = new Map<string, number>();
  private destroyed = false;

  constructor(private readonly deps: ArtServiceDeps) {}

  /** The sector changed: new requests are lit by its sun. Art already baked
   *  for other suns stays usable until it's released. */
  setSector(sectorKey: string | null): void {
    const rig = sunRigForSector(sectorKey);
    const tag = rigTag(rig);
    if (tag === this.rigTag) return;
    this.rig = rig;
    this.rigTag = tag;
    this.gen++;
  }

  /**
   * The player entered another sector. New art goes into fresh atlas pages
   * (a new group), so the pages of the sectors left behind can be freed whole
   * once nothing draws them (`collect`).
   */
  newVisit(): void { this.gen++; }

  /** The current group of new lit art (one per sector visit). */
  private gen = 1;
  /** Re-homed handles whose old art a sprite may still show. */
  private readonly retired: ArtHandle[] = [];

  /**
   * Give older visits' texture space back. `inUse`: every handle a sprite or
   * gun holds right now; `shown`: the art sprites actually display (a sprite
   * keeps its old art until a replacement is ready).
   *
   *  - A past visit's group that nothing holds or shows is freed whole.
   *  - When the budget is tight, art from a past visit that is still in use is
   *    re-packed into the current group (from the bake cache, no re-bake); the
   *    sprites swap to it when ready, and the old group is then freed.
   *  - After pages are freed, art that failed for space is asked for again.
   *
   * Effect textures (group 0) are never freed. Returns the pages freed.
   * Phone report 2026-11-07: art from every sector visited filled a phone's
   * few pages, so ~67 bakes failed in base-heavy sectors.
   */
  collect(inUse: ReadonlySet<ArtHandle>, shown?: ReadonlySet<object>): number {
    const live = this.liveGroups;
    live.clear();
    for (const h of inUse) if (h.group !== undefined) live.add(h.group);
    if (shown && shown.size > 0) {
      for (const h of this.handles.values()) this.noteShown(h, shown, live);
      for (const h of this.retired) this.noteShown(h, shown, live);
    }
    // Diagnostic: what keeps a past visit's pages alive.
    this.pins.length = 0;
    for (const h of inUse) if ((h.group ?? 0) !== 0 && (h.group ?? 0) < this.gen && this.pins.length < 8) this.pins.push(`use:${h.key}${h.stale ? '*' : ''}`);
    if (shown) for (const h of this.retired) { const a = h.ship ?? h.struct; if (a && shown.has(a) && this.pins.length < 8) this.pins.push(`shown:${h.key}`); }
    const dead = this.deadGroups;
    dead.clear();
    for (const h of this.handles.values()) this.noteDead(h, live, dead);
    for (const h of this.retired) this.noteDead(h, live, dead);
    let freed = 0;
    if (dead.size > 0) {
      for (const [key, h] of this.handles) {
        if (!dead.has(h.group ?? 0)) continue;
        this.handles.delete(key);
        this.urgentKeys.delete(key);
        this.ownKeys.delete(key);
        h.stale = true;
      }
      for (let i = this.retired.length - 1; i >= 0; i--) if (dead.has(this.retired[i]!.group ?? 0)) this.retired.splice(i, 1);
      for (const g of dead) freed += this.deps.packer.freeGroup?.(g) ?? 0;
    }
    // Art from a past visit that is still drawn pins that visit's pages, so
    // move it into the current visit right away (phone run 2026-11-07: the
    // pilot's own ship and guns pinned Sol Prime's pages for the whole trip;
    // waiting until the budget was full left no room to move them, and Vega
    // Reach's asteroids failed). Mid-trip that is only the pilot's own ship.
    if (this.deps.packer.freeGroup) {
      let moves = 0;
      for (const [key, h] of this.handles) {
        if (moves >= REHOME_PER_COLLECT) break;
        const g = h.group ?? 0;
        if (g === 0 || g >= this.gen || h.stale || h.stuck || h.state !== 'ready') continue;
        const art = h.ship ?? h.struct;
        if (!inUse.has(h) && !(art && shown?.has(art))) continue;
        const n: ArtHandle = { key, job: h.job, rig: h.rig, state: 'pending', ship: null, struct: null, group: this.gen, prev: h };
        h.stale = true;
        h.next = n;
        this.retired.push(h);
        this.handles.set(key, n);
        this.urgentKeys.add(key);
        void this.start(n, true);
        moves++;
      }
    }
    if (freed > 0) {
      for (const h of this.handles.values()) h.stuck = false;
      for (const [key, h] of this.handles) {
        if (h.state !== 'failed' || h.reason !== OVER_BUDGET) continue;
        this.handles.delete(key);
        h.stale = true;
      }
    }
    return freed;
  }
  /** Undo a re-home whose copy didn't fit: the original serves again. */
  private restore(n: ArtHandle): void {
    const old = n.prev!;
    old.stale = false;
    old.next = undefined;
    old.stuck = true;
    const i = this.retired.indexOf(old);
    if (i >= 0) this.retired.splice(i, 1);
    if (this.handles.get(n.key) === n) this.handles.set(n.key, old);
    n.stale = true;
    n.next = old;
  }
  private noteShown(h: ArtHandle, shown: ReadonlySet<object>, live: Set<number>): void {
    const a = h.ship ?? h.struct;
    if (a && h.group !== undefined && shown.has(a)) live.add(h.group);
  }
  private noteDead(h: ArtHandle, live: Set<number>, dead: Set<number>): void {
    const g = h.group ?? 0;
    if (g !== 0 && g < this.gen && !live.has(g)) dead.add(g);
  }
  private readonly liveGroups = new Set<number>();
  /** Diagnostic (stats): handles pinning a past visit at the last collect. */
  private readonly pins: string[] = [];
  private readonly deadGroups = new Set<number>();

  get lightRig(): LightRig { return this.rig; }

  /** `rings`: cut turret rings into the hull at its mounts (new effects). */
  ship(id: string, paint?: number, urgent = true, rings = false): ArtHandle {
    return this.acquire(rings ? { type: 'ship', id, paint, rings } : { type: 'ship', id, paint }, urgent);
  }

  struct(id: string, seed: number, rot = 0, accent?: number, urgent = true, rings = false): ArtHandle {
    return this.acquire(rings
      ? { type: 'struct', id, seed: seedVariant(seed), rot, accent, rings }
      : { type: 'struct', id, seed: seedVariant(seed), rot, accent }, urgent);
  }

  /** Queue background bakes for art the player is likely to see soon (see
   *  warmUp.ts), behind anything on screen. Called when the renderer starts,
   *  i.e. on the galaxy map / warp screen, so the swap from today's look is
   *  rarely visible in play. */
  warmUp(jobs: readonly BakeJob[]): void {
    for (const j of jobs) this.acquire(j, false);
  }

  /** One component of a destroyed ship (tumbles: ship-style frames). */
  /** An effect or backdrop texture (art/fx/fxTextures.ts). */
  fx(id: FxId, variant?: string, seed?: number, urgent = true): ArtHandle {
    return this.acquire({ type: 'fx', id, ...(variant !== undefined ? { variant } : {}), ...(seed !== undefined ? { seed } : {}) }, urgent);
  }

  scrap(parentKind: string, component: number): ArtHandle {
    return this.acquire({ type: 'scrap', id: parentKind, component });
  }

  /** An asteroid by its seeded outline (static: one frame at its turn). */
  rock(entityId: number, radius: number, resource: string | undefined, rot: number): ArtHandle {
    return this.acquire({ type: 'rock', id: 'asteroid', entityId, radius, resource, rot });
  }

  /** The handle for a job: an existing one if any, else a new pending one
   *  whose bake starts now. */
  acquire(job: BakeJob, urgent = true): ArtHandle {
    // Effect textures aren't lit by the sector's sun: one bake serves every
    // sector (a sky prepared during a transit's spool is the one used after
    // the switch, so its upload doesn't land mid-trip).
    const key = job.type === 'fx' ? bakeKey(job) : `${bakeKey(job)}|${this.rigTag}`;
    let h = this.handles.get(key);
    if (h) {
      // A warm-up bake still queued: something now needs it, so move it up.
      if (urgent && h.state === 'pending' && !this.urgentKeys.has(key)) {
        this.urgentKeys.add(key);
        this.deps.runner.promote?.(h.job);
      }
      return h;
    }
    h = { key, job, rig: this.rig, state: 'pending', ship: null, struct: null, group: job.type === 'fx' ? 0 : this.gen };
    this.handles.set(key, h);
    if (urgent) this.urgentKeys.add(key);
    void this.start(h, urgent);
    return h;
  }

  /** Handles something on screen asked for (vs warm-up only). */
  private readonly urgentKeys = new Set<string>();
  /** The pilot's own ship: always textured, even past the budget (its own
   *  texture outside the pages; one small ship). */
  private readonly ownKeys = new Set<string>();

  private async start(h: ArtHandle, urgent: boolean): Promise<void> {
    const sk = storeKey(bakeKey(h.job), h.rig);
    try {
      // Another service (the galaxy map's, before joining) is already baking it.
      const shared = this.deps.inflight?.get(sk);
      if (shared) {
        if (urgent) this.deps.runner.promote?.(h.job);
        const b = await shared;
        if (this.destroyed) return;
        this.toPack.push({ h, b, cached: false });
        return;
      }
      const hit = this.deps.cache ? (await this.deps.cache.load([sk])).get(sk) : undefined;
      if (this.destroyed) return;
      if (hit) { this.toPack.push({ h, b: hit, cached: true }); return; }
      const run = this.deps.runner.run(h.job, h.rig, urgent || this.urgentKeys.has(h.key));
      // Save as soon as it is baked (not when packed), so a bake whose service
      // is gone by then still reaches the cache; keep it findable until saved.
      const inflight = this.deps.inflight, cache = this.deps.cache;
      inflight?.set(sk, run);
      void run
        .then((b) => cache?.save([[sk, b]]))
        .catch(() => { /* a failed bake is reported on its handle below */ })
        .finally(() => { if (inflight?.get(sk) === run) inflight.delete(sk); });
      const b = await run;
      if (this.destroyed) return;
      this.toPack.push({ h, b, cached: false });
    } catch (e) {
      h.state = 'failed';
      h.reason = `bake failed: ${String(e)}`;
    }
  }

  /** Pack finished bakes into the atlas, within the per-frame budget. Call
   *  once per rendered frame. */
  tick(): void {
    if (this.toPack.length === 0) return;
    const t0 = this.deps.now();
    let packed = 0;
    while (this.toPack.length > 0) {
      if (packed > 0 && this.deps.now() - t0 >= this.deps.packBudgetMs) break;
      const { h, b, cached } = this.toPack.shift()!;
      if (!this.pack(h, b)) continue;
      packed++;
      {
        // Texture use by kind of art (capital R&D: which bakes fill the budget).
        const k = h.job.type === 'ship' || h.job.type === 'turret' || h.job.type === 'struct' ? `${h.job.type}:${h.job.id}` : h.job.type;
        let px = 0;
        for (const fr of b.frames) px += fr.w * fr.h;
        this.texels.set(k, (this.texels.get(k) ?? 0) + px);
      }
      // Fresh bakes were saved when they finished (see `start`).
      if (cached) this.fromCache++;
    }
    // Upload, then hand out the textures: a handle turns `ready` only here.
    if (packed > 0) { this.deps.packer.commit(); this.flushFills(); }
  }

  /** Place a bake's frames; false (handle failed) if it won't fit the budget. */
  private pack(h: ArtHandle, b: Baked): boolean {
    const packer = this.deps.packer;
    // Released by `collect` while it was baking: nothing wants it.
    if (this.handles.get(h.key) !== h) return false;
    // A bake asked for in a past visit lands in this one (not the old pages).
    if (h.group !== undefined && h.group !== 0 && h.group < this.gen) h.group = this.gen;
    packer.setGroup?.(h.group ?? 0);
    if (h.job.type === 'fx') return this.packFx(h, h.job.id, b);
    // Warm-up bakes are a guess: they may only use half the budget, so art
    // something on screen needs always has room (phone report 2026-11-07: the
    // warm-up filled a phone's 6 pages and the pilot's own ship drew bare).
    // One that doesn't fit is dropped, not failed: asking for it later bakes it.
    if ((b.tiles ?? 1) <= 1 && !this.urgentKeys.has(h.key)) {
      const max = packer.maxPageCount;
      const reserve = max !== undefined && Number.isFinite(max) ? Math.ceil(max / 2) : 0;
      if (!packer.canFit(b.frames, reserve)) {
        this.handles.delete(h.key);
        return false;
      }
    }
    // The pilot's own ship never goes bare: past the budget it gets textures
    // of its own (phone report 2026-11-07, "the ship isn't textured").
    const ownOverflow = (b.tiles ?? 1) <= 1 && this.ownKeys.has(h.key) && !packer.canFit(b.frames);
    if (!ownOverflow && (b.tiles ?? 1) <= 1 && !packer.canFit(b.frames)) {
      // A re-homed copy that won't fit: keep using the original.
      if (h.prev) { this.restore(h); return false; }
      h.state = 'failed';
      h.reason = OVER_BUDGET;
      return false;
    }
    const tex: Texture[] = [];
    // Tiled capital frames get their own textures: tall frames waste most of
    // an atlas shelf (capital-ship R&D round 2 finding).
    if ((b.tiles ?? 1) > 1 || ownOverflow) for (let i = 0; i < b.frames.length; i++) tex[i] = packer.standalone(b.frames[i]!, false, false);
    else for (let i = 0; i < b.frames.length; i++) packer.add(b.frames[i]!, tex, i);
    // Textures resolve on commit (end of this tick); fill the handle then.
    this.pendingFill.push(() => {
      if (h.job.type === 'ship' || h.job.type === 'scrap' || h.job.type === 'turret') {
        h.ship = { frames: tex, w: b.w, h: b.h, tiles: b.tiles ?? 1, tileH: b.tileH ?? b.h, density: b.density, nozzles: b.nozzles, navLights: b.navLights };
      } else {
        h.struct = { tex: tex[0]!, albedo: tex[1]!, w: b.w, h: b.h, density: b.density, navLights: b.navLights };
      }
      h.state = 'ready';
      h.prev = undefined;
    });
    return true;
  }

  /** Effects: wrapping textures get their own; the rest share the atlas,
   *  and a flipbook sheet is cut into its cells. */
  private packFx(h: ArtHandle, id: string, b: Baked): boolean {
    const spec = isFxId(id) ? FX_SPECS[id] : null;
    const fr = b.frames[0];
    if (!spec || !fr) { h.state = 'failed'; h.reason = 'unknown effect texture'; return false; }
    if (spec.tile) {
      const tex = this.deps.packer.standalone(fr, true, spec.mip === true);
      this.pendingFill.push(() => { h.fx = { tex, frames: [tex], w: fr.w, h: fr.h }; h.state = 'ready'; });
      return true;
    }
    if (!this.deps.packer.canFit(b.frames)) { h.state = 'failed'; h.reason = OVER_BUDGET; return false; }
    const out: Texture[] = [];
    this.deps.packer.add(fr, out, 0);
    this.pendingFill.push(() => {
      const tex = out[0]!;
      h.fx = { tex, frames: spec.flip ? flipCells(tex, spec.flip) : [tex], w: fr.w, h: fr.h };
      h.state = 'ready';
    });
    return true;
  }

  private readonly pendingFill: Array<() => void> = [];

  /** Resolve the textures of everything packed this tick (after commit). */
  private flushFills(): void {
    for (const f of this.pendingFill) f();
    this.pendingFill.length = 0;
  }

  stats(): ArtStats {
    let ready = 0, pending = 0, failed = 0, fxReady = 0, fxPending = 0;
    let lastFailure: string | undefined;
    let failedKinds: Record<string, number> | undefined;
    for (const h of this.handles.values()) {
      const isFx = h.job.type === 'fx';
      if (h.state === 'ready') { ready++; if (isFx) fxReady++; }
      else if (h.state === 'pending') { pending++; if (isFx) fxPending++; }
      else {
        failed++;
        lastFailure = `${h.key}: ${h.reason ?? "?"}`;
        failedKinds ??= {};
        failedKinds[h.job.type] = (failedKinds[h.job.type] ?? 0) + 1;
      }
    }
    return {
      ready, pending, failed, fromCache: this.fromCache,
      pages: this.deps.packer.pageCount, gpuBytes: this.deps.packer.gpuBytes, workers: this.deps.runner.workers, fxReady, fxPending, ...(lastFailure ? { lastFailure } : {}),
      uploads: (this.deps.packer as { uploads?: number }).uploads, uploadTexels: (this.deps.packer as { uploadTexels?: number }).uploadTexels,
      ...(failedKinds ? { failedKinds } : {}),
      visit: this.gen, pins: this.pins.slice(),
      freedPages: (this.deps.packer as { freedPages?: number }).freedPages, maxPages: this.deps.packer.maxPageCount,
      topTexels: [...this.texels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k} ${(v / 1e6).toFixed(2)}Mpx`),
    };
  }

  /** Move a still-queued bake to the front of the queue (the pilot's own ship). */
  prioritize(h: ArtHandle): void {
    if (h.state !== 'pending') return;
    this.ownKeys.add(h.key);
    this.urgentKeys.add(h.key);
    this.deps.runner.promote?.(h.job);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.deps.ownsRunner !== false) this.deps.runner.destroy();
    this.deps.packer.destroy();
    this.handles.clear();
    this.toPack.length = 0;
  }

}

function rigTag(r: LightRig): string {
  return `${r.sunAz.toFixed(4)},${r.sunElev.toFixed(4)},${r.exposure}`;
}

// ---------------------------------------------------------------- runners

/** Runs bakes on a small pool of module workers. */
export class WorkerBakeRunner implements BakeRunner {
  private readonly pool: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ job: BakeJob; rig: LightRig; resolve: (b: Baked) => void; reject: (e: Error) => void }> = [];
  private seq = 0;

  constructor(size: number, factory: () => Worker, private readonly delayMs = 0) {
    for (let i = 0; i < size; i++) {
      const w = factory();
      this.pool.push(w);
      this.idle.push(w);
    }
  }

  get workers(): number { return this.pool.length; }

  run(job: BakeJob, rig: LightRig, urgent = true): Promise<Baked> {
    return new Promise((resolve, reject) => {
      const item = { job, rig, resolve, reject };
      if (urgent) this.queue.unshift(item); else this.queue.push(item);
      this.pump();
    });
  }

  promote(job: BakeJob): void {
    const k = bakeKey(job);
    const i = this.queue.findIndex((q) => bakeKey(q.job) === k);
    if (i > 0) this.queue.unshift(this.queue.splice(i, 1)[0]!);
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      const item = this.queue.shift()!;
      const seq = this.seq++;
      const done = (): void => { this.idle.push(w); this.pump(); };
      w.onmessage = (e: MessageEvent<{ seq: number; baked: Baked }>): void => {
        const finish = (): void => { item.resolve(e.data.baked); done(); };
        if (this.delayMs > 0) setTimeout(finish, this.delayMs); else finish();
      };
      w.onerror = (err): void => { item.reject(new Error(err.message)); done(); };
      w.postMessage({ seq, job: item.job, rig: item.rig });
    }
  }

  destroy(): void {
    for (const w of this.pool) w.terminate();
    this.pool.length = 0;
    this.idle.length = 0;
    for (const q of this.queue) q.reject(new Error('art service destroyed'));
    this.queue.length = 0;
  }
}

/** Fallback when workers can't be created: one bake per macrotask on the
 *  current thread. Each bake still blocks for its own duration (up to a few
 *  hundred ms for the biggest structures), so this is a last resort. */
export class InlineBakeRunner implements BakeRunner {
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  constructor(private readonly delayMs = 0) {}
  get workers(): number { return 0; }
  run(job: BakeJob, rig: LightRig, _urgent = true): Promise<Baked> {
    const p = this.chain.then(() => new Promise<Baked>((resolve, reject) => {
      setTimeout(() => {
        if (this.stopped) { reject(new Error('art service destroyed')); return; }
        try { resolve(runBake(job, rig)); } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
      }, this.delayMs);
    }));
    this.chain = p.catch(() => undefined);
    return p;
  }
  destroy(): void { this.stopped = true; }
}

// ---------------------------------------------------------------- factory

export interface CreateArtServiceOpts {
  touch: boolean;
  /** Test-only bake delay (`?artDelayMs=`). */
  delayMs?: number;
  maxWorkers?: number;
}

/** The real thing: atlas sized for the device, a worker pool (inline if
 *  workers are unavailable), and the IndexedDB cache. */
/** One bake worker pool and one in-flight list for the whole page: joining
 *  the game replaces the galaxy map's renderer, and the bakes it started keep
 *  going for the next one (smoke test 2026-11-05). The atlas stays per
 *  service, because its textures belong to that renderer's GPU context. */
let sharedRunner: BakeRunner | null = null;
const sharedInflight = new Map<string, Promise<Baked>>();

function pageRunner(o: CreateArtServiceOpts): BakeRunner {
  if (sharedRunner) return sharedRunner;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  const n = Math.max(1, Math.min(o.maxWorkers ?? 4, cores - 1));
  try {
    if (typeof Worker === 'undefined') throw new Error('no Worker');
    sharedRunner = new WorkerBakeRunner(n, () => new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module', name: shipScaleWorkerName('bake') }), o.delayMs ?? 0);
  } catch {
    sharedRunner = new InlineBakeRunner(o.delayMs ?? 0);
  }
  return sharedRunner;
}

export function createArtService(o: CreateArtServiceOpts): ArtService {
  return new ArtService({
    packer: new Atlas(false, atlasOptsFor(o.touch, (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory)),
    runner: pageRunner(o),
    cache: { load: loadBakes, save: saveBakes },
    now: () => performance.now(),
    packBudgetMs: 3,
    inflight: sharedInflight,
    ownsRunner: false,
  });
}

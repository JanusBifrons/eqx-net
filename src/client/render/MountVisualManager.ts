/**
 * MountVisualManager — pooled per-mount turret + aim-line visuals.
 *
 * Multi-mount/turret refactor, Phase 3 (2026-05-11).
 *
 * For every ship with `mounts` in its ship-kind catalogue entry, this manager
 * builds a small Pixi `Graphics` cluster (one barrel sprite + one aim line per
 * mount) and parents it to the ship's main sprite, so the cluster inherits
 * the ship's world position and body rotation automatically. Each mount's
 * graphics live at `(mount.localX, mount.localY)` in ship-local space and are
 * rotated by `mount.baseAngle` (resting angle) so a fixed rear-facing mount
 * draws its barrel pointing backward without per-frame work.
 *
 * **Phase 3 scope (current)** — static mounts:
 *
 *   - `arcMin === arcMax === 0` and `rotationSpeed === 0` on every shipped
 *     mount. The barrel + aim-line rotate ONLY with the ship's body.
 *   - No arc indicator (a fixed mount's arc is a degenerate point).
 *   - Aim-line colour is constant.
 *
 * **Phase 4b will extend this** with:
 *
 *   - Per-tick rotation animation (read `mountAngles[mountIdx]` from the
 *     ship render state — to be added on `ShipRenderState`).
 *   - Aim arc indicator (faint wedge from `arcMin..arcMax`) on active-slot
 *     mounts only.
 *   - Aim-line colour modulation by `slotTarget` lock state.
 *
 * Pooled per ship: sprites are constructed once per (ship × mount) and live
 * until the ship is despawned. The hot per-frame path is a no-op for static
 * mounts because the ship sprite's own world transform already does the
 * heavy lifting.
 *
 * Legacy single-mount ships (fighter/scout/heavy) have one mount at the
 * ship's centre with zero base angle, so their mount visuals render
 * effectively underneath the ship body and are not visually intrusive.
 */

import { Container, Graphics, Sprite } from 'pixi.js';
import type { ArtHandle } from './art/ArtService.js';
import { isMachinedSprite, type ShipArtCtx } from './art/shipArtSprites.js';
import { muzzleReach, shipTurrets, structureTurrets, type TurretPlace } from './art/turretLayout.js';
import { flashFrameAt, heatAfter, recoilAt, NAVAL_FLASH_LIFE_S, MUZZLE_SMOKE_PUFFS, muzzleSmokePuff, type SmokePuff } from './art/fx/turretFx.js';
import { NAVAL_BARREL_SPAN } from '@core/combat/muzzle';
import type { EffectQuality } from '@core/contracts/IEffects';
import { applySunBlend } from './art/machinedShipLight.js';
import { isStructureKindId } from '../../shared-types/structureKinds';
import { getShipKind, type WeaponMount } from '../../shared-types/shipKinds';
import { shipPrimaryColor } from '@core/geometry/shipHullOutline';
import { aimLineLengthForMount } from './aimLineLength';
import { GLOBAL_SHIP_TUNING } from '@shared-types/shipScale/lookup';

/** Shared frozen empty mount-list. The `?? EMPTY_MOUNTS` fallback for a
 *  mountless kind avoids allocating a fresh `[]` literal every time
 *  `ensureForShip` runs in the per-frame render path (invariant #14). */
const EMPTY_MOUNTS: readonly WeaponMount[] = [];
const EMPTY_IDS: readonly string[] = [];

/** Machined turret (new effects): a pivot at the layout's spot holding the
 *  baked gun, two sun frames cross-faded by the gun's own world rotation.
 *  The ring it sits in is cut into the hull / deck bake. `layers` is null
 *  until the gun's bake is ready (today's bar draws meanwhile). */
interface MachinedGun {
  place: TurretPlace;
  pivot: Container;
  handle: ArtHandle;
  layers: { a: Sprite; b: Sprite } | null;
  /** Pivot → tip, where a shot leaves (local world units). */
  reach: number;
  // Firing reactions (T2): recoil + flash + tip heat, emitter glow while a
  // beam holds. Times are seconds on the renderer clock.
  flash: Sprite | null;
  tip: Sprite | null;
  /** Naval turrets: one flash per barrel, and propellant smoke puffs per
   *  barrel (`MUZZLE_SMOKE_PUFFS` each), all children of the pivot so they
   *  turn and recoil with the barrels. */
  barrelFlashes: Sprite[] | null;
  smokes: Sprite[] | null;
  lastShot: number;
  beamUntil: number;
  heat: number;
  lastT: number;
}

/** Shot / beam colour at the muzzle, per family. */
const MUZZLE_TINT = { bolt: 0xffc060, beam: 0x6fd0ff, missile: 0xffa050, charge: 0xd890ff } as const;
/** Furthest a new bolt may spawn from a barrel tip and still be that barrel's
 *  (world units; bolts are first seen a frame or two after leaving). */
const SHOT_MATCH_DIST = 60;

/** Bookkeeping per ship — one cluster of mount graphics parented to the
 *  ship's sprite. The cluster `Container` rotates with the ship (because
 *  Pixi propagates the parent's `rotation` to its children), so each
 *  mount's draw-time transform is just its ship-local offset and base
 *  angle — no per-frame math required for static mounts. */
interface MountCluster {
  /** Parent of every per-mount Graphics for this ship. Lives as a child of
   *  the ship's sprite. */
  container: Container;
  /** mountId → graphics for that mount. */
  perMount: Map<string, MountGraphics>;
  /** Cached ship-kind id; if the ship's kind ever changes mid-life (it
   *  currently can't), we'd notice the mismatch and rebuild. */
  kindId: string | undefined;
  /** WS-B3 — signature of the per-instance mount list (the catalogue base
   *  mounts + any ACTIVATED latent mounts). When a player activates a latent
   *  mount the kind is unchanged but the mount list grows, so the cluster must
   *  rebuild — `kindId` alone can't detect it. The signature is the joined
   *  mount-id list. `undefined` for the legacy `ensureForShip` path (kind-only).*/
  mountSig: string | undefined;
}

interface MountGraphics {
  /** Small barrel sprite. */
  turret: Graphics;
  /** Faint preview line from barrel tip in the mount's current fire
   *  direction. Static for Phase 3; modulated by target lock in Phase 4b. */
  aimLine: Graphics;
  /** The Machined gun on this mount (new effects), or null. */
  gun: MachinedGun | null;
}

/** Dotted-line dash and gap lengths (world units). 6 u on / 4 u off reads
 *  as a clear dotted preview at typical zoom levels without becoming a
 *  visual centipede on long runs. */
const AIM_LINE_DASH_ON = 6;
const AIM_LINE_DASH_OFF = 4;

/** Half-width of the barrel rectangle (mount sprite is `2 * BARREL_HALF_WIDTH`
 *  wide and `BARREL_LENGTH` long).
 *
 *  `BARREL_LENGTH` IS the shared `MUZZLE_CLEARANCE` (campaign 5.3) — the same
 *  constant the server's fire-ray self-hit offset and the client's
 *  `updateLiveBeam` origin use — so the beam emerges from the *visible*
 *  barrel tip rather than a point in space beyond it. Pre-5.3 these were two
 *  hand-synchronised `20`s ("don't change one without the other"); now they
 *  cannot drift (invariant #15). Earlier still the barrel was drawn 8 u long
 *  and beams emerged 20 u from the mount pivot, leaving a visible 12 u gap
 *  ("lasers don't come out of the exact tip of the barrel"). */
const BARREL_HALF_WIDTH = 1.2;
const BARREL_LENGTH = GLOBAL_SHIP_TUNING.muzzleClearance;

export class MountVisualManager {
  private readonly clusters = new Map<string, MountCluster>();
  /** Turret aim-guide lines. Off for showcase capture (`?cleanworld=1`). */
  private aimLinesVisible = true;
  /** The renderer's art context: with `turrets` on, mounts on Machined
   *  hulls get Machined guns and aim lines follow the local active weapon. */
  private actx: ShipArtCtx | null = null;
  /** The local ship, and its active weapon's mount ids while a hostile is in
   *  range (empty otherwise). Only these show aim lines in the new look. */
  private localId: string | null = null;
  private localAim: readonly string[] = EMPTY_IDS;
  /** Machined guns currently drawn (for `__eqxArtStats().turrets`). */
  private machinedGuns = 0;
  /** Shots matched to a Machined gun so far (for `__eqxArtStats().turretShots`). */
  private shotsMatched = 0;
  /** This frame's renderer clock (s) and whether flash / heat draw. */
  private nowS = 0;
  private reactions = true;

  /** Per frame, before the sprite updates: the clock and the quality tier
   *  (low and minimal drop the flash and heat; recoil stays). */
  setFrame(nowMs: number, quality: EffectQuality): void {
    this.nowS = nowMs / 1000;
    this.reactions = quality === 'high' || quality === 'medium';
  }

  /** A beam is holding on this ship's mount (unknown id: its first gun). */
  noteBeam(shipId: string, mountId: string | undefined): void {
    const cluster = this.clusters.get(shipId);
    if (!cluster) return;
    const g = (mountId !== undefined ? cluster.perMount.get(mountId)?.gun : null) ?? this.firstGun(cluster);
    if (g) g.beamUntil = this.nowS + 0.12;
  }

  /** A bolt or missile was first seen at Pixi-space (x, y), fired by
   *  `shipId`: kick the nearest of its guns (recoil, flash, heat). */
  noteShotNear(shipId: string, x: number, y: number): void {
    const cluster = this.clusters.get(shipId);
    const parent = cluster?.container.parent;
    if (!cluster || !parent) return;
    const c = Math.cos(parent.rotation), s = Math.sin(parent.rotation);
    let best: MachinedGun | null = null, bd = Infinity;
    for (const m of cluster.perMount.values()) {
      const g = m.gun;
      if (!g?.layers) continue;
      const r = g.pivot.rotation;
      const lx = g.pivot.x + Math.sin(r) * g.reach, ly = g.pivot.y - Math.cos(r) * g.reach;
      const dx = parent.x + lx * c - ly * s - x, dy = parent.y + lx * s + ly * c - y;
      const d = dx * dx + dy * dy;
      // A shot is first seen up to a snapshot after it leaves the muzzle, so
      // the match radius grows with the gun (a capital's 16" gun, ~700 u from
      // pivot to muzzle, shoots shells first seen hundreds of units out;
      // invariant #18). Fighter guns keep SHOT_MATCH_DIST.
      const lim = Math.max(SHOT_MATCH_DIST, g.reach);
      if (d <= lim * lim && d < bd) { bd = d; best = g; }
    }
    if (!best) return;
    best.lastShot = this.nowS;
    best.heat = heatAfter(best.heat, 0, 1);
    this.shotsMatched++;
  }

  /** Shots matched to a Machined gun so far, or -1 when the new look is off. */
  turretShotCount(): number { return this.actx?.turrets ? this.shotsMatched : -1; }

  private firstGun(cluster: MountCluster): MachinedGun | null {
    for (const m of cluster.perMount.values()) if (m.gun) return m.gun;
    return null;
  }

  setArt(actx: ShipArtCtx): void { this.actx = actx; }

  /** Per frame, before the sprite updates. `ids` is read, never copied. */
  setLocalAim(localId: string | null, ids: readonly string[] | undefined): void {
    this.localId = localId;
    this.localAim = ids ?? EMPTY_IDS;
  }

  /** Machined guns drawn now, or -1 when the new look is off. */
  machinedGunCount(): number { return this.actx?.turrets ? this.machinedGuns : -1; }

  setAimLinesVisible(visible: boolean): void {
    this.aimLinesVisible = visible;
    for (const c of this.clusters.values()) {
      for (const m of c.perMount.values()) m.aimLine.visible = visible;
    }
  }

  /**
   * Ensure a mount-visual cluster exists for the given ship and is parented
   * to `parent`. Returns the cluster's container so the caller can keep a
   * reference if it wants — though typically the caller just relies on the
   * fact that the parent owns the lifecycle.
   *
   * Idempotent: if a cluster already exists for `shipId`, this returns the
   * existing one without modification. Ship-kind changes are not supported
   * today; if `kindId` mismatches the cached one, the old cluster is torn
   * down and rebuilt.
   */
  ensureForShip(shipId: string, kindId: string | undefined, parent: Container | Graphics): Container {
    const kind = getShipKind(kindId ?? null);
    return this.ensureForMounts(shipId, kindId, kind.mounts ?? EMPTY_MOUNTS, shipPrimaryColor(kind), parent);
  }

  /**
   * WS-B3 — ensure a cluster for a ship's FULL per-instance mount list
   * (`[...kind.mounts, ...activated latent]`). When the activated set changes
   * (a player activates a latent slot) the cluster rebuilds even though `kindId`
   * is unchanged, via the per-instance `mountSig`. `sig` is the joined mount-id
   * list (already computed by the caller from `resolveInstanceMounts`).
   */
  ensureForInstance(
    shipId: string,
    kindId: string | undefined,
    mounts: ReadonlyArray<WeaponMount>,
    color: number,
    sig: string,
    parent: Container | Graphics,
  ): Container {
    const existing = this.clusters.get(shipId);
    if (existing && existing.kindId === kindId && existing.mountSig === sig) {
      return existing.container;
    }
    if (existing) this.removeShip(shipId);
    return this.ensureForMounts(shipId, kindId, mounts, color, parent, sig);
  }

  /**
   * The single mount-cluster construction path — `ensureForShip` is a thin
   * wrapper that resolves a ship-kind's mounts + colour and delegates here.
   *
   * Takes the `mounts` list and the barrel/aim-line `color` DIRECTLY so a
   * non-ship entity (structures — kind===2 swarm entities whose tint is a
   * flat `StructureKind.color`, NOT a `shape.color`) can build the same
   * barrel + aim-line cluster without owning a `ShipKind`. The cluster is
   * keyed by `id` and tagged with `kindId` for the idempotency/rebuild
   * check, exactly as before.
   *
   * Idempotent: a cluster already present for `(id, kindId)` is returned
   * untouched; a `kindId` mismatch tears down + rebuilds.
   */
  ensureForMounts(
    id: string,
    kindId: string | undefined,
    mounts: ReadonlyArray<WeaponMount>,
    color: number,
    parent: Container | Graphics,
    mountSig?: string,
  ): Container {
    const existing = this.clusters.get(id);
    if (existing && existing.kindId === kindId && existing.mountSig === mountSig) return existing.container;
    if (existing) {
      // Kind (or WS-B3 per-instance mount set) changed. Destroy + rebuild.
      this.removeShip(id);
    }

    const container = new Container();
    parent.addChild(container);
    const perMount = new Map<string, MountGraphics>();

    if (mounts.length > 0) {
      for (const mount of mounts) {
        const turret = buildTurretGfx(mount, color);
        const aimLine = buildAimLineGfx(mount, color);
        aimLine.visible = this.aimLinesVisible;
        // Position in ship-local space. Pixi-up convention: ship-forward is
        // −y, so we flip Y when laying out the local offset.
        turret.x = mount.localX;
        turret.y = -mount.localY;
        turret.rotation = -mount.baseAngle;
        aimLine.x = mount.localX;
        aimLine.y = -mount.localY;
        aimLine.rotation = -mount.baseAngle;
        // Aim line draws first (beneath the turret sprite) so the barrel
        // visually appears to "cap" the line.
        container.addChild(aimLine);
        container.addChild(turret);
        perMount.set(mount.id, { turret, aimLine, gun: this.machinedGunFor(id, kindId, mount, color, parent, container) });
      }
    }

    this.clusters.set(id, { container, perMount, kindId, mountSig });
    return container;
  }

  /** Remove a ship's mount cluster and free its graphics. Call from the
   *  same despawn path that destroys the ship sprite. */
  removeShip(shipId: string): void {
    const cluster = this.clusters.get(shipId);
    if (!cluster) return;
    for (const m of cluster.perMount.values()) if (m.gun?.layers) this.machinedGuns--;
    cluster.container.destroy({ children: true });
    this.clusters.delete(shipId);
  }

  /** Recoil, flash, tip heat and the beam glow for one gun, this frame. */
  private animateGun(gun: MachinedGun): void {
    const t = this.nowS, layers = gun.layers!;
    const dt = Math.max(0, Math.min(0.1, t - gun.lastT));
    gun.lastT = t;
    const fam = gun.place.family;
    const kicks = fam === 'bolt' || fam === 'missile';
    const since = t - gun.lastShot;
    const kick = kicks ? recoilAt(since) * Math.max(gun.place.len, gun.place.wid) * (fam === 'missile' ? 0.06 : 0.2) : 0;
    layers.a.y = kick; layers.b.y = kick;
    const beamOn = t < gun.beamUntil;
    gun.heat = heatAfter(gun.heat, dt, 0) + (beamOn ? dt * 1.2 : 0);
    if (gun.heat > 1) gun.heat = 1;
    if (!this.reactions) {
      if (gun.flash) gun.flash.visible = false;
      if (gun.tip) gun.tip.visible = false;
      return;
    }
    if (!gun.flash || !gun.tip || (gun.place.naval && (!gun.smokes || !gun.barrelFlashes))) this.buildReactionSprites(gun);
    const flash = gun.flash, tip = gun.tip;
    const naval = gun.place.naval;
    if (naval) {
      // A capital salvo: a long, directed flash out of EACH barrel and
      // propellant smoke blown forward along it (children of the pivot, so
      // they follow the barrels' rotation and recoil).
      if (flash) flash.visible = false;
      this.animateNavalMuzzles(gun, naval, kicks ? since : -1, kick);
    } else if (flash) {
      const frames = this.flashFrames();
      const fr = kicks && frames ? flashFrameAt(since, frames.length) : -1;
      flash.visible = fr >= 0;
      if (fr >= 0) {
        flash.texture = frames![fr]!;
        flash.y = -gun.reach + kick;
        const w = gun.place.wid;
        flash.scale.set((w * 3.2) / 64, (w * 4.2) / 64);
      }
    }
    if (tip) {
      const glow = fam === 'bolt' ? gun.heat * 0.8 : beamOn ? 0.9 : 0;
      tip.visible = glow > 0.02;
      if (tip.visible) {
        tip.alpha = glow;
        tip.y = -gun.reach + kick;
        tip.scale.set(((gun.place.wid * (fam === 'bolt' ? 1.6 : 3)) / 64) * (1 + 0.4 * glow));
      }
    }
  }

  /** Per-barrel flash + forward smoke for a naval turret, `since` seconds
   *  after its last salvo (-1 = not firing). Alloc-free (#14). */
  private animateNavalMuzzles(gun: MachinedGun, naval: { barrels: number; houseW: number }, since: number, kick: number): void {
    const w = gun.place.wid;
    const n = naval.barrels;
    const pitch = n > 1 ? (naval.houseW * NAVAL_BARREL_SPAN) / (n - 1) : 0;
    const frames = this.flashFrames();
    const fr = since >= 0 && frames ? flashFrameAt(since, frames.length, NAVAL_FLASH_LIFE_S) : -1;
    const flashes = gun.barrelFlashes;
    if (flashes) {
      for (let b = 0; b < flashes.length; b++) {
        const f = flashes[b]!;
        f.visible = fr >= 0;
        if (fr < 0) continue;
        f.texture = frames![fr]!;
        f.x = (b - (n - 1) / 2) * pitch;
        f.y = -gun.reach + kick;
        f.scale.set((w * 7) / 64, (w * 22) / 64);
      }
    }
    const smokes = gun.smokes;
    if (!smokes) return;
    const tex = smokes[0]!.texture;
    const tw = Math.max(1, tex.width);
    for (let b = 0; b < n; b++) {
      for (let k = 0; k < MUZZLE_SMOKE_PUFFS; k++) {
        const s = smokes[b * MUZZLE_SMOKE_PUFFS + k];
        if (!s) continue;
        const p = muzzleSmokePuff(since, k, w, this._puff);
        s.visible = p.alpha > 0.01;
        if (!s.visible) continue;
        s.x = (b - (n - 1) / 2) * pitch;
        s.y = -gun.reach - p.d;
        s.alpha = p.alpha;
        s.scale.set(p.size / tw);
      }
    }
  }

  /** The flash flipbook cells, once baked. */
  private flashFrames(): readonly import('pixi.js').Texture[] | null {
    const art = this.actx?.art;
    if (!art) return null;
    this.flashHandle ??= art.fx('muzzleFlash', undefined, undefined, false);
    return this.flashHandle.state === 'ready' && this.flashHandle.fx ? this.flashHandle.fx.frames : null;
  }
  private flashHandle: ArtHandle | null = null;
  private glowHandle: ArtHandle | null = null;
  private smokeHandle: ArtHandle | null = null;
  /** Scratch for one smoke puff (alloc-free per frame). */
  private readonly _puff: SmokePuff = { d: 0, size: 0, alpha: 0 };

  /** Make a gun's flash + tip glow sprites (once, when their textures are ready). */
  private buildReactionSprites(gun: MachinedGun): void {
    const art = this.actx?.art;
    if (!art) return;
    const frames = this.flashFrames();
    this.glowHandle ??= art.fx('glow', undefined, undefined, false);
    const glow = this.glowHandle.state === 'ready' && this.glowHandle.fx ? this.glowHandle.fx.tex : null;
    const tint = MUZZLE_TINT[gun.place.family];
    if (!gun.flash && frames) {
      const f = new Sprite(frames[0]!); f.anchor.set(0.5, 1); f.blendMode = 'add'; f.tint = tint; f.visible = false;
      gun.pivot.addChild(f); gun.flash = f;
    }
    if (!gun.tip && glow) {
      const g = new Sprite(glow); g.anchor.set(0.5); g.blendMode = 'add'; g.tint = gun.place.family === 'bolt' ? 0xff6a2a : tint; g.visible = false;
      gun.pivot.addChild(g); gun.tip = g;
    }
    const naval = gun.place.naval;
    if (naval && !gun.smokes) {
      this.smokeHandle ??= art.fx('smoke', undefined, undefined, false);
      const smoke = this.smokeHandle.state === 'ready' && this.smokeHandle.fx ? this.smokeHandle.fx.tex : null;
      if (smoke) {
        // Smoke under the flash (added first), normal blend, warm grey.
        const list: Sprite[] = [];
        for (let i = 0; i < naval.barrels * MUZZLE_SMOKE_PUFFS; i++) {
          const s = new Sprite(smoke); s.anchor.set(0.5); s.tint = 0xb8b0a4; s.visible = false;
          gun.pivot.addChildAt(s, 0); list.push(s);
        }
        gun.smokes = list;
      }
    }
    if (naval && !gun.barrelFlashes && frames) {
      const list: Sprite[] = [];
      for (let b = 0; b < naval.barrels; b++) {
        const f = new Sprite(frames[0]!); f.anchor.set(0.5, 1); f.blendMode = 'add'; f.tint = tint; f.visible = false;
        gun.pivot.addChild(f); list.push(f);
      }
      gun.barrelFlashes = list;
    }
  }

  /** A Machined gun for one mount, when the new look is on and the parent is
   *  a Machined hull or deck; else null (today's bar). The gun takes the
   *  hull's own paint (a faction drone's, an owner's accent). */
  private machinedGunFor(
    id: string, kindId: string | undefined, mount: WeaponMount, color: number,
    parent: Container | Graphics, container: Container,
  ): MachinedGun | null {
    const actx = this.actx;
    if (!actx?.turrets || !actx.art || !kindId || !isMachinedSprite(parent)) return null;
    const structure = isStructureKindId(kindId);
    const places = structure ? structureTurrets(kindId) : shipTurrets(kindId);
    let place: TurretPlace | undefined;
    for (const p of places) if (p.mount.id === mount.id) place = p;
    if (!place) return null; // e.g. an activated latent mount, a miner drill
    const job = actx.handles.get(id)?.job;
    const paint = job?.type === 'ship' ? (job.paint ?? color) : job?.type === 'struct' ? (job.accent ?? color) : color;
    const pivot = new Container();
    pivot.position.set(place.px, place.py);
    pivot.rotation = -mount.baseAngle;
    container.addChild(pivot);
    const handle = actx.art.acquire({
      // Capital naval turrets are big: bake them at a density that keeps the
      // long side near 160 px (plenty at play zoom), or a capital fleet blows
      // the texture budget (capital R&D, measured 365 MB at the fighter ppu).
      type: 'turret', id: place.family, paint, len: Math.max(place.len, 0.1), wid: place.wid, cap: place.cap,
      ppu: structure ? 2.5 : place.naval ? Math.min(6, 160 / (place.naval.houseL / 2 + place.len)) : 6,
      ...(place.naval ? { naval: place.naval } : {}),
    });
    return {
      place, pivot, handle, layers: null, reach: muzzleReach(place),
      flash: null, tip: null, barrelFlashes: null, smokes: null, lastShot: -9, beamUntil: -1, heat: 0, lastT: this.nowS,
    };
  }

  /** Mount count for a tracked ship — used by PixiRenderer to expose the
   *  `data-mount-count` test attribute. Returns 0 for ships not tracked. */
  mountCountForShip(shipId: string): number {
    return this.clusters.get(shipId)?.perMount.size ?? 0;
  }

  /**
   * Multi-mount/turret refactor (Phase 4b.2): apply per-mount rotation
   * angles for a tracked ship. `mountAngles[i]` is the slewed angle in
   * the mount's ARC-LOCAL frame (0 = barrel at rest, ±arcMin/arcMax
   * range) — we add `mount.baseAngle` back in to recover the ship-
   * relative orientation, then flip for Pixi's y-down convention.
   *
   * Callers (PixiRenderer.update) pass in the catalogue's ordered mount
   * list so we apply angles to mounts in matching order. A `mountAngles`
   * of `undefined` (remote player whose authoritative angles haven't
   * landed yet) restores every mount to its base angle — no rotation
   * preview leaks to ships we don't have data for.
   */
  applyMountAngles(
    shipId: string,
    mounts: ReadonlyArray<WeaponMount>,
    mountAngles: ReadonlyArray<number> | undefined,
  ): void {
    const cluster = this.clusters.get(shipId);
    if (!cluster) return;
    for (let i = 0; i < mounts.length; i++) {
      const mount = mounts[i]!;
      const gfx = cluster.perMount.get(mount.id);
      if (!gfx) continue;
      const current = mountAngles?.[i] ?? 0;
      // Pixi y-flip: positive ship-relative rotation is "to the left" in
      // world view (because Pixi's +y is screen-down). We negate to get
      // the screen-correct sprite rotation.
      const spriteRotation = -(mount.baseAngle + current);
      gfx.turret.rotation = spriteRotation;
      gfx.aimLine.rotation = spriteRotation;
      const gun = gfx.gun;
      if (gun) {
        if (!gun.layers && gun.handle.state === 'ready' && gun.handle.ship) {
          // The bake just finished: build the gun (once) and retire the bar.
          const art = gun.handle.ship;
          const a = new Sprite(art.frames[0]!), b = new Sprite(art.frames[1 % art.frames.length]!);
          for (const sp of [a, b]) { sp.anchor.set(0.5); sp.scale.set(1 / art.density); gun.pivot.addChild(sp); }
          b.alpha = 0;
          gun.layers = { a, b };
          gfx.turret.visible = false;
          this.machinedGuns++;
        }
        if (gun.layers && gun.handle.ship) {
          gun.pivot.rotation = spriteRotation;
          // Lit by the gun's own world rotation, like a hull.
          const parentRot = cluster.container.parent?.rotation ?? 0;
          applySunBlend(gun.layers, gun.handle.ship.frames, this.actx?.sunAz ?? 0, parentRot + spriteRotation);
          this.animateGun(gun);
        }
      }
      if (this.actx?.turrets) {
        // New look: guides only for the local ship's active weapon while a
        // hostile is in range.
        gfx.aimLine.visible = this.aimLinesVisible && shipId === this.localId && this.localAim.includes(mount.id);
      }
    }
  }

  /** Tear down every cluster. Call from PixiRenderer.dispose. */
  disposeAll(): void {
    for (const cluster of this.clusters.values()) {
      cluster.container.destroy({ children: true });
    }
    this.clusters.clear();
  }
}

/**
 * Barrel sprite — a stubby rectangle extending forward (toward −y in
 * mount-local space). Coloured to match the ship's kind so the visual blends
 * coherently. A darker tip suggests "this end is the muzzle".
 */
function buildTurretGfx(_mount: WeaponMount, color: number): Graphics {
  const g = new Graphics();
  // Body of the barrel (origin = mount pivot; barrel extends forward).
  g.rect(-BARREL_HALF_WIDTH, -BARREL_LENGTH, BARREL_HALF_WIDTH * 2, BARREL_LENGTH);
  g.fill({ color, alpha: 0.85 });
  // Dark muzzle tip — last 2 units.
  g.rect(-BARREL_HALF_WIDTH, -BARREL_LENGTH, BARREL_HALF_WIDTH * 2, 2);
  g.fill({ color: 0x000000, alpha: 0.55 });
  return g;
}

/**
 * Aim-line preview — a permanent **dotted** guide line from the barrel tip
 * along the mount's current fire direction, extending out to weapon range.
 * User-requested feedback (2026-05-11 smoke test) so the player can see
 * exactly where each active mount will fire without having to fire to
 * find out.
 *
 * Pixi v8's `Graphics` doesn't have native dashed strokes, so we draw the
 * dashes as a chain of short segments. The whole chain lives in
 * mount-local space pointing -y (forward), and `applyMountAngles`
 * rotates the parent Graphics so the dotted line sweeps with the slewing
 * barrel automatically.
 *
 * Phase 4b colours this constant; Phase 4b.3 will modulate the alpha or
 * colour by whether the slot's `pickTarget` has acquired something.
 */
function buildAimLineGfx(mount: WeaponMount, color: number): Graphics {
  const g = new Graphics();
  const start = BARREL_LENGTH;
  // R2.14 — length tracks the mount's bound weapon's effective reach (the pure
  // `aimLineLengthForMount`) instead of a hardcoded 500 (which drew the
  // interceptor's beam guide at 2× its 250 hitscan range).
  const end = BARREL_LENGTH + aimLineLengthForMount(mount);
  const step = AIM_LINE_DASH_ON + AIM_LINE_DASH_OFF;
  for (let s = start; s < end; s += step) {
    const dashEnd = Math.min(s + AIM_LINE_DASH_ON, end);
    g.moveTo(0, -s).lineTo(0, -dashEnd);
  }
  g.stroke({ color, width: 1, alpha: 0.25 });
  return g;
}


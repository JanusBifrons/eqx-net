/**
 * Base platforms — "show where you can build" (`?buildSlots=on`, default off
 * until the owner signs off the look). While a kind is picked on a deck room,
 * a faint outline marks every free slot on the local player's own plates
 * where the ghost would turn cyan. Hex-edge kinds (a shield gate, `'edge'`
 * slot) get none: their placement rule is being redesigned. No slot ⇒ nothing drawn.
 *
 * Nothing here decides a slot or its validity: each candidate is snapped by
 * the same `snapPlacementToDeck` the ghost and the server's `place_structure`
 * handler run, and judged by the ghost's own `PlacementGhostVerdict` (the
 * server's `placementRejection`) with the ghost's deck context. Rocks are not
 * tested here (the ghost's rock list covers only the area round the ghost);
 * a plate is laid where no rock is, so a free slot on it is rock-free.
 *
 * One `Graphics` on `shipContainer` in the deck floor band (over road tiles,
 * under the approach lamps and rig pads). The slot set is recomputed and
 * redrawn only when the picked kind, the held turn / mirror, the player's
 * plates or the structure set change; an unchanged frame walks the structure
 * map once with a pre-bound callback for its signature and allocates nothing (#14).
 */
import { Graphics, type Container } from 'pixi.js';
import type { RenderMirror, SwarmRenderState } from '@core/contracts/IRenderer';
import { HEX_DIRS, hexCornerInto, type AxialHex, type HexPoint } from '../../../core/hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto, plateCentreHexInto } from '../../../core/hex/plates.js';
import { deckSlotOutline, rhombusCentroidInto, type DeckSlot, type DeckSnap } from '../../../core/hex/deckSnap.js';
import { snapPlacementToDeck } from '../../../core/structures/deckPlacement.js';
import type { PlacementDeck } from '../../../core/structures/placementRules.js';
import { PlacementGhostVerdict, type GhostPose } from '../../structures/placementGhostVerdict.js';
import { ghostDeckContext } from './placementDeckSnap.js';

type Preview = NonNullable<RenderMirror['pendingPlacementPreview']>;

/** `?buildSlots=on` — default off (look awaiting the owner's OK). */
export function readBuildSlotsFlag(search: string): boolean {
  return /[?&]buildSlots=on\b/.test(search);
}

/** zIndex: over road tiles (ROAD_UNDER_Z −1.0625) so a slot beside a road
 *  reads, under the approach lamps (−1.03125) and rig pads (−1). */
export const BUILD_SLOT_Z = -1.046875;
export const BUILD_SLOT_COLOR = 0x7fe8ff;
/** Faint: thinner than the deck seams (28 u) and far under the ghost's own
 *  slot outline (alpha 0.7), so it never reads louder than the ghost. */
export const BUILD_SLOT_ALPHA = 0.22;
export const BUILD_SLOT_WIDTH = 16;
const BUILD_SLOT_STROKE = { color: BUILD_SLOT_COLOR, alpha: BUILD_SLOT_ALPHA, width: BUILD_SLOT_WIDTH, join: 'round', cap: 'round' } as const;
/** Slot areas are drawn shrunk about their centre, so neighbours read apart. */
const INSET = 0.9;
/** Probe points toward a corner (of the way from the hex centre): the snap
 *  then lands on that corner (a fence post). */
const PROBE_REACH = 0.85;

const SLOT_CODES: readonly DeckSlot[] = ['small', 'hex', 'plate', 'corner', 'edge'];
const RAD_TO_DEG = 180 / Math.PI;

/** Fields per slot in {@link BuildSlotOutlines.slots}: x, y, slot code, rhombus, rot (deg). */
export const SLOT_STRIDE = 5;

/**
 * Every free slot for `kind` on the plates `plates` (flat i, j pairs): probes
 * each plate hex at its centre, its three rhombi and toward its six corners,
 * snaps each probe (`snapPlacementToDeck`), drops repeats and hex-edge
 * (`'edge'`) slots, and keeps the snapped poses the verdict accepts. `verdict` must be
 * prepared with the current structures. Writes {@link SLOT_STRIDE} numbers per
 * slot into `out`; returns the slot count. Recompute-time only (allocates the
 * dedupe keys into `seen`, which the caller reuses).
 */
export function collectBuildSlots(
  kind: string, rotDeg: number, mirror: boolean, plates: readonly number[],
  verdict: PlacementGhostVerdict, deck: PlacementDeck | null, seen: Set<number>, out: number[],
): number {
  out.length = 0;
  seen.clear();
  const snap: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 };
  const pose: GhostPose = { kind, x: 0, y: 0, angle: 0, mirror };
  const centre: AxialHex = { q: 0, r: 0 };
  const c: HexPoint = { x: 0, y: 0 };
  const p: HexPoint = { x: 0, y: 0 };
  const probe = (x: number, y: number): void => {
    snapPlacementToDeck(kind, x, y, snap, rotDeg);
    if (snap.slot === 'edge') return; // gates: rule under redesign, no outlines
    const key = Math.round(snap.x) * 4194304 + Math.round(snap.y);
    if (seen.has(key)) return;
    seen.add(key);
    pose.x = snap.x; pose.y = snap.y; pose.angle = snap.rot / RAD_TO_DEG;
    if (verdict.checkPrepared(pose, null, deck) !== null) return;
    out.push(snap.x, snap.y, SLOT_CODES.indexOf(snap.slot), snap.rhombus, snap.rot);
  };
  for (let n = 0; n + 1 < plates.length; n += 2) {
    plateCentreHexInto(plates[n]!, plates[n + 1]!, centre);
    for (let h = 0; h < 7; h++) {
      const d = h === 0 ? null : HEX_DIRS[h - 1]!;
      deckHexCentreInto(centre.q + (d?.q ?? 0), centre.r + (d?.r ?? 0), c);
      probe(c.x, c.y);
      for (let k = 0; k < 3; k++) { rhombusCentroidInto(c.x, c.y, k, p); probe(p.x, p.y); }
      for (let k = 0; k < 6; k++) {
        hexCornerInto(c.x, c.y, DECK_HEX_SIZE, k, p);
        probe(c.x + (p.x - c.x) * PROBE_REACH, c.y + (p.y - c.y) * PROBE_REACH);
      }
    }
  }
  return out.length / SLOT_STRIDE;
}

/** The outline polygons of a slot (game frame, relative to its centre), cached. */
const outlineCache = new Map<string, number[][]>();
function outlineFor(slot: DeckSlot, rhombus: number): number[][] {
  const key = slot === 'small' ? `small${rhombus}` : slot;
  let polys = outlineCache.get(key);
  if (polys === undefined) { polys = deckSlotOutline(slot, rhombus); outlineCache.set(key, polys); }
  return polys;
}

export class BuildSlotOutlines {
  readonly gfx = new Graphics();
  /** The drawn slots, {@link SLOT_STRIDE} numbers each (tests, probes). */
  readonly slots: number[] = [];
  private readonly verdict = new PlacementGhostVerdict();
  private readonly seen = new Set<number>();
  // Last computed signature.
  private kind: string | null = null;
  private angle = NaN;
  private mirror = false;
  private owner: string | undefined = undefined;
  private plateVersion = -1;
  private plateCount = -1;
  private structSig = 0;
  private structCount = -1;
  // Structure signature scratch (pre-bound walk, #14).
  private sigSwarm: ReadonlyMap<number, SwarmRenderState> | null = null;
  private sigAcc = 0;
  private readonly sigFn = (_v: unknown, id: number): void => {
    const seen = this.sigSwarm!.has(id) ? 1 : 0;
    this.sigAcc = (Math.imul(this.sigAcc, 31) + id * 2 + seen) | 0;
  };

  constructor(shipContainer: Container) {
    this.gfx.label = 'buildSlots';
    this.gfx.zIndex = BUILD_SLOT_Z;
    this.gfx.visible = false;
    shipContainer.sortableChildren = true;
    shipContainer.addChild(this.gfx);
  }

  /** Slots drawn now. */
  get count(): number { return this.slots.length / SLOT_STRIDE; }

  /** Per frame (the placement ghost pass): show the outlines for the live
   *  ghost on a deck room, recomputing only on a change. */
  update(preview: Preview | null | undefined, mirror: RenderMirror): void {
    const swarm = mirror.swarm;
    if (!preview || preview.pending === true || preview.deck !== true || !swarm) {
      this.gfx.visible = false;
      return;
    }
    this.sigSwarm = swarm;
    this.sigAcc = 0;
    mirror.structures?.forEach(this.sigFn);
    this.sigSwarm = null;
    const structCount = mirror.structures?.size ?? 0;
    const plates = preview.deckPlates;
    const plateCount = plates?.length ?? 0;
    const plateVersion = mirror.deckPlates?.version ?? 0;
    const mirrorOn = preview.mirror === true;
    if (preview.kind !== this.kind || preview.angle !== this.angle || mirrorOn !== this.mirror
      || preview.deckOwner !== this.owner || plateCount !== this.plateCount || plateVersion !== this.plateVersion
      || structCount !== this.structCount || this.sigAcc !== this.structSig) {
      this.kind = preview.kind; this.angle = preview.angle; this.mirror = mirrorOn; this.owner = preview.deckOwner;
      this.plateCount = plateCount; this.plateVersion = plateVersion; this.structCount = structCount; this.structSig = this.sigAcc;
      this.recompute(preview, mirror);
    }
    this.gfx.visible = this.slots.length > 0;
  }

  /** Recompute-time only: the slot set and its outline art. */
  private recompute(preview: Preview, mirror: RenderMirror): void {
    this.verdict.prepare(mirror.structures, mirror.swarm!);
    const deck = ghostDeckContext(preview);
    collectBuildSlots(preview.kind, preview.angle * RAD_TO_DEG, preview.mirror === true, preview.deckPlates ?? [], this.verdict, deck, this.seen, this.slots);
    this.redraw();
  }

  private redraw(): void {
    const g = this.gfx;
    g.clear();
    const s = this.slots;
    for (let n = 0; n < s.length; n += SLOT_STRIDE) {
      const x = s[n]!, y = s[n + 1]!, slot = SLOT_CODES[s[n + 2]!]!;
      const scale = slot === 'corner' ? 1 : INSET;
      for (const poly of outlineFor(slot, s[n + 3]!)) {
        // A fresh array per polygon: Pixi's Polygon keeps the array it is
        // given (no copy), so a reused scratch moved every outline onto the
        // last slot. Recompute-time only, never per frame.
        const pts: number[] = [];
        for (let i = 0; i < poly.length; i += 2) pts.push(x + poly[i]! * scale, -(y + poly[i + 1]! * scale));
        g.poly(pts, true).stroke(BUILD_SLOT_STROKE);
      }
    }
  }

  destroy(): void {
    this.gfx.parent?.removeChild(this.gfx);
    this.gfx.destroy();
    this.slots.length = 0;
  }
}

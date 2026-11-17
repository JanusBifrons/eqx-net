import { axialToPixel, type GalaxySector } from '@core/galaxy/galaxy';
import { teamColorOf } from '../../../shared-types/factions.js';
import type { SectorControl } from '../../../shared-types/galaxySnapshot.js';
import { NEUTRAL_OWNER } from './sectorOwnership';

/**
 * Pure territory model for {@link GalaxyMapLayer} (Living Galaxy Phase 4a — the
 * `galaxyLayerDecisions.ts` idiom: the logic lives here + is unit-tested, the
 * Pixi calls stay in the layer).
 *
 * A **territory** is a maximal set of same-OWNER sectors that are CONTIGUOUS in
 * the galaxy graph (BFS over same-owner neighbours). Ownership is resolved by the
 * injected `ownerOf` callback — the {@link import('./sectorOwnership').resolveSectorOwner}
 * seam — NOT the baked `GalaxySector.region` (Equinox Phase 9, item 1): that is
 * what makes the grouping DYNAMIC rather than hard-coded. Today every sector is
 * NEUTRAL, so the whole connected galaxy forms ONE territory; as capture/faction
 * mechanics arrive, `ownerOf` returns real owners and territories re-form here
 * with no caller change.
 *
 * The territory grouping is what makes the contiguous-territory hover-shrink
 * meaningful: the layer parents each territory's hexes under one sub-container at
 * the territory CENTROID, so a single `container.scale.set(s)` shrinks the whole
 * region toward its centre as one unit. The centroid here is in the SAME pixel
 * space as `axialToPixel(hex, hexSize)`, so the layer can position the container
 * at `centroid` and offset each child by `(hexPixel - centroid)`.
 */
export interface Territory {
  /** The shared OWNER id (a {@link import('./sectorOwnership').OwnerId} —
   *  NEUTRAL_OWNER today; a faction/player id once capture exists). */
  ownerId: string;
  /** Member sector keys, in graph-discovery (BFS) order. */
  sectorKeys: string[];
  /** Pixel centroid (mean of members' `axialToPixel` positions at `hexSize`). */
  centroid: { x: number; y: number };
}

/**
 * Group `sectors` into owner-contiguous territories. `ownerOf` resolves each
 * sector's owner (inject `resolveSectorOwner`); BFS merges contiguous neighbours
 * that share that owner. Deterministic: territories are discovered in `sectors`
 * order; members in BFS order over `GalaxySector.neighbours`. Every sector
 * appears in exactly one territory.
 */
export function computeTerritories(
  sectors: readonly GalaxySector[],
  hexSize: number,
  ownerOf: (sector: GalaxySector) => string,
): Territory[] {
  const byKey = new Map(sectors.map((s) => [s.key, s]));
  // Resolve ownership once per sector (deterministic + avoids re-calling ownerOf
  // for every neighbour visit).
  const ownerByKey = new Map<string, string>();
  for (const s of sectors) ownerByKey.set(s.key, ownerOf(s));
  const seen = new Set<string>();
  const out: Territory[] = [];

  for (const start of sectors) {
    if (seen.has(start.key)) continue;
    const ownerId = ownerByKey.get(start.key)!;
    const members: string[] = [];
    const queue: string[] = [start.key];
    seen.add(start.key);
    while (queue.length > 0) {
      const key = queue.shift()!;
      members.push(key);
      const sec = byKey.get(key);
      if (!sec) continue;
      for (const nKey of sec.neighbours) {
        if (seen.has(nKey)) continue;
        const n = byKey.get(nKey);
        if (n && ownerByKey.get(nKey) === ownerId) {
          seen.add(nKey);
          queue.push(nKey);
        }
      }
    }

    let sumX = 0;
    let sumY = 0;
    for (const key of members) {
      const p = axialToPixel(byKey.get(key)!.hex, hexSize);
      sumX += p.x;
      sumY += p.y;
    }
    out.push({
      ownerId,
      sectorKeys: members,
      centroid: { x: sumX / members.length, y: sumY / members.length },
    });
  }
  return out;
}

/**
 * Owner → territory colours. The map paints owners with the SAME colour
 * authority the ships use (`teamColorOf`): the region powers, robots and drones
 * their livery colour, a player faction its picked (or hashed) palette slot.
 * There is no galaxy-only palette. Neutral ground is a grey.
 */
export const DEFAULT_FACTION_COLOR = 0x8893a6;

export function factionColor(ownerId: string): number {
  return ownerId === NEUTRAL_OWNER || ownerId === '' ? DEFAULT_FACTION_COLOR : teamColorOf(ownerId);
}

/**
 * Owner → BORDER colour: the owner's ship colour lifted toward white, so the
 * inset border reads over the darker fill.
 */
export const DEFAULT_FACTION_BORDER_COLOR = 0xb8c2d6;

export function factionBorderColor(ownerId: string): number {
  if (ownerId === NEUTRAL_OWNER || ownerId === '') return DEFAULT_FACTION_BORDER_COLOR;
  return mixColor(teamColorOf(ownerId), 0xffffff, 0.35);
}

/** Owners whose ground carries a hatch over the fill (the drone swarm). */
export function ownerHatched(ownerId: string): boolean {
  return ownerId === 'drones';
}

/** Blend two 0xRRGGBB colours (t=0 → a, t=1 → b). Pure, alloc-free. */
export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

// ── Control overlays (galaxy feed `control`) ────────────────────────────────

/** A sector nobody owns shows a split only once the leader holds at least
 *  this share (0-100), so a stray pass does not paint unclaimed ground. */
export const UNOWNED_SPLIT_MIN_SHARE = 40;

/** Factions that never count for capture (the Ancients guard, never claim).
 *  The server meter leaves them out; the map never splits for them either. */
const NON_CAPTURING_OWNERS: ReadonlySet<string> = new Set(['ancients']);

/** The challenger a contested sector splits with, or null (draw a whole hex).
 *  Contested = the meter names a challenger other than the holder, with some
 *  share. A sector nobody owns splits grey / leader only once the leader holds
 *  {@link UNOWNED_SPLIT_MIN_SHARE}. A non-capturing faction never splits. */
export function splitChallenger(control: SectorControl | null | undefined, holderId: string): string | null {
  if (!control || control.challenger === null) return null;
  if (control.challenger === holderId || control.challengerShare <= 0) return null;
  if (NON_CAPTURING_OWNERS.has(control.challenger)) return null;
  const unowned = holderId === NEUTRAL_OWNER || holderId === '';
  if (unowned && control.challengerShare < UNOWNED_SPLIT_MIN_SHARE) return null;
  return control.challenger;
}

/** How a threat level draws: which hex corners get an amber bracket, how long
 *  each arm is (fraction of the hex size) and how thick. Grows with threat. */
export interface ThreatBracketStyle {
  readonly corners: readonly number[];
  readonly arm: number;
  readonly width: number;
}

const NO_BRACKETS: ThreatBracketStyle = Object.freeze({ corners: Object.freeze([]), arm: 0, width: 0 });
const THREAT_BRACKETS: readonly ThreatBracketStyle[] = Object.freeze([
  NO_BRACKETS,
  Object.freeze({ corners: Object.freeze([2, 5]), arm: 0.22, width: 2 }),
  Object.freeze({ corners: Object.freeze([0, 2, 3, 5]), arm: 0.28, width: 2.5 }),
  Object.freeze({ corners: Object.freeze([0, 1, 2, 3, 4, 5]), arm: 0.34, width: 3 }),
]);

export const THREAT_BRACKET_COLOR = 0xffb020;

export function threatBracketStyle(threat: number | undefined): ThreatBracketStyle {
  if (threat === undefined || !(threat >= 1)) return NO_BRACKETS;
  return THREAT_BRACKETS[Math.min(3, Math.floor(threat))]!;
}

/** How long the dashed "just flipped" ring shows after the client sees a flip. */
export const FLIP_RING_MS = 30_000;

/** The flip ring's strength `ageMs` after the flip was seen: 1 → 0, gone after
 *  {@link FLIP_RING_MS}. */
export function flipRingStrength(ageMs: number): number {
  if (!(ageMs >= 0) || ageMs >= FLIP_RING_MS) return 0;
  return 1 - ageMs / FLIP_RING_MS;
}

/**
 * Did this poll show a NEW flip? `flippedAtMs` is server game time, which the
 * landing page has no clock for, so the client marks a flip when the value
 * changes between two polls. The first poll (`prev === undefined`) never marks
 * one: an old flip must not ring on every page load.
 */
export function isNewFlip(prev: number | null | undefined, next: number | null | undefined): boolean {
  if (prev === undefined || next === undefined || next === null) return false;
  return next !== prev;
}

/**
 * Axial neighbour offset across hex-edge `ei`, where edge `ei` runs from
 * `GalaxyMapLayer.hexVertices` vertex `ei` → vertex `(ei+1) % 6` (vertex angles
 * 30°, 90°, 150°, 210°, 270°, 330°). The neighbour across an edge sits in the
 * edge's outward-normal direction. **MUST stay in sync with `hexVertices`** —
 * locked by galaxyTerritories.test.ts against the live vertex order + the core
 * `axialToPixel` projection (the highest-risk detail of the border port).
 */
export const HEX_EDGE_NEIGHBOUR_DIRS: ReadonlyArray<{ q: number; r: number }> = [
  { q: 0, r: 1 }, // edge 0 (30°→90°): lower-right
  { q: -1, r: 1 }, // edge 1 (90°→150°): lower-left
  { q: -1, r: 0 }, // edge 2 (150°→210°): left
  { q: 0, r: -1 }, // edge 3 (210°→270°): upper-left
  { q: 1, r: -1 }, // edge 4 (270°→330°): upper-right
  { q: 1, r: 0 }, // edge 5 (330°→30°): right
];

/**
 * The hex-edge indices of `sector` that lie on its faction's OUTER perimeter —
 * i.e. the hex across that edge is absent or a DIFFERENT faction. Drawing only
 * these (in the faction border colour) yields one continuous outline per
 * contiguous territory; shared interior edges are suppressed on both sides.
 * `factionAt(q, r)` returns the faction id at a hex position, or null.
 */
export function boundaryEdges(
  sector: { hex: { q: number; r: number }; region: string },
  factionAt: (q: number, r: number) => string | null,
): number[] {
  const out: number[] = [];
  for (let ei = 0; ei < HEX_EDGE_NEIGHBOUR_DIRS.length; ei++) {
    const d = HEX_EDGE_NEIGHBOUR_DIRS[ei]!;
    if (factionAt(sector.hex.q + d.q, sector.hex.r + d.r) !== sector.region) out.push(ei);
  }
  return out;
}

/**
 * The perimeter edges of `sector` that face ANOTHER owner's hex (a front), as
 * opposed to the map edge. Both sides of a front list the shared edge, each
 * drawing its own inset border, so a front reads as a two-colour seam. Pushes
 * into `out` (cleared first) so the layer can reuse a scratch array.
 */
export function frontEdges(
  sector: { hex: { q: number; r: number }; region: string },
  factionAt: (q: number, r: number) => string | null,
  out: number[],
): number[] {
  out.length = 0;
  for (let ei = 0; ei < HEX_EDGE_NEIGHBOUR_DIRS.length; ei++) {
    const d = HEX_EDGE_NEIGHBOUR_DIRS[ei]!;
    const other = factionAt(sector.hex.q + d.q, sector.hex.r + d.r);
    if (other !== null && other !== sector.region) out.push(ei);
  }
  return out;
}

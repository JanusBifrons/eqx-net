/**
 * The ship-look picker's choices (galaxy map 0c): which (colour, sigil) pairs
 * a player may claim, judged by what other players can SEE.
 *
 * Many of the 4096 sigil numbers in a colour slot draw the same emblem: the
 * design keeps only a few discrete parts (layout, fold, spokes, glyph), the
 * rest is small radius jitter, and some parts vanish at ship size. So the
 * picker lists one sigil per emblem that LOOKS different, read from the real
 * generator (`sigilDesign` + `sigilCoverage`) so it cannot drift,
 * and a choice is taken when its emblem, in its colour, is already worn by:
 * any claim, the hash-default look of any player this client knows, or an
 * NPC faction's own mark. The server still refuses an exact clash (claims and
 * known players' defaults, `EconomyStore.claimLook`).
 */
import { sigilCoverage, sigilDesign, type SigilDesign } from './sigil.js';
import {
  PLAYER_LIVERY, SIGIL_COUNT, factionLooksWire, isLookFree, isNpcFactionId, npcFactions, packLook, teamSigilOf,
} from '../../../shared-types/factions.js';

/** What a player sees of an emblem: its layout and discrete parts. The fold
 *  counts only where something is k-fold (a polygon ring or spokes); radii
 *  are jitter and do not make a new emblem. */
export function sigilSignature(d: SigilDesign): string {
  const folded = d.ringShape === 'polygon' || d.spokes === 'bar' || d.spokes === 'point' || d.spokes === 'petal';
  return `${d.archetype}/${folded ? d.fold : 0}/${d.spokes}/${d.glyph}`;
}

/** Emblems are compared as on/off bitmaps this many texels across (a ship
 *  wears its sigil at ~12-40 texels; the picker tile is 24 px). */
export const EMBLEM_TEXELS = 32;
/** Two emblems whose bitmaps differ in at most this many texels look the
 *  same (a small glyph in a ring all but vanishes at ship size). */
export const SAME_EMBLEM_TEXELS = 16;

/** A sigil seed's emblem as an on/off bitmap, `EMBLEM_TEXELS` square. */
export function emblemBitmap(packed: number): Uint8Array {
  const n = EMBLEM_TEXELS, d = sigilDesign(packed), out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) out[y * n + x] = sigilCoverage(d, ((x + 0.5) / n) * 2 - 1, 1 - ((y + 0.5) / n) * 2, 2 / n) >= 0.5 ? 1 : 0;
  }
  return out;
}

/** Texels that differ, counting stops once past `limit`. */
function bitmapDifference(a: Uint8Array, b: Uint8Array, limit: number): number {
  let n = 0;
  for (let i = 0; i < a.length && n <= limit; i++) if (a[i] !== b[i]) n++;
  return n;
}

interface SlotEmblems {
  /** One sigil per visibly distinct emblem (the lowest number drawing it). */
  readonly reps: readonly number[];
  /** Design signature → the rep sigil of the emblem it draws. */
  readonly repOf: ReadonlyMap<string, number>;
}

const SLOTS = new Map<number, SlotEmblems>();

/** Group a slot's 4096 sigils by signature, then merge signatures whose
 *  bitmaps look the same (greedy: each joins the first kept emblem within
 *  `SAME_EMBLEM_TEXELS`, so kept emblems differ pairwise by more). Cached;
 *  the design depends on the slot too (16-bit seed). */
function slotEmblems(colorSlot: number): SlotEmblems {
  let out = SLOTS.get(colorSlot);
  if (out) return out;
  const reps: number[] = [];
  const maps: Uint8Array[] = [];
  const repOf = new Map<string, number>();
  for (let s = 0; s < SIGIL_COUNT; s++) {
    const sig = sigilSignature(sigilDesign(packLook(colorSlot, s)));
    if (repOf.has(sig)) continue;
    const bm = emblemBitmap(packLook(colorSlot, s));
    const same = maps.findIndex((m) => bitmapDifference(m, bm, SAME_EMBLEM_TEXELS) <= SAME_EMBLEM_TEXELS);
    if (same >= 0) { repOf.set(sig, reps[same]!); continue; }
    reps.push(s);
    maps.push(bm);
    repOf.set(sig, s);
  }
  out = { reps: Object.freeze(reps), repOf };
  SLOTS.set(colorSlot, out);
  return out;
}

/** The visual identity of a 16-bit sigil seed: colour slot + emblem. */
export function lookKey(packed: number): string {
  const slot = packed >>> 12;
  return `${slot}:${slotEmblems(slot).repOf.get(sigilSignature(sigilDesign(packed)))}`;
}

/** One sigil per visibly distinct emblem in a colour slot. */
export function distinctSigils(colorSlot: number): readonly number[] {
  return slotEmblems(colorSlot).reps;
}

/** Every look someone else already wears in one colour slot, as `lookKey`s:
 *  claims, the known players' looks (a claim or their hash default), NPC
 *  factions' marks. Only that slot's emblems are built (a slot costs ~25 ms
 *  the first time on desktop, so the picker never builds all of them). */
export function takenLookKeys(colorSlot: number, selfId: string | null, knownPlayerIds: Iterable<string>): Set<string> {
  const seeds: number[] = [];
  for (const l of factionLooksWire()) if (l.factionId !== selfId) seeds.push(packLook(l.colorSlot, l.sigil));
  for (const id of knownPlayerIds) if (id !== selfId && !isNpcFactionId(id)) seeds.push(teamSigilOf(id));
  for (const f of npcFactions()) seeds.push(teamSigilOf(f.id));
  const out = new Set<string>();
  for (const s of seeds) if (s >>> 12 === colorSlot) out.add(lookKey(s));
  return out;
}

export interface LookChoice {
  colorSlot: number;
  sigil: number;
  /** The look the player wears now (claimed or default). */
  current: boolean;
}

/** The free choices in one colour slot, current look included and marked. */
export function lookChoices(colorSlot: number, selfId: string | null, knownPlayerIds: Iterable<string>): LookChoice[] {
  const taken = takenLookKeys(colorSlot, selfId, knownPlayerIds);
  const own = selfId ? teamSigilOf(selfId) : null;
  const mine = own !== null && own >>> 12 === colorSlot ? lookKey(own) : null;
  const out: LookChoice[] = [];
  for (const s of distinctSigils(colorSlot)) {
    const key = lookKey(packLook(colorSlot, s));
    const current = key === mine;
    if (!current && (taken.has(key) || !isLookFree(colorSlot, s, selfId ?? undefined))) continue;
    out.push({ colorSlot, sigil: s, current });
  }
  return out;
}

/** Palette slots in order (the colour row). */
export const LOOK_SLOTS: readonly number[] = Object.freeze(PLAYER_LIVERY.map((_, i) => i));

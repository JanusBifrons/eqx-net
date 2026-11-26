/**
 * The base growth generator (plan soft-leaping-truffle v3, phase D1). Pure.
 *
 * Turns a `BaseProfile` into real catalogue structures the way a builder would:
 *  1. **Plan** what to build from the base's ROLE and WEALTH: the role's chain
 *     (mining → Miners / Gas Collectors; refinery → Smelters, Refineries …),
 *     storage, a Freight Dock, turrets, and at most one huge kind where the
 *     tier allows. Each purchase costs its catalogue `constructionCost` (plus,
 *     for packed kinds, the pack bill's value), until the wealth runs out or
 *     the tier's structure budget is reached.
 *  2. **Lay out** a connector grid around the Capital: rows of connectors with
 *     leaves above and below each one, a bare spine (with relay connectors where
 *     a row gap exceeds connection range), and the huge kind on its own outer
 *     row. Row spacing comes from the tallest structure in the base.
 *  3. **Power** it: Solars until consumption (fence included) is covered, and
 *     batteries for a reserve.
 *  4. **Fence** it (most bases): a rectangle of Shield Pylons around the
 *     extent with a Shield Gate in the middle of each side, tapped from the row
 *     ends.
 *
 * Every placement passes the real `placementRejection` and every edge the real
 * `canConnect`, checked AS the base is built (a slot that fails is skipped), so
 * the result is buildable by construction; `growBase.test.ts` re-checks it.
 */
import { COASTAL_DEFENCE_KINDS, getStructureKind, structureHalfExtents, type StructureKindId } from '../../shared-types/structureKinds.js';
import { RECIPES, packRecipeFor } from '../../shared-types/recipes.js';
import { BASE_PRICES } from '../../shared-types/economy.js';
import { keepClearBox } from '../structures/placementRules.js';
import { MIN_CABLE_LENGTH } from '../structures/structureGridConstants.js';
import { Builder, leafReach, linkGap, RELAY_SPAN, tallestFrom, upDownGunReach, type GrownPlacement } from './growBuilder.js';
import { expectedDraw, summariseGrown, type GrownBase } from './grownSummary.js';
import { layDeckBase, type GrowBaseOptions } from './growDeck.js';
import { powerShareCost } from './powerShareCost.js';
import { roleUnits, type Want } from './roleUnits.js';
import { seededRandom, type BaseProfile, type BaseTier } from './baseProfile.js';
import type { SectorFeature } from '../galaxy/galaxy.js';
import type { GoodId } from '../../shared-types/goods.js';

export type { GrownPlacement } from './growBuilder.js';
export { EXPECTED_ACTIVE, expectedDraw, type GrownBase } from './grownSummary.js';
export type { GrowBaseOptions } from './growDeck.js';

/** Bump on ANY change to the generator's output (NPC bases regenerate from the
 *  seed, so a change moves every base).
 *  9→10 (plan coastal-defences): bases buy a tiered mix of gun batteries
 *  (AA, 5" mounts, coastal guns, region-heart super-guns) from their own
 *  random stream; casemates face outward.
 *  10→11 (structure-restyle 2c++): the freight dock grew to 1000×400, so
 *  every base with a dock lays out wider.
 *  11→12 (structure-restyle): a dock's landing pad (`keepClear`) is kept
 *  clear of other structures, and a dock faces its pad away from its row.
 *  12→13 (structure-restyle main sync): merged main's territory lock into
 *  the stream's generator, so bases saved under the stream's 12 regrow.
 *  13→14 (structure-restyle 3i): the Capital has a crane bay pad on its +y
 *  side; a spine relay that would land on a pad moves just past it.
 *  14→15 (structure-restyle 0d slice 4): link reach is socket to socket, so
 *  the fence sits 50 u closer (`FENCE_MARGIN`) to keep the row-end taps in
 *  reach of the gate posts and pylons.
 *  15→16 (structure-restyle 0d slice 5): a placement may not sit on an
 *  existing link's curved socket-to-socket cable (was the straight centre line).
 *  16→17 (structure-restyle stud audit): sockets sit on the house-look
 *  outline (style c), so cable ends and socket-to-socket reach moved.
 *  17→18: each leaf stands `linkGap` off its connector (`MIN_CABLE_LENGTH`);
 *  a spine relay pushed onto its row line is dropped.
 *  18→19: restyle sizes (Solar 700×300, Reactor/Bank 600×600); power per unit of draw; row gaps fit the leaves facing in.
 *  19→20: landing pads solid to cables, no socket on their side: the spine detours round the Capital's pad up column 1; an unlinkable connector is taken back.
 *  20→21 (restyle F2): wider gate (416), airlock (392) and pylons (120×120); fence pylons 660 apart, each half-side spaced to the gate end (no pylon on a gate).
 *  21→22: one cable per connector socket (max 6): leaf gaps fit the face turned at the leaf; a bastion steps off a fence post on its line.
 *  22→23: cables a body width apart (fan-outs too), min cable 67 u box edge to edge; relays a cable length clear.
 *  23→24 (base platforms 23): growth option `deck` lays the base on plates (`growDeck.ts`); without it the output is unchanged.
 *  24→25 (base platforms 24): a deck plate holds buildings on at most `DECK_HEXES_PER_PLATE` (3) outer hexes, every other hex first (mostly empty deck); rows unchanged. */
export const BASE_GROWTH_VERSION = 25;

/**
 * Most structures a base of each tier may have (fence included). Measured
 * 2026-11-01 with Reactors powering the fence (a Shield Pylon draws 20, a
 * Reactor makes 240): fenced outpost ~43, settlement ~60, stronghold ~116,
 * citadel ~123. Before the Reactor a fenced outpost needed ~78.
 */
export const TIER_MAX_STRUCTURES: Readonly<Record<BaseTier, number>> = Object.freeze({
  outpost: 50,
  settlement: 80,
  stronghold: 160,
  citadel: 260,
});

const PITCH_X = 640;
const GAP = 20;
/** Fence clearance past the outermost structure. Link reach is socket to
 *  socket, so this keeps a row-end connector's tap to the side emitter ≤ 600 u. */
const FENCE_MARGIN = 100;
/** Pylon spacing: centre to centre (120 u pylons, so walls up to 540 u, under
 *  the 600 u edge-to-edge range). Kept at the pre-restyle 660: at 720 the
 *  fewer pylons let a garrison stop shrinking one wealth step early and come
 *  out too big to site (galaxyBases.test.ts, abyssal-gate). */
const FENCE_STEP = 660;
/** A fence gate's centre to where a pylon flush with its end would sit. */
const GATE_CLEAR = getStructureKind('shield_gate').footprint.w / 2 - getStructureKind('shield_pylon').footprint.w / 2;

const CONN = getStructureKind('connector');
const CONN_HALF = CONN.footprint.h / 2;

/** What a structure costs a generated base (minerals-equivalent). */
export function generatedCost(kind: StructureKindId): number {
  const base = getStructureKind(kind).constructionCost;
  const pack = packRecipeFor(kind);
  if (pack === null) return base;
  let v = 0;
  for (const [g, n] of Object.entries(RECIPES[pack].inputs)) v += BASE_PRICES[g as GoodId] * (n ?? 0);
  return base + v;
}

const HUGE: ReadonlySet<StructureKindId> = new Set(['deep_core_rig', 'ore_processing_complex', 'assembly_plant']);

/** Weapons that fire SHOTS. A fence blocks every shot, its owner's own
 *  included (user ruling 2026-11-02), so a fenced base puts these OUTSIDE its
 *  fence, on bastions (see growOnce). */
export const TURRET_KINDS: ReadonlySet<StructureKindId> = new Set<StructureKindId>([
  'turret', 'laser_bolt_turret', 'missile_turret', 'autocannon_turret', ...COASTAL_DEFENCE_KINDS,
]);
/** Guns that fire only through an arc (casemates, the siege gun): a base
 *  turns them to face outward. */
const ARC_LIMITED: ReadonlySet<StructureKindId> = new Set(
  COASTAL_DEFENCE_KINDS.filter((k) => {
    const m = getStructureKind(k).mounts![0]!;
    return m.arcMax - m.arcMin < 2 * Math.PI - 1e-6;
  }),
);
/** Rotation that turns an arc-limited gun (rest bearing +y at 0) to face
 *  (dx, dy): +y → 0, −x → 90, −y → 180, +x → 270. */
function facingRot(dx: number, dy: number): number {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 270 : 90;
  return dy >= 0 ? 0 : 180;
}
/** Random stream for the defence mix, apart from the role/level stream so
 *  picking guns never shifts what else a base builds. */
const DEFENCE_STREAM = 0x3c6ef372;

/**
 * Coastal defences — the guns a base buys for its tier (plan coastal-defences),
 * in buy order: the cheap screen first, the big guns last (wealth runs out on
 * the biggest). Light energy turrets keep the old role; the quad AA screens
 * fighters, the 5" mounts take gunships, the coastal guns take capitals.
 */
function defenceMix(profile: BaseProfile, drnd: () => number): StructureKindId[] {
  const energy = (): StructureKindId => (drnd() < 0.5 ? 'turret' : 'laser_bolt_turret');
  const out: StructureKindId[] = [...(profile.superGuns ?? [])];
  switch (profile.tier) {
    case 'outpost':
      out.push(energy());
      if (drnd() < 0.5) out.push('aa_quad_40mm');
      break;
    case 'settlement':
      out.push(energy(), 'aa_quad_40mm', 'dp_mount_5in');
      if (drnd() < 0.5) out.push('dp_mount_5in');
      break;
    case 'stronghold':
      out.push(energy(), energy(), 'aa_quad_40mm', 'dp_mount_5in', 'dp_mount_5in');
      out.push(drnd() < 0.65 ? 'coastal_casemate_8in' : 'coastal_turret_11in');
      break;
    case 'citadel':
      out.push(energy(), energy(), 'aa_quad_40mm', 'aa_quad_40mm', 'dp_mount_5in', 'dp_mount_5in');
      out.push(drnd() < 0.5 ? 'coastal_casemate_8in' : 'coastal_turret_11in', 'coastal_barbette_16in');
      if (drnd() < 0.5) out.push('coastal_lindemann');
      break;
  }
  return out;
}
/** A bastion's inside relay sits this far inside the fence line, its hub this
 *  far outside (both clear of the pylons' boxes). */
const BASTION_IN = 120;
const BASTION_OUT = 220;
/** How far a bastion's outward gun stands off past its hub, so guns above
 *  and below the hub (half-width up to this) fit beside a big battery. */
const OUTWARD_CLEAR = 130;

/** The build list: what the base buys, within its wealth and tier budget. */
function planBuild(profile: BaseProfile, features: readonly SectorFeature[], rnd: () => number, drnd: () => number): { wants: Want[]; spent: number } {
  const wants: Want[] = [];
  let budget = profile.wealth;
  let spent = 0;
  const cap = Math.floor(TIER_MAX_STRUCTURES[profile.tier] * 0.6); // leave room for connectors, power, fence
  const unitCap = { outpost: 2, settlement: 5, stronghold: 10, citadel: 16 }[profile.tier];
  const storageCap = { outpost: 2, settlement: 4, stronghold: 8, citadel: 14 }[profile.tier] * (profile.role === 'trade' ? 2 : 1);
  const counts = new Map<StructureKindId, number>();
  const buy = (w: Want): boolean => {
    const n = counts.get(w.kind) ?? 0;
    const storage = w.kind === 'cargo_bay' || w.kind === 'freight_dock';
    if (n >= (storage ? storageCap : unitCap)) return false;
    // A purchase includes its share of the Solars that power it (per unit of draw).
    const c = generatedCost(w.kind) + powerShareCost(expectedDraw(w.kind));
    if (c > budget || wants.length >= cap) return false;
    counts.set(w.kind, n + 1);
    budget -= c;
    spent += c;
    wants.push(w);
    return true;
  };
  // Every trading base has a dock and some storage; defence scales with tier.
  // (A military base trades nothing: its cargo bay holds munitions and fuel.)
  if (profile.role !== 'military') buy({ kind: 'freight_dock' });
  buy({ kind: 'cargo_bay' });
  // Coastal defences: a tiered mix of gun batteries (super-guns first).
  for (const kind of defenceMix(profile, drnd)) buy({ kind });
  // Big bases mine their approaches.
  const mineLayers = { outpost: 0, settlement: 0, stronghold: 1, citadel: 2 }[profile.tier] + (profile.role === 'military' ? 1 : 0);
  for (let t = 0; t < mineLayers; t++) buy({ kind: 'mine_layer' });
  // The role's chain, repeated (huge kinds once) while wealth lasts.
  const units = roleUnits(profile, features, rnd);
  let hugeBought = false;
  for (let round = 0; round < 200; round++) {
    let any = false;
    for (const u of units) {
      if (HUGE.has(u.kind)) {
        if (hugeBought) continue;
        if (buy(u)) { hugeBought = true; any = true; }
        continue;
      }
      if (buy(u)) any = true;
    }
    // Trade hubs and every 3rd round: more storage.
    if (profile.role === 'trade' || round % 3 === 2) {
      if (buy({ kind: profile.role === 'trade' && round % 4 === 3 ? 'freight_dock' : 'cargo_bay' })) any = true;
    }
    if (!any) break;
  }
  return { wants, spent };
}

/**
 * Grow a base. `features` are the sector's (refinery recipes, gas). Pure and
 * deterministic per (profile, seed).
 */
export function growBase(profile: BaseProfile, seed: number, features: readonly SectorFeature[] = [], opts: GrowBaseOptions = {}): GrownBase {
  // Lay out, measure the real draw (the fence size depends on the layout),
  // then lay out again with enough Solars. Converges in a few passes.
  // A base that comes out over its tier's budget spends less and regrows.
  let p = profile;
  const deck = opts.deck === true;
  let out = balanced(p, seed, features, deck);
  for (let pass = 0; pass < 8 && out.placements.length > TIER_MAX_STRUCTURES[profile.tier]; pass++) {
    p = { ...p, wealth: Math.floor(p.wealth * 0.85) };
    out = balanced(p, seed, features, deck);
  }
  return out;
}

function balanced(profile: BaseProfile, seed: number, features: readonly SectorFeature[], deck: boolean): GrownBase {
  let extra = 0;
  let out = growOnce(profile, seed, features, extra, deck);
  for (let pass = 0; pass < 6 && out.netPower < 0; pass++) {
    extra += Math.ceil(-out.netPower / getStructureKind('solar').powerOutput) + 1;
    out = growOnce(profile, seed, features, extra, deck);
  }
  return out;
}

function growOnce(profile: BaseProfile, seed: number, features: readonly SectorFeature[], extraSolars: number, deck: boolean): GrownBase {
  const rnd = seededRandom(seed ^ 0x5bd1e995);
  const { wants, spent } = planBuild(profile, features, rnd, seededRandom(seed ^ DEFENCE_STREAM));
  // v4 H — one teleporter per transit link this base ends (outside the budget:
  // the network needs both ends).
  for (const id of profile.links ?? []) wants.push({ kind: 'teleporter', link: id });
  // Sector control — a heart garrison's Territory Lock (outside the budget too).
  if (profile.territoryLock === true) wants.push({ kind: 'territory_lock' });
  const huge = wants.filter((w) => HUGE.has(w.kind));
  // A fenced base's turrets go on bastions outside the fence (placed after it).
  const posts = profile.fenced ? wants.filter((w) => TURRET_KINDS.has(w.kind)) : [];
  const normal = wants.filter((w) => !HUGE.has(w.kind) && !(profile.fenced && TURRET_KINDS.has(w.kind)));
  // Power: role consumption + an estimate for the fence; Solars to cover it,
  // a battery per ~4 consumers for a reserve.
  let consumption = 0;
  for (const w of wants) consumption += expectedDraw(w.kind);
  // The fence's draw is measured after layout (see growBase); start with none.
  const fenceDraw = 0;
  const capOut = getStructureKind('capital').powerOutput;
  const solar = getStructureKind('solar').powerOutput;
  // Power the deficit with Reactors (fuel-burning, ~8 Solars each) and the
  // remainder with Solars. A bigger base banks its reserve in a Battery Bank.
  const reactorOut = getStructureKind('reactor').powerOutput;
  const deficit = Math.max(0, consumption + fenceDraw - capOut) + extraSolars * solar;
  const reactors = Math.floor(deficit / reactorOut);
  const solars = Math.max(0, Math.ceil((deficit - reactors * reactorOut) / solar));
  for (let r = 0; r < reactors; r++) normal.push({ kind: 'reactor' });
  for (let s = 0; s < solars; s++) normal.push({ kind: 'solar' });
  // Batteries are a real strategy (user): a fence under fire drains the grid's
  // surplus and then its batteries, so fenced bases bank extra reserve.
  const batteries = Math.max(1, Math.round(wants.length / 6)) + (profile.fenced ? 2 : 0);
  if (batteries >= 5) normal.push({ kind: 'battery_bank' });
  else for (let b = 0; b < batteries; b++) normal.push({ kind: 'battery' });
  // Base platforms: on a deck the base stands on plates (no fence yet: its guns stand on the deck).
  if (deck) return summariseGrown(layDeckBase([...normal, ...huge, ...posts]), profile, rnd, spent, 0, 0);

  // A row gap fits the tallest leaves facing in: on the inner row's side (`${row}:${side}`), or still to place.
  const reach = Math.max(0, ...normal.map((w) => leafReach(w.kind)));
  const gaps = { left: reach, side: new Map([1, -1].map((s): [string, number] => [`0:${s}`, structureHalfExtents('capital', 0).hh])) };
  // Columns per side: enough slots for the base with a square-ish shape.
  // (A heart's Territory Lock is one extra leaf: it takes a free slot, never
  // widens the base — sector control.)
  const sized = normal.length - (profile.territoryLock === true ? 1 : 0);
  const cols = Math.max(1, Math.ceil(Math.sqrt(sized / 2) * 0.8));

  const B = new Builder();
  const cap = B.tryPlace({ kind: 'capital', x: 0, y: 0 });
  const padDir = Math.sign(keepClearBox('capital', 0, 0, 0)!.y); // its crane-bay pad's side of the spine (solid to cables)
  const rowConn = new Map<number, number[]>(); // row j → connector index per column (-cols..cols, spine at 0)
  const spineAt = new Map<number, number>(); // row j → spine connector (or the Capital for j = 0)
  spineAt.set(0, cap);

  // Rows grow outward: 0, 1, -1, 2, -2, …
  const rowOrder: number[] = [0];
  const rowY = new Map<number, number>([[0, 0]]);
  /** Where row j (one step out from row `from`) goes: a pitch out, or
   *  further when a keep-clear apron (a dock's landing pad, turned away from
   *  its row) already reaches into that gap: the new row's connectors clear
   *  it, or the row would break off at the pad. Only gaps with a pad grow. */
  const nextRowY = (from: number, dir: number): number => {
    const fy = rowY.get(from)!;
    let need = Math.max(gaps.side.get(`${from}:${dir}`) ?? 0, gaps.left) + gaps.left + GAP;
    for (const q of B.placed) {
      const pad = keepClearBox(q.kind, q.x, q.y, q.rot);
      if (pad === null) continue;
      const far = dir > 0 ? pad.y + pad.hh - fy : fy - (pad.y - pad.hh);
      const near = dir > 0 ? pad.y - pad.hh - fy : fy - (pad.y + pad.hh);
      if (near >= 0) need = Math.max(need, far + CONN_HALF);
    }
    return fy + dir * need;
  };
  const addRow = (j: number): boolean => {
    if (rowConn.has(j)) return true;
    const from = j - Math.sign(j);
    if (!spineAt.has(from)) return false; // the row nearer 0 never formed
    const y = rowY.get(j) ?? nextRowY(from, Math.sign(j));
    rowY.set(j, y);
    let spine = spineAt.get(j), col = -1; // col: this row's column 1 when the spine detoured up it
    if (spine === undefined) {
      // Spine connector at (0, y), reached through relays from the row nearer 0.
      // Across the Capital's pad the spine detours up column 1 (its row-0
      // leaf slot is kept free for it), then steps in to (0, y).
      const sx = from === 0 && Math.sign(j) === padDir ? PITCH_X : 0;
      let prev = sx === 0 ? spineAt.get(from)! : rowConn.get(0)!.find((c) => B.placements[c]!.x === sx) ?? -1;
      if (prev < 0) return false;
      const prevY = rowY.get(from)!;
      const span = Math.abs(y - prevY);
      const relays = Math.max(0, Math.ceil((span - 2 * CONN_HALF) / RELAY_SPAN) - 1);
      for (let r = 1; r <= relays; r++) {
        const at = B.placed[prev]!; // and at least a cable length (edge to edge) past the last link's box
        let ry = at.y + Math.sign(j) * Math.max(Math.abs(prevY + Math.sign(j) * (span * r) / (relays + 1) - at.y), at.halfH + CONN_HALF + MIN_CABLE_LENGTH);
        // A keep-clear pad on the spine (the Capital's crane bay, out from
        // its +y side): the relay moves out past the pad's far side.
        for (const q of B.placed) {
          const pad = keepClearBox(q.kind, q.x, q.y, q.rot);
          if (pad === null || Math.abs(pad.x - sx) >= pad.hw + CONN_HALF || Math.abs(ry - pad.y) >= pad.hh + CONN_HALF) continue;
          ry = pad.y + Math.sign(j) * (pad.hh + CONN_HALF + GAP);
        }
        // A relay pushed past a pad onto the row line is dropped: the spine
        // links the previous one directly (or the row fails, as before).
        if (Math.sign(j) * (y - ry) < 2 * CONN_HALF + linkGap('connector', 0, Math.sign(j))) continue;
        const ri = B.placeLinked({ kind: 'connector', x: sx, y: ry }, prev);
        if (ri < 0) return false;
        prev = ri;
      }
      if (sx !== 0) col = prev = B.placeLinked({ kind: 'connector', x: sx, y }, prev);
      spine = prev < 0 ? -1 : B.placeLinked({ kind: 'connector', x: 0, y }, prev);
      if (spine < 0) return false;
      spineAt.set(j, spine);
    }
    const row = col < 0 ? B.chainConnectors(spine, PITCH_X, PITCH_X, y, cols) : [col, ...B.chainConnectors(col, 2 * PITCH_X, PITCH_X, y, cols - 1)];
    row.push(...B.chainConnectors(spine, -PITCH_X, -PITCH_X, y, cols));
    rowConn.set(j, row);
    return true;
  };

  // Fill leaf slots, biggest first (they need the room), nearest rows first.
  const queue = [...normal].sort((a, b) => {
    const fa = getStructureKind(a.kind).footprint, fb = getStructureKind(b.kind).footprint;
    return fb.w * fb.h - fa.w * fa.h;
  });
  const used = new Set<string>();
  let rowCursor = 0;
  const left = tallestFrom(queue.map((w) => w.kind));
  addRow(0);
  used.add(`${rowConn.get(0)!.find((c) => B.placements[c]!.x === PITCH_X)}:${padDir}`); // row 0 column 1's pad-side slot: the spine detour's
  for (const [qi, w] of queue.entries()) {
    gaps.left = left[qi]!;
    let placedIt = false;
    for (let attempt = 0; attempt < 64 && !placedIt; attempt++) {
      for (const j of rowOrder) {
        for (const c of rowConn.get(j) ?? []) {
          for (const side of [1, -1]) {
            const key = `${c}:${side}`;
            if (used.has(key)) continue;
            const conn = B.placements[c]!;
            const fp = getStructureKind(w.kind).footprint;
            if (profile.fenced && fp.w > PITCH_X - GAP && Math.abs(conn.x) === cols * PITCH_X && cols > 2) continue; // a leaf wider than a column (a Solar) stays off a big fenced base's end columns: it would widen the fence
            const p: GrownPlacement = { kind: w.kind, x: conn.x, y: conn.y + side * (CONN_HALF + GAP + fp.h / 2) };
            // An arc-limited gun (unfenced base) faces away from the Capital.
            if (ARC_LIMITED.has(w.kind)) p.rot = p.y + side >= 0 ? 0 : 180;
            // A kind with a keep-clear apron (a dock's landing pad, on its +y
            // side) turns it away from its row, out over open space.
            else if (getStructureKind(w.kind).keepClear !== undefined && side < 0) p.rot = 180;
            p.y = conn.y + side * (CONN_HALF + linkGap(w.kind, 0, side, p.rot ?? 0) + fp.h / 2);
            if (w.recipe) p.recipe = w.recipe;
            if (w.link) p.link = w.link;
            const li = B.tryPlace(p);
            if (li < 0) continue;
            if (!B.tryLink(c, li)) { B.undoLast(); continue; }
            used.add(key);
            gaps.side.set(`${j}:${side}`, Math.max(gaps.side.get(`${j}:${side}`) ?? 0, Math.abs(p.y - conn.y) + fp.h / 2));
            placedIt = true;
            break;
          }
          if (placedIt) break;
        }
        if (placedIt) break;
      }
      if (!placedIt) {
        rowCursor++;
        const j = rowCursor % 2 === 1 ? (rowCursor + 1) / 2 : -rowCursor / 2;
        if (!addRow(j)) break;
        rowOrder.push(j);
      }
    }
  }
  gaps.left = upDownGunReach(posts.map((w) => w.kind), (k) => (ARC_LIMITED.has(k) ? facingRot(1, 0) : 0)); // rows from here hold bastions: guns above and below their hubs face in

  // The huge kind sits on its own outer row above the base (its far side free).
  for (const w of huge) {
    const top = Math.max(...rowConn.keys()) + 1;
    if (!addRow(top)) continue;
    rowOrder.push(top);
    const spine = spineAt.get(top)!;
    const fp = getStructureKind(w.kind).footprint;
    // Its own short spine extension (relays past the link range), then the huge kind beyond it.
    const ext = B.reachOut(spine, reach);
    if (ext < 0) continue;
    const p: GrownPlacement = { kind: w.kind, x: 0, y: B.placements[ext]!.y + CONN_HALF + linkGap(w.kind, 0, 1) + fp.h / 2 };
    if (w.recipe) p.recipe = w.recipe;
    const li = B.tryPlace(p);
    if (li >= 0 && !B.tryLink(ext, li)) B.undoLast();
  }

  // Bastions reach out from a row's end connector, and the side gates sit on
  // row 0, so a fenced base with turrets needs a row off the gate line.
  if (posts.length > 0 && ![...rowConn.keys()].some((j) => j !== 0)) {
    if (addRow(-1)) rowOrder.push(-1);
  }
  // v4 M — a garrison is mostly guns: give it a row (two bastions, up to six
  // guns) for every six it bought.
  if (profile.role === 'military') {
    const need = Math.ceil(posts.length / 6);
    for (let k = 1; [...rowConn.keys()].filter((j) => j !== 0).length < need && k <= 6; k++) {
      for (const j of [-k, k]) {
        if (rowConn.has(j)) continue;
        if (addRow(j)) rowOrder.push(j);
      }
    }
  }

  // Fence: a rectangle around everything, a gate mid-side, row ends tapped.
  let fencePylons = 0;
  let fenceGates = 0;
  if (profile.fenced) {
    let fx = 0, fy = 0;
    for (const q of B.placed) {
      fx = Math.max(fx, Math.abs(q.x) + q.halfW);
      fy = Math.max(fy, Math.abs(q.y) + q.halfH);
      // A dock's landing pad is inside the fence too (the fence may not cross it).
      const pad = keepClearBox(q.kind, q.x, q.y, q.rot);
      if (pad !== null) {
        fx = Math.max(fx, Math.abs(pad.x) + pad.hw);
        fy = Math.max(fy, Math.abs(pad.y) + pad.hh);
      }
    }
    fx = Math.ceil((fx + FENCE_MARGIN) / 10) * 10;
    fy = Math.ceil((fy + FENCE_MARGIN) / 10) * 10;
    const along = (a: number, b: number): number[] => {
      const n = Math.max(1, Math.ceil(Math.abs(b - a) / FENCE_STEP));
      const out: number[] = [];
      for (let k = 0; k < n; k++) out.push(a + ((b - a) * k) / n);
      return out;
    };
    // Ring points (counter-clockwise from bottom-left), a gate in the middle
    // (0 on the free axis) of each side. Each half-side is spaced up to where
    // a pylon flush with the gate's end would sit, so no pylon overlaps the
    // gate and no wall is longer than a pylon-to-pylon one.
    const ring: Array<[number, number, number]> = []; // x, y, rot (-1 = pylon)
    const side = (from: [number, number], to: [number, number], gateRot: number) => {
      const h = from[1] === to[1], a = h ? from[0] : from[1], b = h ? to[0] : to[1];
      const c = Math.sign(b - a) * GATE_CLEAR;
      const at = (t: number, rot: number): [number, number, number] => (h ? [t, from[1], rot] : [from[0], t, rot]);
      for (const t of along(a, -c)) ring.push(at(t, -1));
      ring.push(at(0, gateRot));
      for (const t of along(c, b).slice(1)) ring.push(at(t, -1));
    };
    side([-fx, -fy], [fx, -fy], 0);
    side([fx, -fy], [fx, fy], 90);
    side([fx, fy], [-fx, fy], 0);
    side([-fx, fy], [-fx, -fy], 90);
    const first = B.placements.length;
    const idx: number[] = [];
    for (const [x, y, rot] of ring) {
      const i = rot >= 0
        ? B.tryPlace({ kind: 'shield_gate', x, y, rot })
        : B.tryPlace({ kind: 'shield_pylon', x, y });
      if (i >= 0) {
        idx.push(i);
        if (rot >= 0) fenceGates++;
      }
    }
    fencePylons = B.placements.length - first;
    for (let k = 0; k < idx.length; k++) B.tryLink(idx[k]!, idx[(k + 1) % idx.length]!);
    // Bastions: turrets OUTSIDE the fence, so their fire never crosses their
    // own wall. From a row's end connector, a relay just inside the fence links
    // (between two pylons) to a hub just outside; turrets hang off the hub.
    // Rows nearest the middle first, off the gate row; each hub takes up to 3.
    const rowsByDistance = [...rowConn.keys()].filter((j) => j !== 0).sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
    // Coastal defences: build the bastions first (enough hubs for the guns at
    // up to three each), then seat the guns biggest first: the big batteries
    // take the outward slots (clear water, no fence beside them), the rest go
    // above and below. An arc-limited gun turns to face out from the base.
    const hubs: Array<{ hub: number; sideX: number; y: number }> = [];
    const hubsNeeded = Math.ceil(posts.length / 3);
    for (const j of rowsByDistance) {
      for (const sideX of [1, -1]) {
        if (hubs.length >= hubsNeeded) break;
        const end = (rowConn.get(j) ?? []).find((c) => B.placements[c]!.x === sideX * cols * PITCH_X);
        if (end === undefined) continue;
        const b = B.bastion(end, sideX * (fx - BASTION_IN), sideX * (fx + BASTION_OUT), B.placements[end]!.y);
        if (b !== null) hubs.push({ hub: b.hub, sideX, y: b.y });
      }
      if (hubs.length >= hubsNeeded) break;
    }
    const byArea = [...posts].sort((a, b) => {
      const fa = getStructureKind(a.kind).footprint, fb = getStructureKind(b.kind).footprint;
      return fb.w * fb.h - fa.w * fa.h;
    });
    const seated = new Array<boolean>(byArea.length).fill(false);
    const seat = (h: { hub: number; sideX: number; y: number }, slot: number): void => {
      for (let k = 0; k < byArea.length; k++) {
        if (seated[k]) continue;
        const w = byArea[k]!;
        const rot = ARC_LIMITED.has(w.kind) ? facingRot(h.sideX, 0) : 0;
        const { hw, hh } = structureHalfExtents(w.kind, rot);
        const hx = B.placements[h.hub]!.x;
        // The outward gun stands off past the hub so guns above and below it
        // (up to OUTWARD_CLEAR half-width) still fit beside it.
        const p: GrownPlacement = slot === 0
          ? { kind: w.kind, x: hx + h.sideX * (CONN_HALF + linkGap(w.kind, h.sideX, 0, rot) + OUTWARD_CLEAR + hw), y: h.y }
          : { kind: w.kind, x: hx, y: h.y + slot * (CONN_HALF + linkGap(w.kind, 0, slot, rot) + hh) };
        if (rot !== 0) p.rot = rot;
        const li = B.tryPlace(p);
        if (li < 0) continue; // try a smaller gun in this slot
        if (!B.tryLink(h.hub, li)) { B.undoLast(); continue; }
        seated[k] = true;
        return;
      }
    };
    for (const h of hubs) seat(h, 0);
    for (const slot of [1, -1]) for (const h of hubs) seat(h, slot);
    // Guns that found no bastion are left out rather than placed inside
    // the fence, where their own wall would stop every shot.
    // Taps: every row's end connectors link the nearest side emitter.
    for (const [, row] of rowConn) {
      for (const c of row) {
        const cp = B.placements[c]!;
        if (Math.abs(cp.x) !== cols * PITCH_X) continue;
        let best = -1, bestD = Infinity;
        for (const e of idx) {
          const ep = B.placements[e]!;
          if (Math.sign(ep.x) !== Math.sign(cp.x) || Math.abs(ep.x) !== fx) continue;
          const d = Math.abs(ep.y - cp.y);
          if (d < bestD) { bestD = d; best = e; }
        }
        if (best >= 0) B.tryLink(c, best);
      }
    }

  }

  return summariseGrown(B, profile, rnd, spent, fencePylons, fenceGates);
}

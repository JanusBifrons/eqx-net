/**
 * Sector control for EVERY side (galaxy-map plan, Step 1). Pure, zone-blind.
 * The live game steps it from `RobotTerritory` on the control tick.
 *
 * Shares move toward their targets at a bounded rate, so a passing squad
 * doesn't flip a sector instantly. Ownership has HYSTERESIS: a side CLAIMS a
 * sector at >= CLAIM_AT and only loses it at <= RELEASE_AT, so a contested
 * frontier doesn't flicker on the galaxy map.
 */

export const CONTROL_MAX = 100;
export const CLAIM_AT = 60;
export const RELEASE_AT = 20;
/** Pressure change per second toward the target (≈ 40 s from 0 to a claim). */
export const PRESSURE_RATE_PER_S = 1.5;

/** Pressure contributions (balance knobs). */
export const PRESSURE_PER_ROBOT = 12;
export const PRESSURE_NEXUS = 80;
export const PRESSURE_PER_STRUCTURE = 6;
export const PRESSURE_PER_SHIP = 15;

// ---------------------------------------------------------------------------
// One meter for everyone (owner rules): everything capturable, any faction
// may hold.
//
// Model:
//  - Each side present pushes RAW pressure: ships×15 + structures×6 +
//    robots×12 + nexus×80.
//  - A side's target share = support − opposition, clamped to [0, 100]:
//      support    = raw of every present side that does NOT oppose it (itself
//                   and its friends — allies never weaken each other),
//      opposition = raw of every present side that opposes it.
//  - Shares move toward their targets at PRESSURE_RATE_PER_S.
//  - Holder hysteresis: the holder loses the sector at ≤ RELEASE_AT (it
//    becomes neutral ground); with no holder, the leading side claims at
//    ≥ CLAIM_AT.
//  - An EMPTY sector (no raw pressure from anyone) keeps its state, so held
//    ground stays held until someone turns up to contest it.
//  - LOCK (owner rule "frozen until destroyed"): while the HOLDER has a live
//    lock in the sector (`lockedBy` contains it), the holder is never released
//    and nobody else can claim. Shares still move, so the siege still shows
//    (challenger, trend, contested). Once the lock is gone the normal rules
//    resume on the next step. A lock owned by a non-holder does nothing. The
//    robots' nexus is the robots' lock.
// ---------------------------------------------------------------------------

/** One side's presence in a sector. */
export interface SidePresence {
  ships: number;
  structures: number;
  robots: number;
  nexus: boolean;
}

/** factionId → presence, for the sides present in one sector. */
export type SectorPresence = ReadonlyMap<string, SidePresence>;

/** True when faction `a` works against faction `b` (symmetric in practice). */
export type OpposesFn = (a: string, b: string) => boolean;

export interface MultiControlState {
  /** factionId → share in [0, 100]. Absent = 0. */
  shares: Map<string, number>;
  /** The side holding the sector, or null for neutral ground. */
  holder: string | null;
}

export interface ControlStepResult {
  /** True when `holder` changed this step. */
  flipped: boolean;
  /** Holder before this step (only meaningful when `flipped`). */
  previousHolder: string | null;
}

export function freshMultiControl(holder: string | null = null): MultiControlState {
  const shares = new Map<string, number>();
  if (holder) shares.set(holder, CONTROL_MAX);
  return { shares, holder };
}

/** Raw pressure one side's presence pushes. */
export function rawPressure(p: SidePresence): number {
  return (
    p.ships * PRESSURE_PER_SHIP +
    p.structures * PRESSURE_PER_STRUCTURE +
    p.robots * PRESSURE_PER_ROBOT +
    (p.nexus ? PRESSURE_NEXUS : 0)
  );
}

function clampShare(v: number): number {
  return Math.max(0, Math.min(CONTROL_MAX, v));
}

/** The share `side` is heading toward for this presence. */
export function targetShare(side: string, presence: SectorPresence, opposes: OpposesFn): number {
  let support = 0;
  let opposition = 0;
  for (const [other, p] of presence) {
    const raw = rawPressure(p);
    if (raw <= 0) continue;
    if (other !== side && opposes(side, other)) opposition += raw;
    else support += raw;
  }
  return clampShare(support - opposition);
}

function totalRaw(presence: SectorPresence): number {
  let t = 0;
  for (const p of presence.values()) t += rawPressure(p);
  return t;
}

/**
 * Advance one sector by `dtMs`. Mutates `s`. Deterministic: ties between
 * would-be claimants break by factionId order. `lockedBy` = the sides with a
 * live lock in this sector; only the holder's lock counts (see LOCK above).
 */
export function stepMultiControl(
  s: MultiControlState,
  presence: SectorPresence,
  opposes: OpposesFn,
  dtMs: number,
  lockedBy: ReadonlySet<string> | null = null,
): ControlStepResult {
  const previousHolder = s.holder;
  if (totalRaw(presence) <= 0) return { flipped: false, previousHolder };

  const maxStep = (PRESSURE_RATE_PER_S * Math.max(0, dtMs)) / 1000;
  const sides = new Set<string>([...s.shares.keys(), ...presence.keys()]);
  if (s.holder) sides.add(s.holder);
  for (const side of sides) {
    const cur = s.shares.get(side) ?? 0;
    const delta = targetShare(side, presence, opposes) - cur;
    const next = clampShare(cur + (Math.abs(delta) <= maxStep ? delta : Math.sign(delta) * maxStep));
    if (next <= 0 && side !== s.holder && !presence.has(side)) s.shares.delete(side);
    else s.shares.set(side, next);
  }

  // A locked holder is frozen: never released, so nobody else can claim.
  if (s.holder && lockedBy?.has(s.holder)) return { flipped: false, previousHolder };
  if (s.holder && (s.shares.get(s.holder) ?? 0) <= RELEASE_AT) s.holder = null;
  if (!s.holder) {
    let best: string | null = null;
    let bestShare = -1;
    for (const side of [...s.shares.keys()].sort()) {
      const v = s.shares.get(side) ?? 0;
      if (v > bestShare) { best = side; bestShare = v; }
    }
    if (best && bestShare >= CLAIM_AT) s.holder = best;
  }
  return { flipped: s.holder !== previousHolder, previousHolder };
}

/** The strongest side working against the holder (or the leader when neutral). */
export function challengerOf(s: MultiControlState, opposes: OpposesFn): { factionId: string; share: number } | null {
  let best: { factionId: string; share: number } | null = null;
  for (const side of [...s.shares.keys()].sort()) {
    if (side === s.holder) continue;
    if (s.holder && !opposes(s.holder, side)) continue;
    const share = s.shares.get(side) ?? 0;
    if (share > 0 && (!best || share > best.share)) best = { factionId: side, share };
  }
  return best;
}

/** −1 holder losing ground, 0 steady, +1 gaining (or 0 when neutral). */
export function holderTrend(s: MultiControlState, presence: SectorPresence, opposes: OpposesFn): -1 | 0 | 1 {
  if (!s.holder || totalRaw(presence) <= 0) return 0;
  const d = targetShare(s.holder, presence, opposes) - (s.shares.get(s.holder) ?? 0);
  return d > 0.5 ? 1 : d < -0.5 ? -1 : 0;
}

/** Held, with an opposing side present. */
export function isMultiContested(s: MultiControlState, presence: SectorPresence, opposes: OpposesFn): boolean {
  if (!s.holder) return false;
  for (const [side, p] of presence) {
    if (side !== s.holder && opposes(s.holder, side) && rawPressure(p) > 0) return true;
  }
  return false;
}

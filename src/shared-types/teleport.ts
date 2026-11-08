/**
 * Teleporters (plan soft-leaping-truffle v4, T1). Shared by server and client
 * (invariant #15): pad sizes, the charge a jump needs, the jump cycle's
 * phases and timings, and the owner's firing rules.
 *
 * A teleporter pairs with exactly one partner. A jump is a two-way SWAP: what
 * sits on each pad (ships, and each pad's own hold) trades places at the same
 * moment. Each end charges its own capacitor from the grid's spare power; only
 * the end that fires spends a charge, and the charge depends only on distance.
 */
import { z } from 'zod';
import { GOOD_IDS } from './goods.js';

export const TELEPORTER_KINDS = ['teleporter', 'teleporter_large', 'alien_gate', 'pocket_pad'] as const;
export type TeleporterKind = (typeof TELEPORTER_KINDS)[number];

export function isTeleporterKind(kind: string | null | undefined): kind is TeleporterKind {
  return kind === 'teleporter' || kind === 'teleporter_large' || kind === 'alien_gate' || kind === 'pocket_pad';
}

/** v4 A — the Ancients' border gate: a teleporter nobody owns or builds. */
export function isAlienGateKind(kind: string | null | undefined): kind is 'alien_gate' {
  return kind === 'alien_gate';
}

/**
 * A teleporter that costs nothing and belongs to no grid: the Ancients' gates
 * and the transit pads between pockets (W1b). No capacitor, always "powered",
 * ships only (no pad hold), can't be damaged. Only gates jump on a timetable.
 */
export function isFreeTeleporterKind(kind: string | null | undefined): kind is 'alien_gate' | 'pocket_pad' {
  return kind === 'alien_gate' || kind === 'pocket_pad';
}

export interface PadSpec {
  /** Radius of the open pad: a ship whose centre is inside it rides. */
  readonly padRadius: number;
  /** Weight the pad's own hold carries. */
  readonly padCapacity: number;
  /** Side of each corner post (the solid parts; ships enter between them). */
  readonly post: number;
  /** Number of posts round the pad. */
  readonly posts: number;
}

/**
 * Pad sizes. A small pad fits a squad of small ships plus one medium or large
 * hull squeezed in; a large pad is sized for capital ships to come.
 */
export const PAD_SPECS: Readonly<Record<TeleporterKind, PadSpec>> = Object.freeze({
  teleporter: { padRadius: 320, padCapacity: 400, post: 80, posts: 4 },
  teleporter_large: { padRadius: 900, padCapacity: 4000, post: 160, posts: 8 },
  // v4 A — bigger than a small pad; no hold (alien gates carry ships only).
  alien_gate: { padRadius: 640, padCapacity: 0, post: 100, posts: 12 },
  // W1b — a small pad's size; ships only.
  pocket_pad: { padRadius: 320, padCapacity: 0, post: 80, posts: 4 },
});

// ── Charge ──────────────────────────────────────────────────────────────────

/** A cross-sector hop counts as this many world units of distance. */
export const TELEPORT_HOP_DISTANCE_U = 20_000;
/** Every jump costs this much, however short. */
export const JUMP_BASE_CHARGE = 600;
/** Charge per world unit of distance. */
export const JUMP_CHARGE_PER_U = 0.15;

/**
 * The charge a jump needs. Only distance matters (user ruling 2026-11-02): in
 * one sector it is the straight-line distance between the pads; across
 * sectors each hop counts as `TELEPORT_HOP_DISTANCE_U`. A mid-size base's
 * spare power refills an in-sector jump in about a minute or two.
 */
export function jumpCharge(distanceU: number): number {
  return Math.round(JUMP_BASE_CHARGE + JUMP_CHARGE_PER_U * Math.max(0, distanceU));
}

/** The jump distance between two pads (`hops` = 0 in the same sector). */
export function jumpDistance(hops: number, ax: number, ay: number, bx: number, by: number): number {
  return hops > 0 ? hops * TELEPORT_HOP_DISTANCE_U : Math.hypot(bx - ax, by - ay);
}

// ── The jump cycle (like train doors closing) ───────────────────────────────

/**
 * 0 idle; 1 armed (everyone on either pad is warned); 2 closing (a slow shield
 * iris closes round the edge, gently pushing straddlers in or out); 3 sealed
 * (the barrier is solid, the pad charges up); then the swap; 4 open (the iris
 * opens again). Both pads run it together.
 */
export const TP_PHASE = Object.freeze({ IDLE: 0, ARMED: 1, CLOSING: 2, SEALED: 3, OPEN: 4 });
export type TpPhase = 0 | 1 | 2 | 3 | 4;

/** How long each phase lasts (ms), before any test speed-up. */
export const TP_PHASE_MS: Readonly<Record<1 | 2 | 3 | 4, number>> = Object.freeze({ 1: 5000, 2: 4000, 3: 3000, 4: 2000 });

// ── Alien gates (v4 A) ──────────────────────────────────────────────────────

/** An alien gate jumps on its own once a minute. */
export const ALIEN_GATE_INTERVAL_MS = 60_000;
/** Its jump cycle runs at this fraction of a built teleporter's (~5 s). */
export const ALIEN_GATE_CYCLE_SCALE = 0.36;

/**
 * Where in the minute a twinned pair of gates jumps (ms), from the two sector
 * keys: the same for both ends (order doesn't matter), different between
 * pairs so the galaxy's gates don't all fire at once.
 */
export function alienGateOffsetMs(sectorA: string, sectorB: string): number {
  const key = sectorA < sectorB ? `${sectorA}|${sectorB}` : `${sectorB}|${sectorA}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % ALIEN_GATE_INTERVAL_MS;
}

/** The first timetabled jump (ms since epoch) after `nowMs`: every
 *  `intervalMs` (a test speed-up shortens it), at `offsetMs` into each. */
export function nextAlienGateJumpMs(nowMs: number, offsetMs: number, intervalMs: number = ALIEN_GATE_INTERVAL_MS): number {
  const off = offsetMs % intervalMs;
  const base = Math.floor((nowMs - off) / intervalMs) * intervalMs + off;
  return base > nowMs ? base : base + intervalMs;
}

/** The phase after `p` (the swap happens leaving SEALED). */
export function nextTpPhase(p: TpPhase): TpPhase {
  return p === TP_PHASE.OPEN ? TP_PHASE.IDLE : ((p + 1) as TpPhase);
}

// ── Firing rules ────────────────────────────────────────────────────────────

/** "Fire when the pad holds at least `qty`": of one good, or total weight. */
export const LoadedRuleSchema = z
  .object({ good: z.enum(GOOD_IDS).nullable(), qty: z.number().int().min(1).max(100_000) })
  .strict();

/**
 * The owner's firing rules; the first one met fires (Manual is always
 * available as a button). `keepLoaded` tops the pad hold up from base storage
 * every pulse.
 */
export const TeleportRulesSchema = z
  .object({
    whenCharged: z.boolean(),
    shipBoards: z.boolean(),
    loaded: LoadedRuleSchema.nullable(),
    keepLoaded: z.object({ good: z.enum(GOOD_IDS), qty: z.number().int().min(1).max(100_000) }).strict().nullable(),
  })
  .strict();
export type TeleportRules = z.infer<typeof TeleportRulesSchema>;

export const DEFAULT_TELEPORT_RULES: TeleportRules = Object.freeze({
  whenCharged: false,
  shipBoards: false,
  loaded: null,
  keepLoaded: null,
});

/** A ship must sit on the pad this long before "when a ship boards" fires. */
export const SHIP_BOARD_DWELL_MS = 3000;

/** The partner of a teleporter: its sector and structure uid. */
export interface TeleportPartner {
  sectorKey: string;
  uid: string;
}

// ── Room-state encoding (A2 rules: assign only on change) ────────────────────

/** `tpRules` bit flags. */
export const TP_RULE_CHARGED = 1;
export const TP_RULE_BOARDS = 2;
export const TP_RULE_LOADED = 4;
export const TP_RULE_KEEP = 8;

/** `tpPartner` when the partner is in another sector (T3). */
export const TP_PARTNER_REMOTE = -2;

// ── Messages (strict; owner-gated server-side) ──────────────────────────────

const entityId = z.number().int().nonnegative();

/** Pair two of the sender's teleporters in this sector. */
export const TeleportPairSchema = z
  .object({ type: z.literal('teleport_pair'), entityId, partnerEntityId: entityId })
  .strict();
export const TeleportUnpairSchema = z.object({ type: z.literal('teleport_unpair'), entityId }).strict();
/** Fire now (Manual). */
export const TeleportFireSchema = z.object({ type: z.literal('teleport_fire'), entityId }).strict();
export const SetTeleportRulesSchema = z
  .object({ type: z.literal('set_teleport_rules'), entityId, rules: TeleportRulesSchema })
  .strict();
/** Move goods from base storage onto the pad (or all of the pad back). */
export const TeleportPadLoadSchema = z
  .object({ type: z.literal('teleport_pad_load'), entityId, good: z.enum(GOOD_IDS), qty: z.number().int().min(1).max(100_000) })
  .strict();
export const TeleportPadUnloadSchema = z.object({ type: z.literal('teleport_pad_unload'), entityId }).strict();

// ── Pad geometry (the ONE source: collider, hits, drawing; #15) ─────────────

/** Half the footprint side: the pad plus its ring of posts. */
export function padHalfExtent(kind: TeleporterKind): number {
  const s = PAD_SPECS[kind];
  return s.padRadius + s.post;
}

const POST_CENTERS: Readonly<Record<TeleporterKind, ReadonlyArray<readonly [number, number]>>> = (() => {
  const out = {} as Record<TeleporterKind, Array<readonly [number, number]>>;
  for (const k of TELEPORTER_KINDS) {
    const s = PAD_SPECS[k];
    const h = padHalfExtent(k) - s.post / 2;
    // Perimeter order (each post's neighbour is the next one), so the iris
    // spans run post to post: `posts / 4` per side, starting at each corner.
    const perSide = Math.max(1, Math.round(s.posts / 4));
    const step = (2 * h) / perSide;
    const pts: Array<readonly [number, number]> = [];
    for (let i = 0; i < perSide; i++) pts.push([-h + i * step, -h]);
    for (let i = 0; i < perSide; i++) pts.push([h, -h + i * step]);
    for (let i = 0; i < perSide; i++) pts.push([h - i * step, h]);
    for (let i = 0; i < perSide; i++) pts.push([-h, h - i * step]);
    out[k] = pts;
  }
  return out;
})();

/** Centres of a pad's posts, local frame, in perimeter order. Ships enter
 *  between them. */
export function padPostCenters(kind: TeleporterKind): ReadonlyArray<readonly [number, number]> {
  return POST_CENTERS[kind];
}

/** The pad is the square |dx|, |dy| ≤ padRadius inside the posts. */
export function onPad(kind: TeleporterKind, cx: number, cy: number, x: number, y: number): boolean {
  const r = PAD_SPECS[kind].padRadius;
  return Math.abs(x - cx) <= r && Math.abs(y - cy) <= r;
}

/** One iris span (local frame): the gap between post `i` and post `i + 1`,
 *  from one post's edge to the next's. Spans close the pad at SEALED. */
export function padIrisSpanLocal(kind: TeleporterKind, i: number, out: { ax: number; ay: number; bx: number; by: number }): void {
  const pts = POST_CENTERS[kind];
  const a = pts[i % pts.length]!;
  const b = pts[(i + 1) % pts.length]!;
  const half = PAD_SPECS[kind].post / 2;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  out.ax = a[0] + ux * half;
  out.ay = a[1] + uy * half;
  out.bx = b[0] - ux * half;
  out.by = b[1] - uy * half;
}

// ── The doors push (T2; applied by the physics world on BOTH sides, #15) ─────

/** How hard the closing iris nudges a straddling ship (world units / s²). */
export const PAD_PUSH_ACCEL = 90;
/** A ship is straddling while its centre is within its radius plus this of
 *  the pad edge. */
export const PAD_PUSH_MARGIN = 20;

/**
 * Which way the closing iris pushes a ship at (x, y) on a pad centred at
 * (cx, cy) with half-size `half`: straight in if its centre is on the pad,
 * straight out if not, along the nearest edge's normal. Writes a unit vector
 * to `out` and returns true; false when the ship isn't straddling the edge.
 * Pure and allocation-free: the server worker and the client's prediction
 * call the same function.
 */
export function padPushDir(
  cx: number, cy: number, half: number, x: number, y: number, shipRadius: number, out: { x: number; y: number },
): boolean {
  const dx = x - cx;
  const dy = y - cy;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const depth = half - Math.max(ax, ay); // > 0 on the pad
  if (Math.abs(depth) > shipRadius + PAD_PUSH_MARGIN) return false;
  const sign = depth >= 0 ? -1 : 1; // on the pad → toward the centre
  if (ax >= ay) { out.x = (dx >= 0 ? 1 : -1) * sign; out.y = 0; }
  else { out.x = 0; out.y = (dy >= 0 ? 1 : -1) * sign; }
  return true;
}

// ── T3 — pairing across sectors ─────────────────────────────────────────────

/** Ask for the sender's other teleporters, in every sector. */
export const TeleportCandidatesQuerySchema = z
  .object({ type: z.literal('teleport_candidates'), entityId })
  .strict();
/** Pair with one of the sender's teleporters anywhere (by sector + uid). */
export const TeleportPairRemoteSchema = z
  .object({
    type: z.literal('teleport_pair_remote'),
    entityId,
    sectorKey: z.string().min(1).max(64),
    uid: z.string().min(1).max(64),
  })
  .strict();
/** The reply: candidates by name ("Teleporter · Verdance"), never raw ids
 *  on screen (the uid only rides back in the pair request). */
export const TeleportCandidatesReplySchema = z.object({
  type: z.literal('teleport_candidates'),
  entityId,
  items: z.array(z.object({ sectorKey: z.string(), uid: z.string(), label: z.string() })).max(200),
});
export type TeleportCandidatesReply = z.infer<typeof TeleportCandidatesReplySchema>;

// ── T4 — tolls and pairing with another owner ───────────────────────────────

/** A teleporter's toll: credits per 1000 charge of the jump, and what happens
 *  to a rider who doesn't pay (they still ride). */
export const TeleportTollSchema = z
  .object({
    per1000: z.number().int().min(0).max(10_000),
    nonPayer: z.enum(['standing', 'hostile']),
  })
  .strict();
export type TeleportToll = z.infer<typeof TeleportTollSchema>;

/** The toll for one rider on a jump needing `required` charge. */
export function tollFor(required: number, per1000: number): number {
  return Math.max(0, Math.ceil((required * per1000) / 1000));
}

/** v4 H — an NPC transit teleporter's toll: credits per 1000 charge, and a
 *  non-payer only loses standing. */
export const NPC_LINK_TOLL: TeleportToll = Object.freeze({ per1000: 5, nonPayer: 'standing' });

/** A rider who rides without paying loses this much of the owner's standing
 *  (unless the owner makes non-payers hostile instead). */
export const TOLL_DODGE_STANDING = -5;

/** `tpRules` bit: non-payers become hostile (else they lose standing). */
export const TP_RULE_TOLL_HOSTILE = 16;

export const SetTeleportTollSchema = z
  .object({ type: z.literal('set_teleport_toll'), entityId, toll: TeleportTollSchema.nullable() })
  .strict();

/** Server → a rider on an armed pad: pay this toll? `padId` names the pad. */
export const TollPromptSchema = z.object({
  type: z.literal('teleport_toll'),
  padId: z.number().int().nonnegative(),
  credits: z.number().int().nonnegative(),
  /** The owner, by name. */
  ownerName: z.string(),
});
export type TollPrompt = z.infer<typeof TollPromptSchema>;

/** A rider's answer. Always / Never are remembered for that owner's faction. */
export const TollAnswerSchema = z
  .object({
    type: z.literal('teleport_toll_answer'),
    padId: z.number().int().nonnegative(),
    answer: z.enum(['pay', 'decline', 'always', 'never']),
  })
  .strict();
export type TollAnswer = z.infer<typeof TollAnswerSchema>['answer'];

/** Ask another owner to pair their teleporter (`entityId`, here) with one of
 *  yours (`sectorKey` + `uid`). They accept or decline. */
export const TeleportPairRequestSchema = z
  .object({
    type: z.literal('teleport_pair_request'),
    entityId,
    sectorKey: z.string().min(1).max(64),
    uid: z.string().min(1).max(64),
  })
  .strict();
/** Server → the other owner: a pairing request, by name. */
export const PairRequestPromptSchema = z.object({
  type: z.literal('teleport_pair_request'),
  requestId: z.string(),
  fromName: z.string(),
  /** "Their Teleporter · Verdance → your Teleporter · 1.3 km". */
  label: z.string(),
});
export type PairRequestPrompt = z.infer<typeof PairRequestPromptSchema>;
export const TeleportPairAnswerSchema = z
  .object({ type: z.literal('teleport_pair_answer'), requestId: z.string().min(1).max(64), accept: z.boolean() })
  .strict();

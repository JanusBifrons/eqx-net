/**
 * Player bounties (Living World P4c-2, plan peppy-jumping-pinwheel).
 *
 * A signed-in pilot puts credits on another signed-in pilot's head. Rules:
 *   - the price is paid from the placer's storage network in the current
 *     sector, PLUS a burned fee (`PVP_BOUNTY_FEE_FRAC`) — one atomic
 *     `tradeTransfer` group (value → an escrow hold, fee → nowhere);
 *   - the target must own a ship of level ≥ `PVP_BOUNTY_MIN_TARGET_LEVEL`;
 *   - one open bounty per (target, placer) pair; after it's claimed the placer
 *     waits `PVP_BOUNTY_PAIR_COOLDOWN_MS` before placing another on that target;
 *   - whoever destroys the target's active ship collects EVERY open bounty on
 *     it except their own, into their own ship hold (signed-in killers only).
 *
 * The escrow is a `bounty` hold keyed `bounty:<target>:<placer>` — the hold row
 * IS the bounty (value lives in exactly one hold; restart-safe because holds
 * persist and are hydrated). The pair cooldown is in memory (best-effort).
 * Payout is ONE atomic group: escrow deletes + the killer's ship hold put.
 */
import {
  PVP_BOUNTY_FEE_FRAC,
  PVP_BOUNTY_MIN_TARGET_LEVEL,
  PVP_BOUNTY_PAIR_COOLDOWN_MS,
  pvpBountyCost,
} from '../../shared-types/contracts.js';
import { emptyHold } from '../../core/cargo/hold.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import type { HoldRecord, HoldStore } from '../cargo/HoldStore.js';
import type { TradeTransferResult, TradeTransferSpec } from '../cargo/StorageService.js';
import type { WorldNotice } from '../../shared-types/worldNotice.js';

export const BOUNTY_UID_PREFIX = 'bounty:';

export function bountyUid(target: string, placer: string): string {
  return `${BOUNTY_UID_PREFIX}${target}:${placer}`;
}

/** Parse `bounty:<target>:<placer>` (player ids are uuids — no colons). */
export function parseBountyUid(uid: string): { target: string; placer: string } | null {
  if (!uid.startsWith(BOUNTY_UID_PREFIX)) return null;
  const rest = uid.slice(BOUNTY_UID_PREFIX.length);
  const i = rest.lastIndexOf(':');
  if (i <= 0 || i === rest.length - 1) return null;
  return { target: rest.slice(0, i), placer: rest.slice(i + 1) };
}

/** What the board needs from the room a request / kill happened in. */
export interface BountyRoom {
  tradeSnapshot(ownerId: string, networkUid: string): { credits: number } | null;
  tradeTransfer(ownerId: string, networkUid: string, spec: TradeTransferSpec): TradeTransferResult | null;
  /** Credit `credits` into `playerId`'s ACTIVE ship hold, deleting `deletes` in
   *  the SAME atomic group. False (nothing written) when there's no hull. */
  creditKillerHold(playerId: string, credits: number, deletes: readonly string[]): boolean;
  broadcastWorldNotice?(notice: WorldNotice): void;
}

/** Account + roster facts about a player (injected — the roster/auth stores). */
export interface BountyPlayers {
  /** The player's account user id, or null for a guest / unknown player. */
  userIdOf(playerId: string): string | null;
  /** Highest level among the player's ships (0 if none). */
  maxShipLevel(playerId: string): number;
  /** The player's display name (never an id), or null. */
  nameOf(playerId: string): string | null;
  /** Where the player was last seen (a sector key), or null. */
  lastSectorOf(playerId: string): string | null;
}

export interface BountyVerdict {
  ok: boolean;
  message: string;
}

export interface OpenBounty {
  target: string;
  targetName: string;
  /** Total credits on the target (all placers). */
  credits: number;
  lastSector: string | null;
}

export class BountyBoard {
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly holds: () => HoldStore,
    private readonly players: BountyPlayers,
    private readonly now: () => number = Date.now,
  ) {}

  place(room: BountyRoom, placer: string, target: string, networkUid: string, amount: number): BountyVerdict {
    if (target === placer) return { ok: false, message: 'You cannot put a bounty on yourself.' };
    if (this.players.userIdOf(placer) === null) return { ok: false, message: 'Sign in to place bounties.' };
    if (this.players.userIdOf(target) === null) return { ok: false, message: 'That pilot can\'t be targeted.' };
    if (this.players.maxShipLevel(target) < PVP_BOUNTY_MIN_TARGET_LEVEL) {
      return { ok: false, message: `Bounties need a target of level ${PVP_BOUNTY_MIN_TARGET_LEVEL} or higher.` };
    }
    const uid = bountyUid(target, placer);
    if (this.holds().get(uid) !== undefined) return { ok: false, message: 'You already have a bounty on that pilot.' };
    if (this.now() < (this.cooldownUntil.get(uid) ?? 0)) {
      return { ok: false, message: 'You recently had a bounty on that pilot claimed — try again later.' };
    }
    const cost = pvpBountyCost(amount);
    // Check the balance FIRST so a short network never moves (or burns) anything.
    const snap = room.tradeSnapshot(placer, networkUid);
    if (snap === null) return { ok: false, message: 'Pick one of your storage structures.' };
    if (snap.credits < cost) {
      return { ok: false, message: `You need ${cost}¢ banked here (bounty + ${Math.round(PVP_BOUNTY_FEE_FRAC * 100)}% fee).` };
    }
    const want = emptyHold();
    want.credits = cost;
    const res = room.tradeTransfer(placer, networkUid, {
      take: { want, intoUid: uid, intoOwner: placer, intoType: 'bounty', burnCredits: cost - amount },
    });
    if (res === null || res.taken.credits < cost) return { ok: false, message: 'Placing the bounty failed.' };
    auditEvent({ event: 'bounty_placed', playerId: placer, target, credits: amount });
    const name = this.players.nameOf(target) ?? 'a pilot';
    room.broadcastWorldNotice?.({ type: 'world_notice', kind: 'bounty', message: `A ${amount}¢ bounty has been placed on ${name}!` });
    return { ok: true, message: `Bounty of ${amount}¢ placed on ${name}.` };
  }

  /** A player's active hull was destroyed by `killer` (a player id). Pays every
   *  open bounty on `victim` except the killer's own, as ONE atomic group. */
  onPlayerKilled(room: BountyRoom, victim: string, killer: string): number {
    if (victim === killer || this.players.userIdOf(killer) === null) return 0;
    const due: HoldRecord[] = [];
    for (const r of this.holds().ofType('bounty')) {
      const p = parseBountyUid(r.holderUid);
      if (p !== null && p.target === victim && p.placer !== killer) due.push(r);
    }
    if (due.length === 0) return 0;
    let credits = 0;
    for (const r of due) credits += r.hold.credits;
    const deletes = due.map((r) => r.holderUid);
    if (!room.creditKillerHold(killer, credits, deletes)) return 0;
    const until = this.now() + PVP_BOUNTY_PAIR_COOLDOWN_MS;
    for (const uid of deletes) this.cooldownUntil.set(uid, until);
    auditEvent({ event: 'bounty_claimed', playerId: killer, target: victim, credits });
    const who = this.players.nameOf(killer) ?? 'A pilot';
    const whom = this.players.nameOf(victim) ?? 'a pilot';
    room.broadcastWorldNotice?.({ type: 'world_notice', kind: 'bounty', message: `${who} collected the ${credits}¢ bounty on ${whom}!` });
    return credits;
  }

  /** Open bounties grouped per target (the Contracts board). Allocates. */
  open(): OpenBounty[] {
    const byTarget = new Map<string, number>();
    for (const r of this.holds().ofType('bounty')) {
      const p = parseBountyUid(r.holderUid);
      if (p !== null) byTarget.set(p.target, (byTarget.get(p.target) ?? 0) + r.hold.credits);
    }
    const out: OpenBounty[] = [];
    for (const [target, credits] of byTarget) {
      out.push({
        target,
        targetName: this.players.nameOf(target) ?? 'Unknown pilot',
        credits,
        lastSector: this.players.lastSectorOf(target),
      });
    }
    out.sort((a, b) => b.credits - a.credits);
    return out;
  }

}

let board: BountyBoard | null = null;

export function setBountyBoard(b: BountyBoard | null): void {
  board = b;
}

export function getBountyBoard(): BountyBoard | null {
  return board;
}

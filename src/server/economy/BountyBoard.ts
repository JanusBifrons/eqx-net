/**
 * Player bounties (Living World P4c-2; economy v2 W1 — paid from the WALLET).
 *
 * A pilot puts credits on another pilot's head. Credits are virtual (economy
 * v2): the price is DEBITED from the placer's wallet — wherever they are — plus
 * a burned fee (`PVP_BOUNTY_FEE_FRAC`). Rules:
 *   - the target must own a ship of level ≥ `PVP_BOUNTY_MIN_TARGET_LEVEL`;
 *   - one open bounty per (target, placer) pair; after it's claimed the placer
 *     waits `PVP_BOUNTY_PAIR_COOLDOWN_MS` before placing another on that target;
 *   - whoever destroys the target's active ship collects EVERY open bounty on
 *     it except their own, straight into the killer's wallet.
 * Guests are full players (the user's ruling) — no sign-in gate.
 *
 * The open bounties are a persisted RECORD (`economy_state` key `bounties`),
 * written in ONE atomic group with the wallet debit / payout. The pair
 * cooldown is in memory (best-effort across restarts).
 */
import {
  PVP_BOUNTY_FEE_FRAC,
  PVP_BOUNTY_MIN_TARGET_LEVEL,
  PVP_BOUNTY_PAIR_COOLDOWN_MS,
  pvpBountyCost,
} from '../../shared-types/contracts.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import type { WorldNotice } from '../../shared-types/worldNotice.js';
import type { Wallet } from './Wallet.js';

export const BOUNTIES_STATE_KEY = 'bounties';

export function bountyUid(target: string, placer: string): string {
  return `bounty:${target}:${placer}`;
}

/** Where a board message is announced (the room the request / kill was in). */
export interface BountyRoom {
  broadcastWorldNotice?(notice: WorldNotice): void;
}

/** Roster facts about a player (injected — the roster / auth stores). */
export interface BountyPlayers {
  /** Highest level among the player's ships (0 if none — unknown pilot). */
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

interface BountyRecord {
  target: string;
  placer: string;
  credits: number;
  placedAtMs: number;
}

export class BountyBoard {
  private readonly records = new Map<string, BountyRecord>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly wallet: Pick<Wallet, 'debitDeferred' | 'creditDeferred'>,
    private readonly persistence: () => IPersistenceSink | null,
    private readonly players: BountyPlayers,
    private readonly now: () => number = Date.now,
  ) {}

  /** Boot hydrate from the persisted `bounties` record JSON. */
  hydrate(json: string | null | undefined): void {
    if (!json) return;
    try {
      const rows = JSON.parse(json) as BountyRecord[];
      for (const r of rows) {
        if (typeof r.target === 'string' && typeof r.placer === 'string' && Number.isFinite(r.credits) && r.credits > 0) {
          this.records.set(bountyUid(r.target, r.placer), { ...r, credits: Math.floor(r.credits) });
        }
      }
    } catch {
      /* corrupt ⇒ empty board */
    }
  }

  place(room: BountyRoom, placer: string, target: string, amount: number): BountyVerdict {
    if (target === placer) return { ok: false, message: 'You cannot put a bounty on yourself.' };
    if (this.players.maxShipLevel(target) < PVP_BOUNTY_MIN_TARGET_LEVEL) {
      return { ok: false, message: `Bounties need a target of level ${PVP_BOUNTY_MIN_TARGET_LEVEL} or higher.` };
    }
    const uid = bountyUid(target, placer);
    if (this.records.has(uid)) return { ok: false, message: 'You already have a bounty on that pilot.' };
    if (this.now() < (this.cooldownUntil.get(uid) ?? 0)) {
      return { ok: false, message: 'You recently had a bounty on that pilot claimed — try again later.' };
    }
    const cost = pvpBountyCost(amount);
    const pay = this.wallet.debitDeferred(placer, cost, 'bounty_placed');
    if (pay === null) {
      return { ok: false, message: `You need ${cost}¢ (bounty + ${Math.round(PVP_BOUNTY_FEE_FRAC * 100)}% fee).` };
    }
    this.records.set(uid, { target, placer, credits: amount, placedAtMs: this.now() });
    this.commit([pay]);
    auditEvent({ event: 'bounty_placed', playerId: placer, target, credits: amount });
    const name = this.players.nameOf(target) ?? 'a pilot';
    room.broadcastWorldNotice?.({ type: 'world_notice', kind: 'bounty', message: `A ${amount}¢ bounty has been placed on ${name}!` });
    return { ok: true, message: `Bounty of ${amount}¢ placed on ${name}.` };
  }

  /** `victim`'s active hull was destroyed by player `killer`: pay every open
   *  bounty on the victim except the killer's own into the killer's wallet,
   *  in ONE atomic group with the board update. */
  onPlayerKilled(room: BountyRoom, victim: string, killer: string): number {
    if (victim === killer) return 0;
    let credits = 0;
    const paid: string[] = [];
    for (const [uid, r] of this.records) {
      if (r.target === victim && r.placer !== killer) {
        credits += r.credits;
        paid.push(uid);
      }
    }
    if (paid.length === 0) return 0;
    const until = this.now() + PVP_BOUNTY_PAIR_COOLDOWN_MS;
    for (const uid of paid) {
      this.records.delete(uid);
      this.cooldownUntil.set(uid, until);
    }
    const op = this.wallet.creditDeferred(killer, credits, 'bounty_claimed');
    this.commit(op ? [op] : []);
    auditEvent({ event: 'bounty_claimed', playerId: killer, target: victim, credits });
    const who = this.players.nameOf(killer) ?? 'A pilot';
    const whom = this.players.nameOf(victim) ?? 'a pilot';
    room.broadcastWorldNotice?.({ type: 'world_notice', kind: 'bounty', message: `${who} collected the ${credits}¢ bounty on ${whom}!` });
    return credits;
  }

  /** Open bounties grouped per target (the Contracts board). Allocates. */
  open(): OpenBounty[] {
    const byTarget = new Map<string, number>();
    for (const r of this.records.values()) byTarget.set(r.target, (byTarget.get(r.target) ?? 0) + r.credits);
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

  /** Credits currently on `target` from `placer` (0 if none) — inspection. */
  amountOf(target: string, placer: string): number {
    return this.records.get(bountyUid(target, placer))?.credits ?? 0;
  }

  /** The board record + the wallet ops, as ONE atomic group. */
  private commit(walletOps: PersistOp[]): void {
    const sink = this.persistence();
    if (sink === null) return;
    const board: PersistOp = {
      type: 'ECON_STATE_PUT',
      key: BOUNTIES_STATE_KEY,
      payloadJson: JSON.stringify([...this.records.values()]),
      ts: this.now(),
    };
    sink.enqueueCritical({ type: 'GROUP', ops: [board, ...walletOps] });
  }
}

let board: BountyBoard | null = null;

export function setBountyBoard(b: BountyBoard | null): void {
  board = b;
}

export function getBountyBoard(): BountyBoard | null {
  return board;
}

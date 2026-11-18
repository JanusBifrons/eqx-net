/**
 * IncomingBanners — the director's side of the HUD "incoming ships" banner:
 * owns its `IncomingRegistry`, announces every squad-member hop at the single
 * hop choke point, reconciles arrived squads off the banner at the tail of the
 * control tick, and carries the player-transit back-channel. Moved verbatim out
 * of `LivingWorldDirector.ts`; `warp_warning` still comes only from the
 * `IncomingRegistry`. Control-tick cadence only, never the 60 Hz loop.
 */
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { IncomingRegistry } from '../IncomingRegistry.js';
import type { LivingWorldRoom } from '../LivingWorldRoom.js';
import type { ShipKindId } from '../../../shared-types/shipKinds.js';
import type { WarpDisposition, WarpWarningEvent } from '../../../shared-types/messages.js';
import type { BotRecord, HunterBotPool } from './HunterBotPool.js';
import type { SquadPool, SquadRecord } from './SquadPool.js';
import type { SquadHerding } from './SquadHerding.js';

/** Display label for a squad's homogeneous hull in the warp-in warning
 *  ("8 × Legionnaires"). v1 squads are all `fighter`, shown as "Legionnaire"
 *  (a flavour codename, NOT a ship-kind — invariant #11; the wire `shipKind`
 *  stays `fighter`). A future mixed-kind WavePattern extends this map. */
export function squadDisplayLabel(kind: ShipKindId): string {
  if (kind === 'fighter') return 'Legionnaire';
  // P1b — a mixed robot squad reads as one threat ("6 × Robots").
  if (kind.startsWith('robot-')) return 'Robot';
  return kind;
}

export interface IncomingBannersDeps {
  rooms: Map<string, LivingWorldRoom>;
  pool: HunterBotPool;
  squadPool: SquadPool;
  herding: Pick<SquadHerding, 'squadGatheredAt'>;
  opts: { allegiance: 'drones' | 'robots'; hopTravelMs: number };
}

export class IncomingBanners {
  private readonly pool: HunterBotPool;
  private readonly squadPool: SquadPool;
  private readonly herding: IncomingBannersDeps['herding'];
  private readonly opts: IncomingBannersDeps['opts'];
  /** Phase-4 P0 — the single per-destination "incoming ships" feed behind the
   *  HUD banner. Fed off the universal hop choke point + the player-transit path. */
  private readonly incoming: IncomingRegistry;

  constructor(deps: IncomingBannersDeps) {
    this.pool = deps.pool;
    this.squadPool = deps.squadPool;
    this.herding = deps.herding;
    this.opts = deps.opts;
    this.incoming = new IncomingRegistry(deps.rooms, {
      // Campaign 2.3 — a warning whose destination has no live room was a
      // fully silent drop (the review's prime "STILL says nothing incoming"
      // suspect). Surface it in the diag ring so a live session shows the
      // hole instead of nothing.
      onUnknownDest: (destSectorKey, id) =>
        serverLogEvent('warp_warning_no_room', { destSectorKey, id }),
    });
  }

  /** Phase-4 P0 — the decision instant: this bot has ELECTED to warp into `to`
   *  from another sector. Announce its squad as inbound to `to` (deduped on
   *  squadId so 8 members = ONE banner entry; the registry follows a re-tasked
   *  squad to a new goal). Covers wave, roam, AND traversal hops — the single
   *  place the old wave-only warning missed. */
  announceHop(rec: BotRecord, from: string, to: string, spoolMs: number): void {
    const squad = this.squadPool.squadOf(rec.botId);
    this.incoming.register({
      id: squad ? squad.squadId : rec.botId,
      destSectorKey: to,
      sourceSectorKey: from,
      label: squadDisplayLabel(squad ? squad.kind : rec.kind),
      count: squad ? squad.botIds.length : 1,
      disposition: this.dispositionForSquad(squad),
      // ≈ time-to-arrival for this leg: vulnerable spool + invulnerable flight.
      // Uses THIS hop's spool (a wave's final approach is ~30 s), so the HUD
      // countdown matches the real arrival instead of a fixed 2.5 s.
      etaMs: spoolMs + this.opts.hopTravelMs,
      kind: squad ? squad.kind : rec.kind,
    });
  }

  /** Drop a squad's banner entry for `destSectorKey` (a stood-down wave). */
  clearSquad(squadId: string, destSectorKey: string): void {
    this.incoming.clear(squadId, destSectorKey);
  }

  /** Forget every entry (director stop). */
  reset(): void {
    this.incoming.reset();
  }

  /** Phase-4 P0 — a squad's coarse threat relation for the incoming banner. A
   *  wave (tasked against a faction) is an ENEMY (red); an idle/roaming pack is
   *  NEUTRAL (amber). Per-recipient PvP refinement is a future nicety — a tasked
   *  squad is bearing down on that faction's base, so coarse `enemy` is correct
   *  in practice. */
  private dispositionForSquad(squad: SquadRecord | undefined): WarpDisposition {
    // Robots are hostile to every player on sight — always a red warning.
    if (this.opts.allegiance === 'robots') return 'enemy';
    return squad && squad.targetFactionId !== null ? 'enemy' : 'neutral';
  }

  /** Tail of the control tick: clear the "incoming" banner for any squad that
   *  has arrived (gathered at the entry's destination). Self-correcting against
   *  a missed edge — iterates the tiny registry, not the bot pool. Player
   *  entries are owned by the transit/arrival hooks and skipped here. */
  reconcile(): void {
    for (const e of [...this.incoming.all()]) {
      if (e.player) continue;
      const squad = this.squadPool.get(e.id);
      // The squad is gone, or it has fully gathered at the destination, or no
      // member is still inbound to it ⇒ the warp-in is over.
      if (!squad || this.herding.squadGatheredAt(squad, e.destSectorKey) || !this.anyMemberInboundTo(squad, e.destSectorKey)) {
        this.incoming.clear(e.id, e.destSectorKey);
      }
    }
  }

  /** True iff at least one of the squad's members is in-transit OR active-but-not-
   *  yet-arrived toward `dest` — i.e. the warp-in is still in progress. */
  private anyMemberInboundTo(squad: SquadRecord, dest: string): boolean {
    for (const botId of squad.botIds) {
      const rec = this.pool.get(botId);
      if (!rec) continue;
      if (rec.state === 'in-transit') return true;
      if (rec.state === 'active' && rec.sectorKey !== dest && squad.sectorKey === dest) return true;
    }
    return false;
  }

  /** Phase-4 P0 — player-transit back-channel: a player has begun spooling toward
   *  `destSectorKey`. Announce them as a FRIENDLY inbound to that sector's
   *  occupants. Called from `TransitOrchestrator` via the index.ts accessor. */
  registerIncomingPlayer(spec: {
    playerId: string;
    destSectorKey: string;
    sourceSectorKey: string;
    label: string;
    etaMs: number;
    count?: number;
  }): void {
    this.incoming.register({
      id: spec.playerId,
      destSectorKey: spec.destSectorKey,
      sourceSectorKey: spec.sourceSectorKey,
      label: spec.label,
      count: spec.count ?? 1,
      disposition: 'friendly',
      etaMs: spec.etaMs,
      player: true,
    });
  }

  /** Phase-4 P0 — clear an inbound player (arrival / cancel / abort). */
  clearIncomingPlayer(playerId: string, destSectorKey: string): void {
    this.incoming.clear(playerId, destSectorKey);
  }

  /** 2026-11-08 — replay what is still inbound to `destSectorKey` (with the
   *  countdown left) to a pilot who just arrived there; the original
   *  `warp_warning` only reached the occupants at the time. */
  replayIncomingTo(destSectorKey: string, send: (msg: WarpWarningEvent) => void): void {
    this.incoming.forEachInbound(destSectorKey, send);
  }
}

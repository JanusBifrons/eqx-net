/**
 * BotTransitController — per-bot inter-sector warp driver.
 *
 * Reuses the PURE `TransitStateMachine` (same DOCKED→SPOOLING→IN_TRANSIT
 * →ARRIVED states, same 3 s vulnerable spool, same bus emits) that powers
 * player transit, but the cross-room hop is a server-internal callback —
 * bots are NOT Colyseus clients, so `reserveSeatFor` / `onJoin` / Limbo
 * (all WebSocket-client-only) cannot carry them. We therefore deliberately
 * do NOT fork `TransitOrchestrator`; we only consume the pure machine, so
 * the in-flight Phase G transit work stays untouched.
 *
 * Vulnerable spool by design (parity with players): during SPOOLING the
 * bot stays in the source room, fully shootable. If it is destroyed
 * (`ENTITY_DESTROYED` for this botId) the transit is abandoned and the
 * director routes the bot to its no-origin respawn instead.
 *
 * Atomicity: the `commit` callback (supplied by the director) is
 * responsible for the destination-free-slot pre-check BEFORE it despawns
 * the bot from the source room — see `LivingWorldDirector`. This
 * controller only sequences the state machine + timers around it.
 */
import { Bus } from '../../core/events/Bus.js';
import { TransitStateMachine, SPOOL_DURATION_MS } from '../../core/transit/TransitStateMachine.js';

export type BotTransitOutcome = 'arrived' | 'failed' | 'destroyed';

export interface BotTransitOptions {
  /**
   * Perform the atomic cross-room hop. Called once, when the spool
   * elapses. MUST itself pre-check the destination's free slot before
   * despawning the bot from the source (so a transit can't lose a bot to
   * slot exhaustion). Return:
   *  - `true`  ⇒ the bot left the source (moved, or emergency-respawned
   *              by the director — either way it is accounted for);
   *  - `false` ⇒ the bot did NOT leave the source (pre-check failed /
   *              already gone); the controller cleanly cancels the spool
   *              so the bot simply stays put for the director to retry.
   */
  commit: () => boolean;
  /** Terminal report. Exactly one call per `begin()`. */
  outcome: (result: BotTransitOutcome) => void;
  /** Injected clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export class BotTransitController {
  private machine: TransitStateMachine | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyed: ((e: { type: 'ENTITY_DESTROYED'; entityId: string }) => void) | null = null;
  private settled = false;

  constructor(
    private readonly botId: string,
    private readonly bus: Bus,
    private readonly spoolMs: number = SPOOL_DURATION_MS,
  ) {}

  /** Spooling or in-flight — the director must not re-task this bot. */
  get active(): boolean {
    const s = this.machine?.rawState;
    return s === 'SPOOLING' || s === 'IN_TRANSIT';
  }

  /** Begin the spool. Illegal to call twice without an intervening
   *  terminal outcome (mirrors `TransitStateMachine` single-use). */
  begin(opts: BotTransitOptions): void {
    if (this.machine) throw new Error(`BotTransitController(${this.botId}): already in flight`);
    const now = opts.now ?? Date.now;
    this.settled = false;
    this.machine = new TransitStateMachine(this.botId, this.bus, this.spoolMs);
    this.machine.beginSpool(now());

    // Vulnerable spool: a kill of THIS bot during spool aborts transit.
    // ENTITY_DESTROYED carries the registry id (== botId); a load-shed
    // uses ENTITY_SHED (not subscribed) so the director handles that
    // separately (shed-and-pause).
    const onDestroyed = (e: { type: 'ENTITY_DESTROYED'; entityId: string }): void => {
      if (e.entityId !== this.botId) return;
      this.teardownListeners();
      if (this.machine?.rawState === 'SPOOLING') this.machine.cancel();
      this.finish('destroyed', opts);
    };
    this.onDestroyed = onDestroyed;
    this.bus.on('ENTITY_DESTROYED', onDestroyed);

    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      // Past the vulnerable window — a later kill is the death flow's
      // problem, not transit's.
      this.teardownListeners();
      if (!this.machine || this.machine.rawState !== 'SPOOLING') return;
      let moved = false;
      try {
        moved = opts.commit();
      } catch {
        moved = false;
      }
      if (moved) {
        this.machine.beginTransit();
        this.machine.arrive();
        this.machine.reset();
        this.finish('arrived', opts);
      } else {
        // Nothing left the source — cancel the spool (legal from
        // SPOOLING; emits DOCKED). The bot stays where it is.
        this.machine.cancel();
        this.finish('failed', opts);
      }
    }, this.spoolMs);
  }

  /** Force-abandon an in-flight spool (director shutdown / source room
   *  dispose). Idempotent; reports no outcome (the director is tearing
   *  down anyway). */
  dispose(): void {
    if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    this.teardownListeners();
    if (this.machine?.rawState === 'SPOOLING') this.machine.cancel();
    this.settled = true;
  }

  private teardownListeners(): void {
    if (this.onDestroyed) {
      this.bus.off('ENTITY_DESTROYED', this.onDestroyed);
      this.onDestroyed = null;
    }
  }

  private finish(result: BotTransitOutcome, opts: BotTransitOptions): void {
    if (this.settled) return;
    this.settled = true;
    opts.outcome(result);
  }
}

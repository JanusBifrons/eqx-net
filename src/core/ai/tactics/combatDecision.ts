/**
 * The combat decision layer's state and cadence (slice 4), owned by
 * `HostileDroneBehaviour` and built once: the preallocated manoeuvres, the
 * utility picker, the decision slot / LOD, a change of mind waiting out the
 * role's reaction time, and the test-visible decision counters. The brain
 * calls `run` once per combat tick (with a neighbour index) before the
 * running manoeuvre writes its goal. Allocation-free (#14).
 */
import type { AiEntity, AiWorldView, IAiNeighbourQuery } from '../../contracts/IAiBehaviour.js';
import { fnv1a32 } from '../../random/rng.js';
import type { HullAvoid } from '../hullAvoid.js';
import type { PilotMorale } from '../pilot/pilotMorale.js';
import type { PilotSenses } from '../pilot/pilotSenses.js';
import type { FireLaneSteer } from './fireLanes.js';
import {
  MANOEUVRE_ATTACK_RUN,
  MANOEUVRE_BREAK,
  MANOEUVRE_FALL_BACK,
  MANOEUVRE_FLEE,
  MANOEUVRE_KITE,
  type IManoeuvre,
  type ManoeuvreId,
  type TacticalContext,
} from './manoeuvre.js';
import { AttackRunManoeuvre, BreakManoeuvre, HoldManoeuvre, TailManoeuvre } from './manoeuvres.js';
import { MORALE_OUTCOME } from './morale.js';
import type { RoleProfile } from './roleProfiles.js';
import { FallBackManoeuvre, FleeManoeuvre, KiteManoeuvre, OrbitManoeuvre } from './stanceManoeuvres.js';
import { decisionDue, isTailed, ManoeuvrePicker } from './utility.js';

export class CombatDecision {
  readonly picker = new ManoeuvrePicker();
  /** Preallocated manoeuvres, indexed by `ManoeuvreId`. */
  readonly flee = new FleeManoeuvre();
  private readonly fallBack = new FallBackManoeuvre();
  readonly manoeuvres: readonly IManoeuvre[] = [
    new HoldManoeuvre(), new TailManoeuvre(), new AttackRunManoeuvre(), new BreakManoeuvre(),
    new OrbitManoeuvre(), new KiteManoeuvre(), this.fallBack, this.flee,
  ];
  /** The attack run (its dive phase takes the fire-lane nudge, slice 5b). */
  readonly attackRun = this.manoeuvres[MANOEUVRE_ATTACK_RUN] as AttackRunManoeuvre;
  /** The kite (backing off nose on takes the fire-lane nudge; running does not). */
  readonly kite = this.manoeuvres[MANOEUVRE_KITE] as KiteManoeuvre;
  /** fnv1a32 of the entity id (seeds the picker and the morale die). */
  private idHash = 0;
  /** Seeded from the entity id on the first combat tick. */
  private seeded = false;
  /** Decision-cadence slot (staggers the pack's re-scores across ticks). */
  private slot = 0;
  /** AI LOD: no pilot near ⇒ slower decision cadence. */
  private lod = false;
  /** A switch waiting out the role's reaction time (-1 = none). */
  private pendingId = -1;
  private pendingAt = 0;
  /** Decisions taken while tailed (`isTailed`), Breaks begun, and tailed
   *  decisions that refused a Break on offer (test-visible). */
  tailedDecisions = 0;
  breaksBegun = 0;
  breakRefused = 0;

  constructor(
    private readonly avoid: HullAvoid,
    private readonly senses: PilotSenses,
    private readonly moraleP: PilotMorale,
    private readonly lanes: FireLaneSteer,
  ) {}

  /**
   * The decision layer's cadence: re-score every `DECIDE_PERIOD` ticks
   * (slot-staggered; `LOD_DECIDE_PERIOD` with no pilot near) or at once when
   * the running manoeuvre is done. A change of mind waits out the role's
   * `reactionTicks` (a Break included: noticing the bandit takes time); a
   * finished manoeuvre is replaced at once.
   */
  run(
    self: AiEntity, view: AiWorldView, nb: IAiNeighbourQuery, c: TacticalContext, role: RoleProfile, radius: number,
  ): void {
    const p = this.picker;
    const tick = view.tick;
    if (!this.seeded) {
      const h = fnv1a32(self.id);
      this.idHash = h;
      c.rng.reseed(h);
      p.seed(c.rng);
      this.slot = h % 60;
      this.seeded = true;
    }
    const done = this.manoeuvres[p.current]!.isDone(c);
    if (done || decisionDue(tick, this.slot, this.lod)) {
      this.lod = !this.senses.pilotNear(self, view);
      c.recentHits = this.senses.recentHitsAt(tick);
      c.recentBlocks = this.lanes.getRecentBlocks(tick);
      this.senses.countSides(self, nb, c);
      this.senses.scanSensors(self, nb, c);
      if (view.stats !== undefined) view.stats.decisions++;
      if (isTailed(c)) this.tailedDecisions++;
      // Morale: a trigger (hull 50 / 25 %, burst, capital lost, outnumbered)
      // rolls the die; FallBack / Flee then run locked. A fleeing ship keeps
      // fleeing.
      const outcome = this.moraleP.decide(
        tick, c, p.current === MANOEUVRE_FLEE, this.senses, radius, role.moraleWeights, this.idHash,
      );
      if (outcome === MORALE_OUTCOME.FallBack) {
        this.switchTo(MANOEUVRE_FALL_BACK, tick, c);
        return;
      }
      if (outcome === MORALE_OUTCOME.Flee) {
        this.switchTo(MANOEUVRE_FLEE, tick, c);
        return;
      }
      // Fight on (or no roll): normal scoring below.
      if (p.current === MANOEUVRE_FLEE) return;
      if (p.current === MANOEUVRE_FALL_BACK) {
        // Regroup, then re-engage (owner 2026-11-14): held until it reaches
        // its friends (capped; the lock is its floor), and handed back to
        // the normal combat manoeuvres the moment it is among them or has
        // nobody to reach (`done`), lock or not: a ship held in FallBack at
        // its anchor parked beside an enemy.
        if (!done && (tick < this.moraleP.lockUntil || tick < this.moraleP.fallBackCapUntil)) return;
        // Regrouped, or the cap ran out: choose afresh.
        this.switchTo(p.decide(c, role, true), tick, c);
        return;
      }
      // A running Kite is already getting out from under its attacker: a
      // Break across the line would hand the gap back (take 6: the Heavy
      // flipped Kite / Break every 1-2 s).
      const want = p.decide(c, role, done, !(p.current === MANOEUVRE_KITE && this.kite.running));
      // Tailed with a Break on offer (not cooling down) yet another pick won.
      if (want !== MANOEUVRE_BREAK && p.scores[MANOEUVRE_BREAK]! > 0 && isTailed(c)) this.breakRefused++;
      if (done) {
        this.switchTo(want, tick, c);
      } else if (want !== p.current) {
        if (this.pendingId !== want) {
          this.pendingId = want;
          this.pendingAt = tick + role.reactionTicks;
        }
      } else {
        this.pendingId = -1;
      }
    }
    if (this.pendingId >= 0 && tick >= this.pendingAt) this.switchTo(this.pendingId as ManoeuvreId, tick, c);
  }

  /** Begin manoeuvre `id` now (a fresh dodge side, no pending switch). */
  switchTo(id: ManoeuvreId, tick: number, c: TacticalContext): void {
    if (id === MANOEUVRE_BREAK && this.picker.current !== MANOEUVRE_BREAK) this.breaksBegun++;
    this.picker.switchTo(id, tick);
    this.manoeuvres[id]!.begin(c);
    this.avoid.resetSide();
    this.pendingId = -1;
  }
}

/**
 * The pilot's helm: the ship's one energy pool and the virtual-pilot actuation
 * every movement mode flies through. Owned by `HostileDroneBehaviour` and
 * built once; the brain keeps one-line delegates (`fly`, `avoidAccel`,
 * `trySpendEnergy`, the energy read-outs). Allocation-free (#14): `fly` fills
 * the brain's pooled intent.
 */
import type { ShipKind } from '../../../shared-types/shipKinds.js';
import { AI_INPUT_BOOST, AI_INPUT_TURN_LEFT, AI_INPUT_TURN_RIGHT, type AiEntity, type AiIntent } from '../../contracts/IAiBehaviour.js';
import { BOOST_TICK_COST, canAfford, regenEnergyStep, spendEnergy } from '../../combat/Energy.js';
import { BOOST_RESERVE_FRAC, type ShipEnergyPool } from '../hostileDroneTuning.js';
import { DEFAULT_PILOT_PARAMS, pilotInputs, type PilotHandling, type PilotParams, type PilotState } from '../virtualPilot.js';

export class PilotHelm {
  /** Ship energy (server-only): the ship's one pool (`opts.energyPool`, else
   *  its own, full at the kind's max), regenerated each tick and spent per
   *  boosted tick AND per weapon slot trigger (`trySpendEnergy`, called by the
   *  fire resolvers) with the shared `Energy.ts` helpers, as a pilot's. Every
   *  read and write goes through `energy`, the one accessor. */
  private readonly _energyPool: ShipEnergyPool;
  get energy(): number { return this._energyPool.energy; }
  set energy(v: number) { this._energyPool.energy = v; }
  readonly energyMax: number;
  private readonly energyRegen: number;
  /** Ticks flown with the afterburner lit (test-visible). */
  boostTicks = 0;
  /** Turn-key reversals (test-visible) and the last turn key held (1 L, −1 R). */
  turnReversals = 0;
  private _lastTurnKey = 0;

  constructor(
    private readonly kind: ShipKind,
    private readonly handling: PilotHandling,
    private readonly _pilot: PilotState,
    private readonly _intentScratch: AiIntent,
    energyPool: ShipEnergyPool | undefined,
  ) {
    this.energyMax = this.kind.energyMax ?? 100;
    this.energyRegen = this.kind.energyRegenRate ?? 0.25;
    this._energyPool = energyPool ?? { energy: this.energyMax };
  }

  /** Boost energy regenerates every tick, as a pilot's pool does. */
  regen(): void {
    this.energy = regenEnergyStep(this.energy, this.energyMax, this.energyRegen);
  }

  /**
   * Actuate through the virtual pilot: the control keys that face `facing`
   * and bring the velocity to (`wantVx`, `wantVy`), boosting when `boostOk`
   * and the NPC's energy pool can pay for the tick (same `BOOST_TICK_COST` a
   * pilot pays). Fills the pooled intent (input set, impulse fields zero, no
   * fire); the caller may attach `fire` afterwards.
   */
  fly(
    self: AiEntity,
    facing: number,
    wantVx: number,
    wantVy: number,
    boostOk: boolean,
    params: Readonly<PilotParams> = DEFAULT_PILOT_PARAMS,
  ): AiIntent {
    const canBoost = boostOk && canAfford(this.energy, BOOST_TICK_COST);
    let bits = pilotInputs(
      this.handling, this._pilot, params,
      self.angle, self.angvel ?? 0, self.vx, self.vy,
      facing, wantVx, wantVy, canBoost,
    );
    // A latched decision may still hold boost the pool can no longer pay for.
    if ((bits & AI_INPUT_BOOST) !== 0) {
      if (canAfford(this.energy, BOOST_TICK_COST)) {
        this.energy = spendEnergy(this.energy, BOOST_TICK_COST);
        this.boostTicks++;
      } else bits &= ~AI_INPUT_BOOST;
    }
    // Turn-key reversals (left then right or back, releases between ignored).
    const turn = (bits & AI_INPUT_TURN_LEFT) !== 0 ? 1 : (bits & AI_INPUT_TURN_RIGHT) !== 0 ? -1 : 0;
    if (turn !== 0) {
      if (this._lastTurnKey !== 0 && turn !== this._lastTurnKey) this.turnReversals++;
      this._lastTurnKey = turn;
    }
    const out = this._intentScratch;
    out.fx = 0;
    out.fy = 0;
    out.torque = 0;
    out.setAngvel = undefined;
    out.input = bits;
    out.fire = undefined;
    out.warpOut = undefined;
    return out;
  }

  /** Dodge thrust (u/s²): the afterburner while the pool allows it. */
  avoidAccel(): number {
    const boostMul = this.energy >= BOOST_RESERVE_FRAC * this.energyMax ? (this.kind.boostMultiplier ?? 1) : 1;
    return this.handling.thrustAccel * 60 * boostMul;
  }

  /** Spend `cost` from the ship's one energy pool if it can pay (a player's
   *  `canAfford` → `spendEnergy`); false ⇒ nothing spent. The fire resolvers
   *  call this per slot trigger, so guns and boost share the pool. */
  trySpendEnergy(cost: number): boolean {
    if (!canAfford(this.energy, cost)) return false;
    this.energy = spendEnergy(this.energy, cost);
    return true;
  }

  /** The pool as a 0..1 fraction of the kind's `energyMax` (for tactics). */
  energyFrac(): number { return this.energyMax > 0 ? this.energy / this.energyMax : 0; }
}

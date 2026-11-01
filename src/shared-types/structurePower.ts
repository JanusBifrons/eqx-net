/**
 * Active vs idle power draw (user ruling 2026-11-01): "not everything should
 * drain full power all of the time. Only when actively processing material
 * should it draw full power … They should draw a small amount when idle, just
 * not full."
 *
 * A structure draws its full `powerConsumption` only while it is ACTIVE:
 *  - a processor while it is running a cycle;
 *  - a drill while it has an asteroid to mine; a Gas Collector while gathering;
 *  - a turret while it has a target.
 * Otherwise it draws IDLE_DRAW_FRAC of it. Shield emitters hold their walls on
 * the idle trickle; a hit is paid from the grid's surplus and then from
 * batteries (the fence damage model), so batteries are a real strategy.
 *
 * The server decides activity and sends it as STRUCTURE_FLAG_DRAW_FULL; both
 * sides compute the draw with this one function (#15).
 */
export const IDLE_DRAW_FRAC = 0.2;

export function structureDraw(powerConsumption: number, drawFull: boolean): number {
  return drawFull ? powerConsumption : powerConsumption * IDLE_DRAW_FRAC;
}

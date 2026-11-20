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
 * An owner can switch a consumer OFF (`canSwitchStructure`): it then draws
 * nothing at all and does no work (its grid reads unpowered to it) until
 * switched back on. Rides the wire as STRUCTURE_FLAG_OFF.
 *
 * The server decides activity and sends it as STRUCTURE_FLAG_DRAW_FULL; both
 * sides compute the draw with this one function (#15).
 */
export const IDLE_DRAW_FRAC = 0.2;

export function structureDraw(powerConsumption: number, drawFull: boolean, switchedOff = false): number {
  if (switchedOff) return 0;
  return drawFull ? powerConsumption : powerConsumption * IDLE_DRAW_FRAC;
}

/** Only a structure that DRAWS power can be switched off (a turret, a shield
 *  post, a processor); generators, stores and connectors have no Off. */
export function canSwitchStructure(powerConsumption: number): boolean {
  return powerConsumption > 0;
}

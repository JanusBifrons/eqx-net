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
 * The owner can also THROTTLE a switchable structure to 0..100% in steps of
 * 10% (`throttle` in tenths, STRUCTURE_THROTTLE_FULL = 100%, the default):
 * its draw, full or idle, scales with it, so 50% draws half. Rides the wire
 * in the uint16 `flags` (`encodeStructureThrottleFlags`).
 *
 * The server decides activity and sends it as STRUCTURE_FLAG_DRAW_FULL; both
 * sides compute the draw with this one function (#15).
 */
export const IDLE_DRAW_FRAC = 0.2;

/** The owner's power throttle, in tenths: 10 = 100% (the default). */
export const STRUCTURE_THROTTLE_FULL = 10;

export function structureDraw(
  powerConsumption: number, drawFull: boolean, switchedOff = false, throttle: number = STRUCTURE_THROTTLE_FULL,
): number {
  if (switchedOff) return 0;
  const full = drawFull ? powerConsumption : powerConsumption * IDLE_DRAW_FRAC;
  return throttle >= STRUCTURE_THROTTLE_FULL ? full : (full * Math.max(0, throttle)) / STRUCTURE_THROTTLE_FULL;
}

/** How fast a producer works this pulse, 0..1: its throttle as a fraction
 *  (1 at the default 100%), 0 when the owner switched it Off. Every producer
 *  (processors incl. the Shipyard, drills, Gas Collectors, Research Labs)
 *  multiplies its one per-pulse progress step by this, so 50% takes twice as
 *  long and 0% does no work while the structure still reads powered. Turrets
 *  ignore it: they have On/Off only. */
export function structureWorkRate(rec: { readonly switchedOff?: boolean; readonly throttle?: number }): number {
  if (rec.switchedOff === true) return 0;
  const t = rec.throttle;
  if (t === undefined || t >= STRUCTURE_THROTTLE_FULL) return 1;
  return Math.max(0, t) / STRUCTURE_THROTTLE_FULL;
}

/** A throttle as stored on a record: an integer 0..9 tenths, or undefined
 *  for 100% (the default, so an unthrottled record carries nothing). */
export function normalizeStructureThrottle(throttle: number | undefined): number | undefined {
  if (throttle === undefined || !Number.isFinite(throttle)) return undefined;
  const t = Math.max(0, Math.min(STRUCTURE_THROTTLE_FULL, Math.round(throttle)));
  return t === STRUCTURE_THROTTLE_FULL ? undefined : t;
}

/** Only a structure that DRAWS power can be switched off (a turret, a shield
 *  post, a processor); generators, stores and connectors have no Off. */
export function canSwitchStructure(powerConsumption: number): boolean {
  return powerConsumption > 0;
}

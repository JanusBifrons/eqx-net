/**
 * The break-up switches (`capitalWrecks`, `subcapWrecks`): is a room's
 * break-up on? ON by default in every room since the owner switched it on
 * for normal play (2026-11-14, "land it switched on").
 *
 * - The env switch (`EQX_CAPITAL_WRECKS` / `EQX_SUBCAP_WRECKS`) wins over
 *   the room: `0` forces it off everywhere (tests, the off arm of a perf
 *   A/B), `1` forces it on.
 * - Otherwise a room opts out with the room option set to `false`.
 * - Anything else (unset, `true`) is on.
 */
export function wreckSwitchOn(env: string | undefined, roomOpt: boolean | undefined): boolean {
  if (env === '0') return false;
  if (env === '1') return true;
  return roomOpt !== false;
}

/**
 * The structure break-up switch (`structureWrecks` room option,
 * `EQX_STRUCTURE_WRECKS`): does a destroyed structure break into wreck
 * pieces here? ON by default since the owner signed off the look
 * (2026-11-22, round-4 stills). The env switch wins over the room (`0` off,
 * `1` on); otherwise a room opts out with `structureWrecks: false`. Pieces
 * also need the wreck subsystem, which exists when `capitalWrecks` or
 * `subcapWrecks` is on (the default).
 */
export function structureWreckSwitchOn(env: string | undefined, roomOpt: boolean | undefined): boolean {
  return wreckSwitchOn(env, roomOpt);
}

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

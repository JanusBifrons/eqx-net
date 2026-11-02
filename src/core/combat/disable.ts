/**
 * The DISABLED status (plan soft-leaping-truffle v4, phase A): what an alien
 * gate's guns do to anyone who attacks it. A disabled ship's engines and
 * weapons go offline for a while; its hull is untouched.
 *
 * Shared by server and client (invariant #15): the server strips a disabled
 * pilot's control bits before they reach the physics worker, and the client
 * strips its own local input the same way before predicting, so prediction
 * and authority agree. One function, both sides.
 */

/** How long one disable lasts (ms). Re-applied while the attack continues. */
export const DISABLE_DURATION_MS = 10_000;

/** The movement bits of a ship's input (the subset both sides share). */
export interface ControlBits {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  boost: boolean;
  reverse?: boolean;
}

/** Clear the movement bits in place when the ship is disabled. Returns
 *  whether it is (callers also drop fire). No allocation. */
export function gateDisabledInput(disabled: boolean, input: ControlBits): boolean {
  if (!disabled) return false;
  input.thrust = false;
  input.turnLeft = false;
  input.turnRight = false;
  input.boost = false;
  if (input.reverse !== undefined) input.reverse = false;
  return true;
}

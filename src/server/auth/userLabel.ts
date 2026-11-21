import { getUser } from './AuthService.js';

/**
 * The name a ship carries for its owner (`ShipState.displayName`): the
 * account's display name, else its email; '' for no account (the client then
 * falls back to its own label). One rule for every hull: a joining pilot's
 * ship and a parked hull put in the world without a pilot alike.
 */
export function shipOwnerLabel(userId: string | null | undefined): string {
  if (!userId) return '';
  const user = getUser(userId);
  return user ? (user.displayName ?? user.email ?? '') : '';
}

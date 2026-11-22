/**
 * Owner names for display (pure, no React): the one rule every surface uses
 * to name whose something is. NEVER a raw playerId.
 */

/** Whose building, for display: "you", the owner's name, or "Unknown" for an
 *  orphan (the owner did not resolve to a user). NEVER a raw playerId. */
export function structureOwnerLabel(owner: string, ownerName: string | undefined, localId: string | null): string {
  return owner === localId ? 'you' : (ownerName ?? 'Unknown');
}

/**
 * Per-gate access setting (plan soft-leaping-truffle v2, phase V gates; user
 * decision 2026-11-01: configurable per gate). Who a Shield Gate / Airlock
 * opens for. The index is the room-state `gateAccess` byte — APPEND ONLY.
 *
 * Relations come from the B1 relation seam once it lands; until then a ship's
 * relation to a gate owner is 'self' (same player) or 'neutral'.
 */
export const GATE_ACCESS_IDS = ['allies', 'owner', 'open'] as const;
export type GateAccess = (typeof GATE_ACCESS_IDS)[number];

/** Wire byte of the default setting ("owner + allies"). */
export const GATE_ACCESS_DEFAULT = 0;

export const GATE_ACCESS_LABELS: Record<GateAccess, string> = {
  allies: 'Owner + allies',
  owner: 'Owner only',
  open: 'Anyone not hostile',
};

export type GateRelation = 'self' | 'allied' | 'neutral' | 'hostile';

export function gateAccessFromIndex(i: number | undefined): GateAccess {
  return GATE_ACCESS_IDS[i ?? GATE_ACCESS_DEFAULT] ?? 'allies';
}

export function gateAccessIndex(a: GateAccess): number {
  return GATE_ACCESS_IDS.indexOf(a);
}

/** Does a gate with `access` open for a ship with `relation` to its owner? */
export function gateAdmits(access: GateAccess, relation: GateRelation): boolean {
  if (relation === 'self') return true;
  if (relation === 'hostile') return false;
  if (access === 'owner') return false;
  if (access === 'allies') return relation === 'allied';
  return true; // 'open': anyone not hostile
}

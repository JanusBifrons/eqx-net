/**
 * Per-gate access setting (plan soft-leaping-truffle v2, phase V gates; user
 * decision 2026-11-01: configurable per gate). Who a Shield Gate / Airlock
 * opens for. The index is the room-state `gateAccess` byte — APPEND ONLY.
 *
 * A ship's relation to the gate's owner comes from `relationOf`
 * (`relations.ts`, B1).
 */
import type { Relation } from './relations.js';
export const GATE_ACCESS_IDS = ['allies', 'owner', 'open'] as const;
export type GateAccess = (typeof GATE_ACCESS_IDS)[number];

/** Wire byte of the default setting ("owner + allies"). */
export const GATE_ACCESS_DEFAULT = 0;

export const GATE_ACCESS_LABELS: Record<GateAccess, string> = {
  allies: 'Owner + allies',
  owner: 'Owner only',
  open: 'Anyone not hostile',
};

export type GateRelation = Relation;

export function gateAccessFromIndex(i: number | undefined): GateAccess {
  return GATE_ACCESS_IDS[i ?? GATE_ACCESS_DEFAULT] ?? 'allies';
}

export function gateAccessIndex(a: GateAccess): number {
  return GATE_ACCESS_IDS.indexOf(a);
}

/** Does a gate with `access` open for a ship with `relation` to its owner? */
export function gateAdmits(access: GateAccess, relation: GateRelation): boolean {
  // 'friendly' is the owner's own NPC side: it passes like the owner.
  if (relation === 'self' || relation === 'friendly') return true;
  if (relation === 'hostile') return false;
  if (access === 'owner') return false;
  if (access === 'allies') return relation === 'allied';
  return true; // 'open': anyone not hostile
}

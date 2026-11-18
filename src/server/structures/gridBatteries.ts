/**
 * Battery charge / discharge over one grid component (batteries plan, moved
 * out of StructureGridSubsystem.ts). `members` is a component's structure
 * ids; the per-pulse rule (`processBatteryPower`) stays in the subsystem.
 * Allocation-free.
 */
import { chargeStep, dischargeStep, drainPower } from '../../core/structures/batteryPower.js';
import type { StructureRegistry } from './StructureRegistry.js';

type Registry = Pick<StructureRegistry, 'get'>;

/** Charge a component's not-yet-full batteries with `surplus`, split evenly.
 *  Returns the surplus the batteries could not take (v4 T1: it charges
 *  teleporter capacitors). */
export function chargeComponentBatteries(
  registry: Registry,
  members: readonly string[],
  capacity: number,
  surplus: number,
): number {
  let count = 0;
  for (const id of members) {
    const rec = registry.get(id);
    if (rec && rec.kind === 'battery' && rec.storedPower < capacity) count++;
  }
  if (count === 0) return surplus;
  const share = surplus / count;
  let used = 0;
  for (const id of members) {
    const rec = registry.get(id);
    if (!rec || rec.kind !== 'battery' || rec.storedPower >= capacity) continue;
    const before = rec.storedPower;
    rec.storedPower = chargeStep(rec.storedPower, capacity, share).stored;
    used += rec.storedPower - before;
  }
  return Math.max(0, surplus - used);
}

/** Discharge a component's batteries to cover a per-pulse `deficit` — but only
 *  when their combined charge can meet it in full. Marks the whole component
 *  battery-backed (`rescued`) for this pulse. */
export function dischargeComponentBatteries(
  registry: Registry,
  members: readonly string[],
  deficit: number,
  rescued: Set<string>,
): void {
  let total = 0;
  for (const id of members) {
    const rec = registry.get(id);
    if (rec && rec.kind === 'battery') total += rec.storedPower;
  }
  if (total < deficit) return; // can't sustain the load → brownout, hold charge
  for (const id of members) rescued.add(id);
  let remaining = deficit;
  for (const id of members) {
    if (remaining <= 0) break;
    const rec = registry.get(id);
    if (!rec || rec.kind !== 'battery' || rec.storedPower <= 0) continue;
    const r = dischargeStep(rec.storedPower, remaining);
    rec.storedPower = r.stored;
    remaining -= r.supplied;
  }
}

/** Total stored battery charge over `members`. */
export function batteryChargeOf(registry: Registry, members: Iterable<string>): number {
  let total = 0;
  for (const mid of members) {
    const rec = registry.get(mid);
    if (rec && rec.kind === 'battery') total += rec.storedPower;
  }
  return total;
}

/** Drain up to `amount` from `members`' batteries (a shield-wall hit).
 *  Returns the amount actually drained. */
export function drainBatteries(registry: Registry, members: Iterable<string>, amount: number): number {
  let remaining = amount;
  for (const mid of members) {
    if (remaining <= 0) break;
    const rec = registry.get(mid);
    if (!rec || rec.kind !== 'battery' || rec.storedPower <= 0) continue;
    const r = drainPower(rec.storedPower, remaining);
    rec.storedPower = r.stored;
    remaining -= r.drained;
  }
  return amount - remaining;
}

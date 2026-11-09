/**
 * Reload + arc readout for a defence structure's naval guns (coastal defences,
 * handoff "Reload and arc UI"). Pure catalogue read, client-resident — the
 * inspector shows it instantly with no server round-trip.
 *
 * One line per gun size: `16" ×2 · reload 30 s · arc 144°`. Only naval mounts
 * (`naval_*` weapons) are listed; an all-round mount reads `all round`.
 */
import { getWeapon, type WeaponId } from '@core/combat/WeaponCatalogue';
import type { StructureKind } from '@shared-types/structureKinds';

const FULL_CIRCLE = Math.PI * 2;

/** Reload in ms — mirrors `StructureMountTicker.reloadMsOf` (the kind's
 *  `fireRateMs` for a gun, else the weapon's 60 Hz cooldown). */
export function structureGunReloadMs(kind: Pick<StructureKind, 'fireRateMs'>, cooldownTicks: number): number {
  return kind.fireRateMs ?? (cooldownTicks / 60) * 1000;
}

/** `30 s`, `4 s`, `2.5 s`. */
export function formatReloadSeconds(ms: number): string {
  const s = ms / 1000;
  const r = s >= 10 ? Math.round(s) : Math.round(s * 10) / 10;
  return `${r} s`;
}

/** Firing arc in whole degrees, or null when the mount trains all round. */
export function arcDegrees(arcMin: number, arcMax: number): number | null {
  const span = arcMax - arcMin;
  if (span >= FULL_CIRCLE - 1e-6) return null;
  return Math.round((span * 180) / Math.PI);
}

/** The inspector lines for a kind's naval guns (empty when it has none). */
export function structureGunLines(kind: Pick<StructureKind, 'mounts' | 'fireRateMs'>): string[] {
  const mounts = kind.mounts;
  if (!mounts || mounts.length === 0) return [];
  const order: string[] = [];
  const barrels = new Map<string, number>();
  const arcs = new Map<string, number | null>();
  for (const m of mounts) {
    const wid = m.weaponId;
    if (!wid || !wid.startsWith('naval')) continue;
    if (!barrels.has(wid)) {
      order.push(wid);
      barrels.set(wid, 0);
      arcs.set(wid, arcDegrees(m.arcMin, m.arcMax));
    }
    barrels.set(wid, barrels.get(wid)! + (m.barrels ?? 1));
  }
  return order.map((wid) => {
    const def = getWeapon(wid as WeaponId);
    const size = def.displayName.replace(/ gun$/, '');
    const n = barrels.get(wid)!;
    const arc = arcs.get(wid) ?? null;
    const reload = formatReloadSeconds(structureGunReloadMs(kind, def.cooldownTicks));
    return `${size}${n > 1 ? ` ×${n}` : ''} · reload ${reload} · ${arc === null ? 'all round' : `arc ${arc}°`}`;
  });
}

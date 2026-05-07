export type WeaponMode = 'hitscan' | 'projectile';
export type WeaponId = 'hitscan' | 'laser';

interface WeaponDefBase {
  id: WeaponId;
  displayName: string;
  mode: WeaponMode;
  damage: number;
  cooldownTicks: number;
}

export interface HitscanWeaponDef extends WeaponDefBase {
  mode: 'hitscan';
  range: number;
}

export interface ProjectileWeaponDef extends WeaponDefBase {
  mode: 'projectile';
  speed: number;
  radius: number;
  maxTicks: number;
}

export type WeaponDef = HitscanWeaponDef | ProjectileWeaponDef;

const HITSCAN_DEF: HitscanWeaponDef = {
  id: 'hitscan',
  displayName: 'Beam',
  mode: 'hitscan',
  damage: 20,
  cooldownTicks: 10,
  range: 500,
};

const LASER_DEF: ProjectileWeaponDef = {
  id: 'laser',
  displayName: 'Laser',
  mode: 'projectile',
  damage: 10,
  cooldownTicks: 10,
  speed: 1600,
  radius: 3,
  maxTicks: 90,
};

export const WEAPONS: ReadonlyMap<WeaponId, WeaponDef> = new Map<WeaponId, WeaponDef>([
  ['hitscan', HITSCAN_DEF],
  ['laser', LASER_DEF],
]);

export const WEAPON_IDS: readonly WeaponId[] = ['hitscan', 'laser'] as const;

export const DEFAULT_WEAPON: WeaponId = 'hitscan';

export function getWeapon(id: WeaponId): WeaponDef {
  return WEAPONS.get(id) ?? HITSCAN_DEF;
}

export function isWeaponId(v: unknown): v is WeaponId {
  return v === 'hitscan' || v === 'laser';
}

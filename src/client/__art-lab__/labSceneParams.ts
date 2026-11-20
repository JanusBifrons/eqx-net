/**
 * Art lab — URL parameters that pick a scene's contents (structure restyle
 * Stage 4 Phase 0b). Pure parsers over a query string, so tests drive them
 * without a browser.
 */
import { BASE_ROLES, BASE_TIERS, type BaseRole, type BaseTier } from '../../core/bases/baseProfile.js';
import { isStructureKindId } from '../../shared-types/structureKinds.js';

/** The page's query string (empty under node tests). */
export function labSearch(): string {
  return typeof location === 'undefined' ? '' : location.search;
}

/** `?kinds=solar,battery,...`: the structure kind ids to show, in order,
 *  unknown ids dropped. Null when absent or nothing valid. */
export function parseKinds(search: string): string[] | null {
  const raw = new URLSearchParams(search).get('kinds');
  if (raw === null) return null;
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0 && isStructureKindId(s));
  return ids.length > 0 ? ids : null;
}

export interface GrownBaseParams { tier: BaseTier; role: BaseRole; seed: number }

/** `?tier=` / `?role=` / `?seed=` for the `base` scene. Defaults: a medium
 *  (settlement) workshop, seed 1. */
export function parseGrownBaseParams(search: string): GrownBaseParams {
  const q = new URLSearchParams(search);
  const tier = q.get('tier'), role = q.get('role'), seed = Number(q.get('seed'));
  return {
    tier: (BASE_TIERS as readonly string[]).includes(tier ?? '') ? (tier as BaseTier) : 'settlement',
    role: (BASE_ROLES as readonly string[]).includes(role ?? '') ? (role as BaseRole) : 'workshop',
    seed: q.has('seed') && Number.isFinite(seed) ? Math.trunc(seed) : 1,
  };
}

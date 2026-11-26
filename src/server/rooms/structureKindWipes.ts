/**
 * Per-kind wipe flag for the structure-catalogue version gate (plan wave 4,
 * job 4H). Extends `SectorPersistence.hydrate`'s `STRUCTURE_KIND_CATALOGUE_VERSION`
 * gate: a bump used to discard EVERY saved structure; a bump that lists the
 * kinds it changed here discards only rows of those kinds.
 *
 * How to flag: when you bump `STRUCTURE_KIND_CATALOGUE_VERSION` to N, add
 * `N: ['kind-id', ...]` below naming every kind whose record changed. A bump
 * with no entry keeps the old behaviour (every saved structure is discarded),
 * so forgetting the flag fails safe. Entries are permanent history: never
 * edit or remove one, or a sector still saved at an older version would
 * migrate wrongly.
 *
 * Wiped buildings are removed, not refunded (same as the whole-set discard).
 * The next snapshot stamps the live version, so a wipe happens once.
 */

/** Catalogue version → the structure kind ids whose record changed at it. */
export type StructureKindWipes = Readonly<Record<number, readonly string[]>>;

export const STRUCTURE_KIND_WIPES: StructureKindWipes = Object.freeze({
  // 16→17 (base platforms): every kind gained `deckSlot`; no size or stat changed.
  17: [],
});

export interface StructureMigration<T> {
  kept: T[];
  /** Rows dropped (flagged kinds, or the whole set). */
  wiped: number;
  /** True when no per-kind path existed and every row was discarded. */
  wholeSet: boolean;
}

/**
 * Migrate saved structure rows from `storedVersion` to `liveVersion`. Keeps
 * every row when the versions match; drops rows of the flagged kinds when
 * every bump in between is flagged; otherwise drops them all.
 */
export function migrateStructureRows<T extends { kind: string }>(
  rows: readonly T[],
  storedVersion: number | undefined,
  liveVersion: number,
  wipes: StructureKindWipes = STRUCTURE_KIND_WIPES,
): StructureMigration<T> {
  if (storedVersion === liveVersion) return { kept: [...rows], wiped: 0, wholeSet: false };
  const wiped = new Set<string>();
  let perKind = storedVersion !== undefined && storedVersion < liveVersion;
  if (perKind) {
    for (let v = storedVersion! + 1; v <= liveVersion; v++) {
      const kinds = wipes[v];
      if (kinds === undefined) { perKind = false; break; }
      for (const k of kinds) wiped.add(k);
    }
  }
  if (!perKind) return { kept: [], wiped: rows.length, wholeSet: true };
  const kept = rows.filter((r) => !wiped.has(r.kind));
  return { kept, wiped: rows.length - kept.length, wholeSet: false };
}

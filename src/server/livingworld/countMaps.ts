/** Per-sector count maps (galaxy-snapshot plumbing). */

/** `a` + `b`, per key. Returns an input unchanged when the other is empty.
 *  Control cadence (allocates). */
export function sumCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  if (b.size === 0) return a;
  if (a.size === 0) return b;
  const out = new Map(a);
  for (const [k, n] of b) out.set(k, (out.get(k) ?? 0) + n);
  return out;
}

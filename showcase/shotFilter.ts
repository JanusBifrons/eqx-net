/**
 * `--shot` selection: comma-separated ids, each may use `*` wildcards
 * (`--shot 'hud-*'`, `--shot 'hud-a-*,flight'`). Pure — unit-locked in
 * tests/unit/showcaseTouch.test.ts.
 */

/** Expand patterns against the known ids (registry order kept, no duplicates).
 *  Throws on a pattern that matches nothing, so a typo never records nothing. */
export function expandShotPatterns(patterns: readonly string[], ids: readonly string[]): string[] {
  const picked = new Set<string>();
  const unknown: string[] = [];
  for (const pat of patterns) {
    const re = new RegExp(`^${pat.split('*').map(escapeRe).join('.*')}$`);
    const hits = ids.filter((id) => re.test(id));
    if (hits.length === 0) unknown.push(pat);
    for (const h of hits) picked.add(h);
  }
  if (unknown.length) throw new Error(`unknown shot(s): ${unknown.join(', ')}`);
  return ids.filter((id) => picked.has(id));
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Showcase coverage lock (docs/architecture/showcase-pipeline.md).
 *
 * Keeps the showcase video repeatable as features land: every feature and
 * architecture doc must be FILMED by a shot (`shot.docs`), or listed as EXEMPT
 * (not filmable, with a reason) or PENDING (filmable once something lands).
 * A new doc with none of those fails here — add a shot or an entry.
 *
 * Also checks every shot points at a room / galaxy sector that exists, so a
 * renamed room breaks CI instead of a recording run.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SHOTS, SHOWCASE_EXEMPT, SHOWCASE_PENDING } from '../../showcase/registry.js';
import { SHOWCASE_ROOMS } from '../../src/server/rooms/showcaseRooms.js';
import { GALAXY_SECTORS } from '../../src/core/galaxy/galaxy.js';

const ROOT = path.resolve(__dirname, '../..');

function docBasenames(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

const ALL_DOCS = [...docBasenames('docs/features'), ...docBasenames('docs/architecture')];
const FILMED = new Set(SHOTS.flatMap((s) => s.docs));

describe('showcase coverage', () => {
  it('every feature/architecture doc is filmed, exempt or pending', () => {
    const missing = ALL_DOCS.filter(
      (d) => !FILMED.has(d) && !(d in SHOWCASE_EXEMPT) && !(d in SHOWCASE_PENDING),
    );
    expect(missing, `add a shot (shot.docs) or a SHOWCASE_EXEMPT/PENDING entry in showcase/registry.ts for: ${missing.join(', ')}`).toEqual([]);
  });

  it('shots, exemptions and pending entries only name docs that exist', () => {
    const known = new Set(ALL_DOCS);
    const stale = [...FILMED, ...Object.keys(SHOWCASE_EXEMPT), ...Object.keys(SHOWCASE_PENDING)].filter((d) => !known.has(d));
    expect(stale).toEqual([]);
  });

  it('every exemption and pending entry gives a reason', () => {
    for (const [doc, why] of Object.entries({ ...SHOWCASE_EXEMPT, ...SHOWCASE_PENDING })) {
      expect(why.trim().length, doc).toBeGreaterThan(10);
    }
  });

  it('shot ids are unique and every reel shot is captioned', () => {
    const ids = SHOTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SHOTS.filter((x) => x.reel)) {
      expect(s.title.length, s.id).toBeGreaterThan(0);
      expect(s.caption.length, s.id).toBeGreaterThan(20);
    }
  });

  it('every shot targets a room or galaxy sector the server defines', () => {
    const index = readFileSync(path.join(ROOT, 'src/server/index.ts'), 'utf8');
    const defined = new Set([...index.matchAll(/define\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]!));
    for (const name of Object.keys(SHOWCASE_ROOMS)) defined.add(name);
    const sectors = new Set(GALAXY_SECTORS.map((s) => s.key));
    for (const s of SHOTS) {
      if (s.target.room) expect(defined.has(s.target.room), `${s.id} → room '${s.target.room}'`).toBe(true);
      if (s.target.galaxy) expect(sectors.has(s.target.galaxy), `${s.id} → sector '${s.target.galaxy}'`).toBe(true);
      expect(Boolean(s.target.room) || Boolean(s.target.galaxy) || Boolean(s.target.landing), s.id).toBe(true);
    }
  });
});

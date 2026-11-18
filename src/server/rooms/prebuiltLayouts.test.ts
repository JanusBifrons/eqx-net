/**
 * Every hand-written prebuilt layout seeds whole: placing its structures in
 * order through the real placement seam (`StructurePlacementSubsystem.place`,
 * the one `SectorRoom.seedStructureScenario` uses) rejects nothing. A rejected
 * structure is dropped silently at room seed (a log line), so a rule change
 * (e.g. a kind gaining a `keepClear` landing pad) can quietly unpower a test
 * or showcase base. This test names the layout, the structure and the reason.
 *
 * Layouts are collected from the modules' exports (any array of
 * `{ kind, x, y }`, or any object with `prebuiltStructures`), so a new export
 * is covered without editing this file.
 */
import { describe, it, expect } from 'vitest';
import * as scenarioLayouts from './scenarioLayouts.js';
import * as showcaseRooms from './showcaseRooms.js';
import { StructureRegistry } from '../structures/StructureRegistry.js';
import { StructurePlacementSubsystem } from '../structures/StructurePlacementSubsystem.js';
import { placementRejection } from '../../core/structures/placementRules.js';

interface Seed { kind: string; x: number; y: number; rot?: number }

function isSeedList(v: unknown): v is readonly Seed[] {
  return Array.isArray(v) && v.length > 0 && v.every((p) => p !== null && typeof p === 'object'
    && typeof (p as Seed).kind === 'string' && typeof (p as Seed).x === 'number' && typeof (p as Seed).y === 'number');
}

/** Layouts already collected (a room's options are exported twice). */
const seen = new Set<unknown>();

/** name → structures, from one module's exports (and SHOWCASE_ROOMS' rooms). */
function collect(prefix: string, mod: Record<string, unknown>, out: Map<string, readonly Seed[]>): void {
  for (const [name, v] of Object.entries(mod)) {
    if (seen.has(v)) continue;
    seen.add(v);
    if (isSeedList(v)) out.set(`${prefix}.${name}`, v);
    else if (v !== null && typeof v === 'object') {
      const pb = (v as { prebuiltStructures?: unknown }).prebuiltStructures;
      if (isSeedList(pb) && !seen.has(pb)) {
        seen.add(pb);
        out.set(`${prefix}.${name}.prebuiltStructures`, pb);
      }
    }
  }
}

const LAYOUTS = new Map<string, readonly Seed[]>();
collect('scenarioLayouts', scenarioLayouts as Record<string, unknown>, LAYOUTS);
collect('showcaseRooms', showcaseRooms as Record<string, unknown>, LAYOUTS);
collect('SHOWCASE_ROOMS', showcaseRooms.SHOWCASE_ROOMS as Record<string, unknown>, LAYOUTS);

/** Seed `layout` the way a room does; returns one line per rejected structure. */
function seedRejections(layout: readonly Seed[]): string[] {
  const registry = new StructureRegistry();
  let n = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: () => {},
    despawn: () => {},
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${n++}`,
    registry,
  });
  const out: string[] = [];
  for (const p of layout) {
    const why = placementRejection(p.kind, p.x, p.y, registry.all(), null, p.rot ?? 0);
    const id = placement.place('owner', p.kind, p.x, p.y, { rot: p.rot });
    if (id === null) out.push(`${p.kind} (${p.x}, ${p.y}) rot ${p.rot ?? 0}: ${why ?? 'rejected'}`);
  }
  return out;
}

describe('prebuilt layouts seed whole (no structure rejected)', () => {
  it('finds the hand-written layouts', () => {
    for (const name of [
      'scenarioLayouts.STRUCTURE_SCENARIO_PREBUILT',
      'scenarioLayouts.GATE_TEST_PREBUILT',
      'scenarioLayouts.RIG_SANDBOX_PREBUILT',
      'showcaseRooms.SHOWCASE_HOMESTEAD_OPTS.prebuiltStructures',
      'showcaseRooms.SHOWCASE_DEFENCE_OPTS.prebuiltStructures',
    ]) expect(LAYOUTS.has(name), name).toBe(true);
  });

  for (const [name, layout] of LAYOUTS) {
    it(name, () => {
      expect(seedRejections(layout)).toEqual([]);
    });
  }
});

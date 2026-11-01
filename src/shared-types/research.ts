/**
 * Research Lab rules (economy v2 W3, plan peppy-jumping-pinwheel). Pure: the
 * server runs them, the client uses the same numbers to show fees and times.
 *
 * Three jobs, each on blueprints in the lab's base storage:
 *  - RESEARCH an original: +1 material efficiency or +10 output quality. Each
 *    level takes longer and costs more than the last.
 *  - COPY an original into a copy with N runs that inherits its stats.
 *  - COMBINE three blueprints of the same product (all originals, or all
 *    copies) into ONE: the best of each stat plus a small random improvement
 *    (the gacha). A combine is never worse than its best input.
 *
 * Combine rolls are seeded from the input uids, so the same three blueprints
 * always give the same result: cancelling and restarting can't reroll it.
 * Times are in grid pulses (1 Hz), and only count while the lab is powered.
 */
import { MATERIAL_MAX, uidFrom } from './blueprints.js';
import type { BlueprintItem } from './items.js';

export type ResearchStat = 'material' | 'output';

/** One step of research per stat. */
export const RESEARCH_STEP: Readonly<Record<ResearchStat, number>> = Object.freeze({ material: 1, output: 10 });
export const RESEARCH_MAX: Readonly<Record<ResearchStat, number>> = Object.freeze({ material: MATERIAL_MAX, output: 100 });

/** Copy runs per job (1 … COPY_MAX_RUNS). */
export const COPY_MAX_RUNS = 10;
export const COMBINE_COUNT = 3;
export const COMBINE_PULSES = 90;
export const COMBINE_FEE = 200;
/** A combined copy keeps this fraction of the summed runs (at least 1). */
export const COMBINE_RUNS_FRAC = 0.6;
/** Combine bonus rolls: +0 … +2 material, +0 … +15 output. */
export const COMBINE_MATERIAL_BONUS_MAX = 2;
export const COMBINE_OUTPUT_BONUS_MAX = 15;

export type LabJobSpec =
  | { kind: 'research'; stat: ResearchStat; uid: string }
  | { kind: 'copy'; uid: string; runs: number }
  | { kind: 'combine'; uids: string[] };

/** The research level a stat is at (0 = never researched). */
export function researchLevel(bp: Pick<BlueprintItem, 'material' | 'output'>, stat: ResearchStat): number {
  return Math.floor(bp[stat] / RESEARCH_STEP[stat]);
}

export function researchPulses(level: number): number {
  return 30 * (level + 1);
}

export function researchFee(level: number): number {
  return 60 * (level + 1);
}

export function copyPulses(runs: number): number {
  return 15 * runs;
}

export function copyFee(runs: number): number {
  return 25 * runs;
}

export interface LabPlan {
  ok: true;
  /** The blueprints the job takes out of storage while it runs. */
  inputs: BlueprintItem[];
  pulses: number;
  fee: number;
}

export interface LabRefusal {
  ok: false;
  message: string;
}

/**
 * Check a job against the blueprints available (by uid) and work out its
 * inputs, time and fee. The messages are player-facing.
 */
export function planLabJob(spec: LabJobSpec, find: (uid: string) => BlueprintItem | undefined): LabPlan | LabRefusal {
  if (spec.kind === 'research') {
    const bp = find(spec.uid);
    if (bp === undefined) return { ok: false, message: 'That blueprint is not in this base.' };
    if (bp.kind !== 'bpo') return { ok: false, message: 'Only originals can be researched.' };
    if (bp.bound === true) return { ok: false, message: 'That blueprint cannot be moved.' };
    if (bp[spec.stat] + RESEARCH_STEP[spec.stat] > RESEARCH_MAX[spec.stat]) {
      return { ok: false, message: 'That stat is already fully researched.' };
    }
    const level = researchLevel(bp, spec.stat);
    return { ok: true, inputs: [bp], pulses: researchPulses(level), fee: researchFee(level) };
  }
  if (spec.kind === 'copy') {
    const bp = find(spec.uid);
    if (bp === undefined) return { ok: false, message: 'That blueprint is not in this base.' };
    if (bp.kind !== 'bpo') return { ok: false, message: 'Only originals can be copied.' };
    if (bp.bound === true) return { ok: false, message: 'That blueprint cannot be moved.' };
    const runs = Math.floor(spec.runs);
    if (!(runs >= 1 && runs <= COPY_MAX_RUNS)) return { ok: false, message: `A copy has 1–${COPY_MAX_RUNS} runs.` };
    return { ok: true, inputs: [bp], pulses: copyPulses(runs), fee: copyFee(runs) };
  }
  if (spec.uids.length !== COMBINE_COUNT || new Set(spec.uids).size !== COMBINE_COUNT) {
    return { ok: false, message: `Combining takes ${COMBINE_COUNT} different blueprints.` };
  }
  const inputs: BlueprintItem[] = [];
  for (const uid of spec.uids) {
    const bp = find(uid);
    if (bp === undefined) return { ok: false, message: 'A blueprint is not in this base.' };
    if (bp.bound === true) return { ok: false, message: 'That blueprint cannot be moved.' };
    inputs.push(bp);
  }
  const first = inputs[0]!;
  if (inputs.some((b) => b.product !== first.product)) return { ok: false, message: 'Combine blueprints for the same product.' };
  if (inputs.some((b) => b.kind !== first.kind)) return { ok: false, message: 'Combine all originals or all copies, not a mix.' };
  return { ok: true, inputs, pulses: COMBINE_PULSES, fee: COMBINE_FEE };
}

/** FNV-1a over the sorted uids: the combine seed (order-independent). */
export function combineSeed(uids: readonly string[]): number {
  const s = [...uids].sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** mulberry32 — a small seeded rng in [0, 1). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Finish a job: the blueprints that go back into storage. Pure; never mutates
 * the inputs. `seed` only matters for a copy's new uid; a combine seeds itself
 * from its inputs.
 */
export function completeLabJob(spec: LabJobSpec, inputs: readonly BlueprintItem[], seed: number): BlueprintItem[] {
  if (spec.kind === 'research') {
    const bp = { ...inputs[0]! };
    bp[spec.stat] = Math.min(RESEARCH_MAX[spec.stat], bp[spec.stat] + RESEARCH_STEP[spec.stat]);
    bp.research += 1;
    return [bp];
  }
  if (spec.kind === 'copy') {
    const bpo = inputs[0]!;
    const copy: BlueprintItem = {
      uid: uidFrom(seededRng(seed)),
      product: bpo.product,
      kind: 'bpc',
      runs: Math.max(1, Math.min(COPY_MAX_RUNS, Math.floor(spec.runs))),
      material: bpo.material,
      output: bpo.output,
      research: 0,
    };
    return [{ ...bpo }, copy];
  }
  const rng = seededRng(combineSeed(inputs.map((b) => b.uid)));
  const best = (stat: ResearchStat): number => Math.max(...inputs.map((b) => b[stat]));
  const first = inputs[0]!;
  const runs = first.kind === 'bpo'
    ? null
    : Math.max(1, Math.floor(inputs.reduce((s, b) => s + (b.runs ?? 0), 0) * COMBINE_RUNS_FRAC));
  return [{
    uid: uidFrom(rng),
    product: first.product,
    kind: first.kind,
    runs,
    material: Math.min(MATERIAL_MAX, best('material') + Math.floor(rng() * (COMBINE_MATERIAL_BONUS_MAX + 1))),
    output: Math.min(100, best('output') + Math.floor(rng() * (COMBINE_OUTPUT_BONUS_MAX + 1))),
    research: Math.max(...inputs.map((b) => b.research)),
  }];
}

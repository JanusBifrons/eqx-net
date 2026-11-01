/**
 * The running Research Lab jobs (economy v2 W3, plan peppy-jumping-pinwheel).
 *
 * One record per busy lab, keyed by the lab's structure uid. A job HOLDS its
 * blueprints while it runs (they leave base storage when it starts), so the
 * record is persisted as ONE `economy_state` row (`lab_jobs`), written in the
 * same atomic group as the storage change and the wallet fee. Progress is
 * saved every few pulses (`flushProgress`). Room-side logic:
 * `structures/ResearchLabSubsystem.ts`.
 */
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { BlueprintItemSchema, type BlueprintItem } from '../../shared-types/items.js';
import type { LabJobSpec } from '../../shared-types/research.js';
import { LabJobSpecSchema } from '../../shared-types/messages/labMessages.js';

export const LAB_JOBS_STATE_KEY = 'lab_jobs';

export interface LabJobRecord {
  labUid: string;
  owner: string;
  sectorKey: string | null;
  spec: LabJobSpec;
  /** The blueprints the job holds while it runs. */
  inputs: BlueprintItem[];
  /** Pulses needed / done so far (only powered pulses count). */
  pulses: number;
  done: number;
  /** Seeds a copy's new uid. */
  seed: number;
  startedAtMs: number;
}

export class LabBoard {
  private readonly records = new Map<string, LabJobRecord>();
  private progressDirty = false;

  constructor(private readonly deps: { persistence: () => IPersistenceSink | null; now?: () => number }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Boot hydrate from the persisted JSON (corrupt rows are dropped). */
  hydrate(json: string | null | undefined): void {
    this.records.clear();
    if (!json) return;
    let rows: unknown;
    try {
      rows = JSON.parse(json);
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    for (const r of rows as Array<Record<string, unknown>>) {
      const spec = LabJobSpecSchema.safeParse(r?.spec);
      const inputs = Array.isArray(r?.inputs) ? r.inputs.map((i) => BlueprintItemSchema.safeParse(i)) : [];
      if (!spec.success || inputs.length === 0 || inputs.some((i) => !i.success)) continue;
      if (typeof r.labUid !== 'string' || typeof r.owner !== 'string') continue;
      const pulses = Number(r.pulses);
      if (!(pulses > 0)) continue;
      this.records.set(r.labUid, {
        labUid: r.labUid,
        owner: r.owner,
        sectorKey: typeof r.sectorKey === 'string' ? r.sectorKey : null,
        spec: spec.data,
        inputs: inputs.map((i) => i.data!),
        pulses,
        done: Math.max(0, Math.min(pulses, Math.floor(Number(r.done) || 0))),
        seed: Math.floor(Number(r.seed) || 0) >>> 0,
        startedAtMs: Number(r.startedAtMs) || 0,
      });
    }
  }

  get(labUid: string): LabJobRecord | undefined {
    return this.records.get(labUid);
  }

  set(rec: LabJobRecord): void {
    this.records.set(rec.labUid, rec);
  }

  delete(labUid: string): boolean {
    return this.records.delete(labUid);
  }

  /** Every job (inspection / tests). Allocates. */
  all(): LabJobRecord[] {
    return [...this.records.values()];
  }

  /** Count a powered pulse on a job; true when it has just finished. */
  advance(labUid: string): boolean {
    const r = this.records.get(labUid);
    if (r === undefined || r.done >= r.pulses) return r !== undefined && r.done >= r.pulses;
    r.done += 1;
    this.progressDirty = true;
    return r.done >= r.pulses;
  }

  /** The whole board as ONE op, to commit with the caller's group. */
  op(): PersistOp {
    this.progressDirty = false;
    return {
      type: 'ECON_STATE_PUT',
      key: LAB_JOBS_STATE_KEY,
      payloadJson: JSON.stringify([...this.records.values()]),
      ts: this.now(),
    };
  }

  /** Persist the board on its own (a lab removed; progress checkpoint). */
  persistNow(): void {
    const sink = this.deps.persistence();
    const op = this.op();
    if (sink !== null) sink.enqueueCritical(op);
  }

  /** Save progress if any job advanced since the last write. */
  flushProgress(): void {
    if (this.progressDirty) this.persistNow();
  }
}

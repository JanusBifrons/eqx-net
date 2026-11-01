/**
 * Research Lab, room side (economy v2 W3, plan peppy-jumping-pinwheel).
 *
 * A lab works on blueprints in its owner's base storage (any operational
 * storage in the same grid component). Starting a job takes its blueprints out
 * of storage and charges the fee from the wallet, in ONE atomic group with the
 * job record (`LabBoard`). The job advances one pulse per 1 Hz grid pulse
 * while the lab is built and powered; when it finishes, the results go back
 * into storage (again one group). Cancelling returns the blueprints (the fee
 * is spent). A lab destroyed mid-job spills its blueprints as a pod.
 *
 * Pure rules: `shared-types/research.ts`. Control cadence only (allocates).
 */
import { auditEvent } from '../audit/GameplayAuditLog.js';
import type { Wallet } from '../economy/Wallet.js';
import type { LabBoard, LabJobRecord } from '../economy/LabBoard.js';
import type { StorageService } from '../cargo/StorageService.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';
import { blueprintQuality, productName } from '../../shared-types/blueprints.js';
import type { Hold } from '../../shared-types/goods.js';
import type { BlueprintItem } from '../../shared-types/items.js';
import { completeLabJob, planLabJob, type LabJobSpec } from '../../shared-types/research.js';
import type { LabBlueprintView, LabJobView, LabState } from '../../shared-types/messages/labMessages.js';

export const RESEARCH_LAB_KIND = 'research_lab';
/** Save job progress every this many powered pulses. */
export const LAB_PROGRESS_SAVE_PULSES = 15;

export interface ResearchLabDeps {
  board: () => LabBoard;
  wallet: () => Pick<Wallet, 'debitDeferred' | 'flush'>;
  storage: StorageService;
  registry: StructureRegistry;
  powered: (structureId: string) => boolean;
  /** Active power: a lab draws full only while its job advances. */
  setActive?: (lab: StructureRecord, active: boolean) => void;
  sectorKey: () => string | null;
  now?: () => number;
  rng?: () => number;
}

export interface LabVerdict {
  ok: boolean;
  message: string;
}

export class ResearchLabSubsystem {
  private pulsesSinceSave = 0;

  constructor(private readonly d: ResearchLabDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** Can `owner` use this lab? Null when they can, else why not. */
  private refusal(owner: string, lab: StructureRecord): string | null {
    if (lab.kind !== RESEARCH_LAB_KIND) return 'That is not a Research Lab.';
    if (lab.owner !== owner) return 'That is not your Research Lab.';
    if (lab.uid === undefined) return 'That lab is not ready yet.';
    if (!lab.isConstructed) return 'Finish building the lab first.';
    return null;
  }

  private findIn(network: readonly StructureRecord[], uid: string): { rec: StructureRecord; item: BlueprintItem } | null {
    for (const rec of network) {
      const item = rec.hold?.blueprints.find((b) => b.uid === uid);
      if (item !== undefined) return { rec, item };
    }
    return null;
  }

  /** Start `spec` on `lab` for `owner`. */
  start(owner: string, lab: StructureRecord, spec: LabJobSpec): LabVerdict {
    const why = this.refusal(owner, lab);
    if (why !== null) return { ok: false, message: why };
    const board = this.d.board();
    if (board.get(lab.uid!) !== undefined) return { ok: false, message: 'The lab is already busy.' };
    const network = this.d.storage.networkFor(lab);
    if (network.length === 0) return { ok: false, message: 'Connect the lab to your base storage first.' };
    const plan = planLabJob(spec, (uid) => this.findIn(network, uid)?.item);
    if (!plan.ok) return { ok: false, message: plan.message };
    const pay = this.d.wallet().debitDeferred(owner, plan.fee, 'lab_job');
    if (pay === null) return { ok: false, message: `You need ${plan.fee}¢ for that job.` };
    // Take the inputs out of storage: the job holds them while it runs.
    const touched: StructureRecord[] = [];
    const inputs: BlueprintItem[] = [];
    for (const want of plan.inputs) {
      const found = this.findIn(network, want.uid)!;
      const list = found.rec.hold!.blueprints;
      list.splice(list.indexOf(found.item), 1);
      inputs.push(found.item);
      if (!touched.includes(found.rec)) touched.push(found.rec);
    }
    const rng = this.d.rng ?? Math.random;
    board.set({
      labUid: lab.uid!,
      owner,
      sectorKey: this.d.sectorKey(),
      spec,
      inputs,
      pulses: plan.pulses,
      done: 0,
      seed: Math.floor(rng() * 0x7fffffff),
      startedAtMs: this.now(),
    });
    this.d.storage.commitChanged(touched, [board.op(), pay]);
    auditEvent({ event: 'lab_job_started', sector: this.d.sectorKey() ?? undefined, playerId: owner, job: spec.kind, product: inputs[0]!.product, fee: plan.fee });
    return { ok: true, message: `${jobLabel(spec, inputs)} started.` };
  }

  /** Cancel the lab's job: its blueprints go back to storage; the fee is spent. */
  cancel(owner: string, lab: StructureRecord): LabVerdict {
    const why = this.refusal(owner, lab);
    if (why !== null) return { ok: false, message: why };
    const board = this.d.board();
    const job = board.get(lab.uid!);
    if (job === undefined) return { ok: false, message: 'The lab is idle.' };
    const target = this.d.storage.networkFor(lab)[0];
    if (target === undefined) return { ok: false, message: 'Connect the lab to your base storage first.' };
    this.deliver(target, job.inputs);
    board.delete(lab.uid!);
    this.d.storage.commitChanged([target], [board.op()]);
    auditEvent({ event: 'lab_job_cancelled', sector: this.d.sectorKey() ?? undefined, playerId: owner, job: job.spec.kind });
    return { ok: true, message: 'Job cancelled. The blueprints are back in storage.' };
  }

  /** 1 Hz: advance every built, powered lab's job; finish the done ones. */
  pulse(): void {
    const board = this.d.board();
    let advanced = false;
    for (const lab of this.d.registry.all()) {
      if (lab.kind !== RESEARCH_LAB_KIND || lab.uid === undefined) continue;
      const job = board.get(lab.uid);
      const working = job !== undefined && job.done < job.pulses && lab.isConstructed && this.d.powered(lab.id);
      this.d.setActive?.(lab, working);
      if (job === undefined) continue;
      if (job.done < job.pulses) {
        if (!working) continue;
        board.advance(lab.uid);
        advanced = true;
      }
      if (job.done >= job.pulses) this.finish(lab, job);
    }
    if (advanced && ++this.pulsesSinceSave >= LAB_PROGRESS_SAVE_PULSES) {
      this.pulsesSinceSave = 0;
      board.flushProgress();
    }
  }

  /** A finished job delivers into storage; with no storage it waits. */
  private finish(lab: StructureRecord, job: LabJobRecord): void {
    const target = this.d.storage.networkFor(lab)[0];
    if (target === undefined) return;
    const out = completeLabJob(job.spec, job.inputs, job.seed);
    this.deliver(target, out);
    const board = this.d.board();
    board.delete(job.labUid);
    this.d.storage.commitChanged([target], [board.op()]);
    auditEvent({ event: 'lab_job_done', sector: this.d.sectorKey() ?? undefined, playerId: job.owner, job: job.spec.kind, product: out[0]?.product });
  }

  private deliver(target: StructureRecord, items: readonly BlueprintItem[]): void {
    if (target.hold === undefined) target.hold = { goods: {}, blueprints: [] };
    for (const b of items) target.hold.blueprints.push(b);
  }

  /** A lab left the world: drop its job and return the blueprints to spill
   *  (null when it was idle). */
  onRemoved(lab: StructureRecord): Hold | null {
    if (lab.kind !== RESEARCH_LAB_KIND || lab.uid === undefined) return null;
    const board = this.d.board();
    const job = board.get(lab.uid);
    if (job === undefined) return null;
    board.delete(lab.uid);
    board.persistNow();
    return { goods: {}, blueprints: job.inputs };
  }

  /** The lab panel's view for `owner` (with the verdict of an action). */
  view(owner: string, lab: StructureRecord, entityId: number, verdict?: LabVerdict): LabState {
    const state: LabState = {
      type: 'lab_state',
      entityId,
      powered: lab.isConstructed && this.d.powered(lab.id),
      connected: false,
      job: null,
      blueprints: [],
    };
    if (verdict !== undefined) {
      state.ok = verdict.ok;
      state.message = verdict.message;
    }
    if (lab.owner !== owner) return state;
    const network = this.d.storage.networkFor(lab);
    state.connected = network.length > 0;
    for (const rec of network) {
      for (const b of rec.hold?.blueprints ?? []) {
        if (state.blueprints.length >= 200) break;
        state.blueprints.push(blueprintView(b));
      }
    }
    const job = lab.uid !== undefined ? this.d.board().get(lab.uid) : undefined;
    if (job !== undefined) state.job = jobView(job);
    return state;
  }
}

export function blueprintView(b: BlueprintItem): LabBlueprintView {
  return {
    uid: b.uid,
    product: b.product,
    name: productName(b.product),
    kind: b.kind,
    runs: b.runs,
    material: b.material,
    output: b.output,
    quality: blueprintQuality(b),
  };
}

function jobLabel(spec: LabJobSpec, inputs: readonly BlueprintItem[]): string {
  const name = productName(inputs[0]?.product ?? '');
  if (spec.kind === 'research') return `Researching ${name} (${spec.stat === 'material' ? 'materials' : 'output'})`;
  if (spec.kind === 'copy') return `Copying ${name} (${spec.runs} run${spec.runs === 1 ? '' : 's'})`;
  return `Combining 3 × ${name}`;
}

function jobView(job: LabJobRecord): LabJobView {
  return { kind: job.spec.kind, label: jobLabel(job.spec, job.inputs), done: job.done, pulses: job.pulses };
}

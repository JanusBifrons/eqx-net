/**
 * Force fields — the room's one owner of which fields exist in its physics
 * world (`core/physics/forceFields.ts`). Every `SET_FORCE_FIELD` /
 * `REMOVE_FORCE_FIELD` the room sends goes through here, so a feature that
 * pushes bodies (teleporter pads today; tractor beams and gravity wells later)
 * adds a field here instead of posting to the worker itself.
 * Guide: docs/architecture/physics-worker.md "Force fields".
 */
import type { ForceField } from '../../core/physics/forceFields.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

export interface ForceFieldDeps {
  /** Send a command to this room's physics worker. */
  post(cmd: WorkerCmd): void;
}

export class ForceFieldSubsystem {
  private readonly fields = new Map<string, ForceField>();

  constructor(private readonly d: ForceFieldDeps) {}

  /** Add or update a field (idempotent on `id`). Takes ownership of `field`. */
  set(id: string, field: ForceField): void {
    this.fields.set(id, field);
    this.d.post({ type: 'SET_FORCE_FIELD', id, field });
  }

  /** Remove a field; a no-op in the worker for an unknown id. */
  remove(id: string): void {
    this.fields.delete(id);
    this.d.post({ type: 'REMOVE_FORCE_FIELD', id });
  }

  get(id: string): Readonly<ForceField> | undefined {
    return this.fields.get(id);
  }

  get size(): number {
    return this.fields.size;
  }
}

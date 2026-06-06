/**
 * EntityKindRegistry — the single, APPEND-ONLY catalogue mapping each
 * `EntityKindTag` to its static descriptors (sync profile + render
 * contribution + damageable flag). This is the "declare a leaf once" seam:
 * the registration+routing layer reads these descriptors instead of branching
 * on id-string shape, so a new type is a registry row plus a leaf.
 *
 * Append-only discipline (mirrors invariant #11, the ship-kind catalogue):
 *   - Adding a kind APPENDS a row to `SEED`. Never reorder or remove a row.
 *   - A pose-core `kind` byte, once assigned, is permanent (in-flight binary
 *     packets encode it positionally). Uniqueness is asserted at module load.
 * Phase 4 appends the `'structure'` row with `poseCoreKind = 2`.
 *
 * Zone-pure (src/core). Descriptors are frozen, shared, per-kind objects — a
 * leaf returns the SAME object every tick, so `syncProfile()` /
 * `renderContribution()` allocate nothing (invariant #14).
 */

import type { EntityKindTag } from './Entity.js';
import type { SyncProfile } from '../contracts/INetworkSynced.js';
import type { RenderContribution } from '../contracts/IRenderContributor.js';

export interface EntityKindDescriptor {
  readonly tag: EntityKindTag;
  /** Whether this kind receives interactions (asteroids/projectiles/missiles
   *  are not IDamageable targets). */
  readonly damageable: boolean;
  readonly sync: SyncProfile;
  readonly render: RenderContribution;
}

/**
 * The seed catalogue. Values for the player/wreck/projectile/missile sync
 * transports are the best-known mapping today; Phase 3 (the EntitySyncRouter)
 * refines a descriptor FIELD where needed — that is allowed (it is not a
 * reorder/removal). Drone/asteroid pose-core assignments are load-bearing and
 * fixed: they match `SWARM_KIND_DRONE = 1` / `SWARM_KIND_ASTEROID = 0`.
 */
const SEED: readonly EntityKindDescriptor[] = [
  {
    tag: 'active-ship',
    damageable: true,
    sync: { transport: 'json-slice', interpolated: false, jsonSliceTag: 'states' },
    render: { bucket: 'ships', preservedFields: ['kind', 'displayName'], interpolated: false },
  },
  {
    tag: 'lingering-hull',
    damageable: true,
    sync: { transport: 'json-slice', interpolated: false, jsonSliceTag: 'states' },
    render: { bucket: 'lingeringShips', preservedFields: ['kind', 'displayName'], interpolated: false },
  },
  {
    tag: 'wreck',
    damageable: true,
    sync: { transport: 'json-slice', interpolated: false, jsonSliceTag: 'wrecks' },
    render: { bucket: 'wrecks', preservedFields: ['kind'], interpolated: false },
  },
  {
    tag: 'drone',
    damageable: true,
    sync: { transport: 'pose-core', poseCoreKind: 1, interpolated: true },
    render: { bucket: 'swarm', preservedFields: ['kind', 'shipKind', 'shieldDown'], interpolated: true },
  },
  {
    tag: 'asteroid',
    damageable: false,
    sync: { transport: 'pose-core', poseCoreKind: 0, interpolated: false },
    render: { bucket: 'swarm', preservedFields: ['kind'], interpolated: false },
  },
  {
    tag: 'projectile',
    damageable: false,
    sync: { transport: 'json-slice', interpolated: false, jsonSliceTag: 'projectiles' },
    render: { bucket: 'projectiles', preservedFields: [], interpolated: false },
  },
  {
    tag: 'missile',
    damageable: false,
    sync: { transport: 'json-slice', interpolated: false, jsonSliceTag: 'missiles' },
    render: { bucket: 'missiles', preservedFields: [], interpolated: false },
  },
  {
    // P4 "structure for free": rides the pose-core binary channel (kind byte 2)
    // — the same generic transport as drones/asteroids — and is damageable
    // through the existing swarm path (server seeds swarmHealth). Static like an
    // asteroid (not interpolated/AI), but takes damage. Appended, never reordered.
    tag: 'structure',
    damageable: true,
    sync: { transport: 'pose-core', poseCoreKind: 2, interpolated: false },
    // `shipKind` preserved (a field refinement, not a reorder): for kind=2 the
    // shared `shipKind` byte carries the STRUCTURE subtype id, which drives the
    // per-subtype silhouette + tint. Must survive the per-frame mirror rebuild.
    render: { bucket: 'swarm', preservedFields: ['kind', 'shipKind'], interpolated: false },
  },
];

const BY_TAG = new Map<EntityKindTag, EntityKindDescriptor>();
const POSE_CORE_KINDS = new Map<number, EntityKindTag>();

for (const d of SEED) {
  if (BY_TAG.has(d.tag)) {
    throw new Error(`EntityKindRegistry: duplicate tag '${d.tag}' (append-only — never register twice)`);
  }
  if (d.sync.transport === 'pose-core') {
    const byte = d.sync.poseCoreKind;
    if (byte === undefined) {
      throw new Error(`EntityKindRegistry: '${d.tag}' is pose-core but has no poseCoreKind byte`);
    }
    const clash = POSE_CORE_KINDS.get(byte);
    if (clash !== undefined) {
      throw new Error(`EntityKindRegistry: pose-core kind byte ${byte} claimed by both '${clash}' and '${d.tag}'`);
    }
    POSE_CORE_KINDS.set(byte, d.tag);
  }
  BY_TAG.set(d.tag, Object.freeze({ ...d }));
}

/** Resolve a kind's descriptor. Throws on an unregistered tag (every tag a
 *  leaf can report MUST be registered — that is the point of the catalogue). */
export function getEntityKind(tag: EntityKindTag): EntityKindDescriptor {
  const d = BY_TAG.get(tag);
  if (d === undefined) {
    throw new Error(`EntityKindRegistry: unregistered entity kind '${tag}'`);
  }
  return d;
}

/** Iterate all registered kind descriptors in seed (append) order. */
export function entityKinds(): IterableIterator<EntityKindDescriptor> {
  return BY_TAG.values();
}

/** Reverse lookup: which kind owns a pose-core byte, or undefined. */
export function entityKindByPoseCore(byte: number): EntityKindTag | undefined {
  return POSE_CORE_KINDS.get(byte);
}

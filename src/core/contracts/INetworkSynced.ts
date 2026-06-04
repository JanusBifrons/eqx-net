/**
 * INetworkSynced — declares HOW an entity reaches clients. The routing key
 * for the Generic Entity Pipeline's send-side collapse (Phase 3).
 *
 * The wire stays three separate channels (never blended — see the root
 * CLAUDE.md Event-Bus architecture):
 *   - `pose-core`  — the homogeneous 33-byte binary swarm record
 *     (`src/shared-types/swarmWireFormat.ts`, v3). Fast BECAUSE it is
 *     branch-free + fixed-stride. A new pose-core-fitting type rides it via a
 *     new `kind` BYTE value (asteroid=0, drone=1, structure=2 …) with NO
 *     stride change and NO `SWARM_WIRE_VERSION` bump — the byte already
 *     extends. Adding a new *continuous* field is the lone exception that
 *     forces a deliberate v4 bump (an explicit user decision, never silent).
 *   - `json-slice` — a named slim array on `SnapshotMessage` (the existing
 *     `drones[]` / `wrecks[]` slices). Carries capability extras that don't
 *     belong in the hot binary record.
 *   - `discrete`   — one-off event broadcasts (spawn/destroy/shield).
 *
 * Phase 1 defines the shape; Phase 3 adds the `EntitySyncRouter` that reads
 * `syncProfile()` and routes each entity to the matching encoder. Zone-pure.
 */

export type SyncTransport = 'pose-core' | 'json-slice' | 'discrete' | 'none';

/**
 * Static per-entity sync descriptor. Returned by value but expected to be a
 * stable, shared, per-kind object (one frozen descriptor per kind, NOT a
 * fresh object per entity per tick) so reading it allocates nothing.
 */
export interface SyncProfile {
  readonly transport: SyncTransport;
  /** Pose-core `kind` byte — required iff transport === 'pose-core'. */
  readonly poseCoreKind?: number;
  /** True if the client display-interpolates this entity's pose (drone), false
   *  for static/teleporting kinds (asteroid, structure). */
  readonly interpolated: boolean;
  /** Named `SnapshotMessage` slice this entity writes into — required iff
   *  transport === 'json-slice' (e.g. 'drones', 'wrecks'). */
  readonly jsonSliceTag?: string;
}

export interface INetworkSynced {
  /** The (stable, per-kind) routing descriptor for this entity. */
  syncProfile(): SyncProfile;
  /** Optional: write this entity's capability extras into the json-slice
   *  output object. Only called when `syncProfile().transport === 'json-slice'`. */
  writeJsonSlice?(out: Record<string, unknown>): void;
}

/**
 * The build preview's pooled stand-in for a stored link (moved out of
 * `ConnectorRenderer.ts`, god-file cap).
 */
import { CABLE_NO_SOCKET } from '../../../core/structures/cableCurve.js';

/** A pooled, mutable stand-in for a {@link Connection} used ONLY by the placement
 *  preview's `canConnect`/`shieldPylonRejection` calls (which read `getOtherNode`,
 *  `socketAt` + the array `.length`). Reused across frames so the per-frame pass
 *  allocates nothing (#14); cast to `Connection` at the adjacency boundary. */
export interface PreviewConn {
  aId: string;
  bId: string;
  /** Cable sockets at `aId` / `bId` (`connSockSelf` / `connSockOther`): the
   *  crossing test (`cableCrossesExisting`) flattens the stored cable. */
  socketA: number;
  socketB: number;
  getOtherNode(id: string): string | null;
  socketAt(id: string): number;
}

/** Allocate one pooled preview-connection (the only `new` for the pool, paid once
 *  as the pool grows; rewritten in place thereafter). */
export function makePreviewConn(): PreviewConn {
  return {
    aId: '',
    bId: '',
    socketA: CABLE_NO_SOCKET,
    socketB: CABLE_NO_SOCKET,
    getOtherNode(id: string): string | null {
      return id === this.aId ? this.bId : id === this.bId ? this.aId : null;
    },
    socketAt(id: string): number {
      return id === this.aId ? this.socketA : id === this.bId ? this.socketB : CABLE_NO_SOCKET;
    },
  };
}

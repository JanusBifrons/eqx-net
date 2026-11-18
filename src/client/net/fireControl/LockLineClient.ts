/**
 * The fire-control lock line: the alloc-free line pick over the mirror (shared
 * `lockLineScore` via `LockLinePick`, #14/#15), cached lock keys, and the
 * deduped `lock_track` send. Owned by `FireControlClient`.
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror, ShipRenderState, SwarmRenderState } from '@core/contracts/IRenderer';
import { isOwnedByMe } from '../../render/shipOwnership.js';
import { useUIStore } from '../../state/store';
import { encodeAim } from '@core/combat/manualAim';
import { isContactLockKind, isTerrainLockKind } from '@core/combat/lockState';
import { LockLinePick } from '../lockLinePick';
import { getShipKind } from '@shared-types/shipKinds';

export class LockLineClient {
  constructor(private readonly mirror: RenderMirror, private readonly roomOf: () => Room | null) {}

  private get room(): Room | null { return this.roomOf(); }

  /** Best lockable target on the line from (x, y) along `bearing` within `reach`. */
  pick(localId: string, x: number, y: number, bearing: number, reach: number, held: string | null): string | null {
    this._lgLocalId = localId;
    this._lgPick.begin(x, y, bearing, reach, held);
    this.mirror.swarm?.forEach(this._lgVisitSwarm);
    this.mirror.ships.forEach(this._lgVisitShip);
    return this._lgPick.result(); // terrain only with no contact on the line
  }

  /** Lock-line pick scratch (one pick at a time; reused, #14). */
  private _lgLocalId: string | null = null;
  private readonly _lgPick = new LockLinePick();
  /** Lock keys (`s:<entityId>` / `p:<ship mirror key>`), built once per id. */
  private readonly _swarmLockKeys = new Map<number, string>();
  private readonly _shipLockKeys = new Map<string, string>();

  /** `s:<entityId>`, cached (no template literal per candidate). */
  private swarmLockKey(entityId: number): string {
    let k = this._swarmLockKeys.get(entityId);
    if (k === undefined) {
      if (this._swarmLockKeys.size > 2048) this._swarmLockKeys.clear();
      k = `s:${entityId}`;
      this._swarmLockKeys.set(entityId, k);
    }
    return k;
  }

  /** `p:<mirror key>` (playerId, or a parked hull's shipInstanceId), cached. */
  shipLockKey(playerId: string): string {
    let k = this._shipLockKeys.get(playerId);
    if (k === undefined) {
      if (this._shipLockKeys.size > 512) this._shipLockKeys.clear();
      k = `p:${playerId}`;
      this._shipLockKeys.set(playerId, k);
    }
    return k;
  }

  /** Drones + structures (not your own) on the lock line; neutral terrain
   *  (shared `isTerrainLockKind`, the server's `resolveLockTarget` rule, #15)
   *  in its own lowest-priority tier. Bound once. */
  private readonly _lgVisitSwarm = (e: SwarmRenderState, entityId: number): void => {
    const terrain = isTerrainLockKind(e.kind);
    if (!terrain && !isContactLockKind(e.kind)) return;
    if (e.kind === 2 && this.mirror.structures?.get(entityId)?.owner === this._lgLocalId) return;
    this._lgPick.consider(this.swarmLockKey(entityId), e.x, e.y, e.radius ?? 20, terrain);
  };

  /** Other players' ships on the lock line, flown by a pilot or an AI pilot
   *  (every class in the one ship list; the key is the mirror key, which the
   *  server's `resolveLockTarget` resolves for both, #15). Never a ship the
   *  local player owns (the ship they fly or their own fleet). Bound once. */
  private readonly _lgVisitShip = (s: ShipRenderState, key: string): void => {
    if (isOwnedByMe(this.mirror, key, s)) return;
    this._lgPick.consider(this.shipLockKey(key), s.x, s.y, getShipKind(s.kind ?? null).radius, false);
  };

  /** Last `lock_track` sent: group + target (dedup — the line moves at frame rate). */
  private _trackGroup: string | null = null;
  _trackKey: string | null = null;
  /**
   * Tell the server what the line holds. A held target carries `b`, the
   * line's quantised world bearing: the server re-checks the target is on
   * that line with the shared `lockLineHolds` (#15) and ignores a claim
   * without it. Dedup on group + key: the server checks only when the claim
   * changes, so an unchanged key needs no resend.
   */
  trackLock(key: string | null, bearing: number): void {
    if (!this.room) return;
    const group = useUIStore.getState().activeGroupId;
    if (group === null) return;
    if (group !== this._trackGroup && this._trackGroup !== null && this._trackKey !== null) {
      // Switched group mid-hold: let the old group's line go.
      this.room.send('lock_track', { type: 'lock_track', groupId: this._trackGroup, target: null });
    }
    if (group === this._trackGroup && key === this._trackKey) return;
    this._trackGroup = group;
    this._trackKey = key;
    this.room.send('lock_track', key === null || Number.isNaN(bearing)
      ? { type: 'lock_track', groupId: group, target: null }
      : { type: 'lock_track', groupId: group, target: key, b: encodeAim(bearing) });
  }
}

/**
 * Mine Layer — room-state `mines` (join payload + patches) into
 * `mirror.mines`, in place. Built once by `ColyseusClient`; `syncStructures`
 * calls `sync()` each snapshot. The decode callback is bound once (#14).
 */
import type { RenderMirror } from '@core/contracts/IRenderer';

export class MineSync {
  /** Mine Layer — sync generation for the mines sweep. */
  private _mineGen = 0;
  constructor(
    private readonly mirror: RenderMirror,
    /** The interned structure owner table (index → player id), shared with `syncStructures`. */
    private readonly _structureOwners: { readonly ids: string[] },
    private readonly room: () => { readonly state?: unknown } | null,
  ) {}
  private readonly _decodeMine = (v: { ownerIdx?: number; x?: number; y?: number }, k: string): void => {
    const map = this.mirror.mines!;
    let row = map.get(k);
    if (!row) {
      row = { x: 0, y: 0, own: false, gen: 0 };
      map.set(k, row);
    }
    row.x = v.x ?? 0;
    row.y = v.y ?? 0;
    row.own = this._structureOwners.ids[v.ownerIdx ?? 0] === this.mirror.localPlayerId;
    row.gen = this._mineGen;
  };

  /** Mine Layer — mirror room-state `mines` (join payload + patches) into
   *  `mirror.mines` in place; a mine gone from room state is gone. */
  sync(): void {
    const rows = (this.room()?.state as { mines?: { size: number; forEach(cb: (v: { ownerIdx?: number; x?: number; y?: number }, k: string) => void): void } } | undefined)?.mines;
    let map = this.mirror.mines;
    if (!rows || rows.size === 0) {
      if (map && map.size > 0) map.clear();
      return;
    }
    if (!map) {
      map = new Map();
      this.mirror.mines = map;
    }
    this._mineGen++;
    rows.forEach(this._decodeMine);
    for (const [id, row] of map) if (row.gen !== this._mineGen) map.delete(id);
  }
}

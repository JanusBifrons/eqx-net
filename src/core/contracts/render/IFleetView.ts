/** RTS / fleet overlays: order mode, squad overlay, map picks, selection. Part of `IRenderer`. */
export interface IFleetView {
  /**
   * RTS command view (slice 12): what a TOUCH tap with a fleet selection
   * orders — 'move' to the tap point, or 'attack' the entity under it. The
   * fleet strip's discrete toggle, pushed on change (worker
   * `SET_FLEET_ORDER_MODE`). Mouse orders stay on right-click.
   */
  setFleetOrderMode(mode: 'move' | 'attack'): void;
  /**
   * RTS command view (slice 15a): squads + order markers of the local
   * player's own ships, built on the main thread from `fleet/fleetStatus.ts`
   * and pushed only when its version moves (worker `SET_FLEET_OVERLAY_MODEL`).
   * The renderer expands selections to whole squads and draws order lines
   * for the SELECTED ships from it. Plain data, structured-cloneable.
   */
  setFleetOverlayModel(model: FleetOverlayModel): void;
  /**
   * RTS slice 14b: start picking a mode's target on the map (patrol route,
   * ship to escort, retreat point), or cancel with null. While picking, a
   * map tap goes to the pick instead of the selection (worker
   * `SET_FLEET_PICK`). Points are dropped on every call.
   */
  setFleetPick(kind: FleetPickKindWire | null): void;
  /** RTS slice 14b: Done for a patrol pick (worker `COMMIT_FLEET_PICK`).
   *  Publishes the route via feedback when it has enough points. */
  commitFleetPick(): void;
  /**
   * RTS fleet warp (S8) — make these own ships THE selection (the one the
   * renderer owns; the focus is cleared). Ids not present as own ships in the
   * mirror are skipped. Used once when a commander arrives with the fleet
   * they warped: the same shipInstanceIds, re-selected in the new sector.
   */
  selectFleetShips(ids: readonly string[]): void;
}

/** One own ship's squad + order, as the renderer needs it (RTS slice 15a). */
export interface FleetOverlayShip {
  id: string;
  squadId: string | null;
  orderKind: 'move' | 'attack' | 'stop' | null;
  /** Move destination, game space. */
  destX?: number;
  destY?: number;
  /** Attack target (pick-id convention: playerId / shipInstanceId / `swarm-<n>`). */
  targetId?: string;
  /** Ship being escorted (same id convention). */
  escortId?: string;
  /** Patrol route waypoints, game space (a closed loop). */
  route?: [number, number][];
}

/** RTS slice 14b: what a map pick is for. */
export type FleetPickKindWire = 'patrol' | 'escort' | 'retreat';

/** RTS slice 14b: a finished map pick (game space). Plain data. */
export type FleetPickResultWire =
  | { kind: 'patrol'; route: [number, number][] }
  | { kind: 'escort'; escortId: string }
  | { kind: 'retreat'; x?: number; y?: number };

/** See `IRenderer.setFleetOverlayModel`. */
export interface FleetOverlayModel {
  ships: FleetOverlayShip[];
}

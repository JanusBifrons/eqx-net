import type { Connection, FlowMaterial } from '../../core/structures/Connection.js';

/**
 * Flash every connection along `route` with `material` and record each lit
 * pair in `flashed` (`StructureGridSubsystem` pulse; moved out of it for the
 * god-file cap).
 */
export function flashRouteConnections(
  route: readonly string[],
  nowMs: number,
  flashed: Array<[string, string, FlowMaterial]>,
  material: FlowMaterial,
  findConnection: (aId: string, bId: string) => Connection | null,
  reversed = false,
): void {
  // Each flashed pair is [source, dest]: the client draws the flow from its
  // first id. `reversed` flashes a route found Capital→X for flow X→Capital.
  const last = route.length - 1;
  for (let i = 0; i < last; i++) {
    const a = reversed ? route[last - i]! : route[i]!;
    const b = reversed ? route[last - i - 1]! : route[i + 1]!;
    const conn = findConnection(a, b);
    if (conn) {
      conn.flash(nowMs, material);
      flashed.push([a, b, material]);
    }
  }
}

/**
 * Server → client helm route replies (navigation slice 12): `nav_route`
 * answers this client's `nav_route_request`. The helm route client owns the
 * state (`helm/helmRoute.ts`); this only forwards.
 */
import type { Room } from 'colyseus.js';

/** What the helm handlers touch: the one route-reply sink. */
export interface HelmHandlerCtx {
  readonly onNavRoute: (raw: unknown) => void;
}

export function registerHelmHandlers(room: Room, ctx: HelmHandlerCtx): void {
  const onNavRoute = ctx.onNavRoute;
  room.onMessage('nav_route', (raw: unknown) => onNavRoute(raw));
}

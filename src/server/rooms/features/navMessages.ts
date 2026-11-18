/**
 * Navigation slice 12 — autopilot route requests: a player's helm asks for a
 * way to its course point; the room's nav answers that player's own hull.
 */
import type { RoomNav } from '../../nav/RoomNav.js';
import { parsedMessage, type ParsedMessageHost, type RoomFeature } from './parsedMessage.js';
import { NavRouteRequestSchema } from '../../../shared-types/messages/navMessages.js';

/** What the handler needs from the room: its nav. */
export interface NavMessageHost extends ParsedMessageHost {
  nav: Pick<RoomNav, 'onRequest'>;
}

export function registerNavMessages(h: NavMessageHost): RoomFeature {
  parsedMessage(h, 'nav_route_request', NavRouteRequestSchema, (msg, client) => h.nav.onRequest(client, msg));
  return {};
}

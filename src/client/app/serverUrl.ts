/**
 * Resolution of the server's WebSocket / HTTP base URL.
 *
 * Default: the page's own origin, so the same dev server is reachable
 * from phones on the LAN (e.g. http://192.168.1.5:5173 →
 * ws://192.168.1.5:5173). Override with VITE_WS_URL in .env for
 * cross-origin setups.
 */
export const SERVER_URL: string =
  (import.meta.env['VITE_WS_URL'] as string | undefined) ??
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173');

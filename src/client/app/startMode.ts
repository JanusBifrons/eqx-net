/**
 * RTS command layer (slice 10) — which `startMode` a join sends.
 *
 * Owner decision 2026-11-14: normal galaxy play lands in COMMAND view (free
 * camera over your fleet, your ships AI-flown); you take the controls when you
 * want to. So a join into a real galaxy sector sends `startMode: 'command'`.
 * Everything else keeps flying: engineering / test rooms (`?room=test-sector`
 * etc.) and the bot-free `galaxy-test` room, so the e2e suite that joins them
 * directly is unchanged, and a server-reserved transit arrival (it never goes
 * through here and the server treats an absent `startMode` as `fly`).
 *
 * Precedence: an explicit join-option override (e.g. "pilot that ship" from the
 * galaxy map sends `fly`) → the `?startMode=` URL param (e2e helpers pass
 * `fly`) → the room default above. Returns `undefined` for a spectator join
 * (the server short-circuits it; no ship to park).
 */
import type { StartMode } from '@shared-types/messages';

/** The room a client joins by default when nothing else says otherwise. */
export function defaultStartModeForRoom(roomName: string): StartMode {
  return roomName.startsWith('galaxy-') && roomName !== 'galaxy-test' ? 'command' : 'fly';
}

function asStartMode(v: unknown): StartMode | null {
  return v === 'command' || v === 'fly' ? v : null;
}

export function resolveStartMode(
  roomName: string,
  urlParam: string | null,
  override: Record<string, unknown> | undefined,
): StartMode | undefined {
  if (override?.['spectator'] === true) return undefined;
  return asStartMode(override?.['startMode'])
    ?? asStartMode(urlParam)
    ?? defaultStartModeForRoom(roomName);
}

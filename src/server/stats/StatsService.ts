import { persistence } from '../db/PersistenceWorker.js';

export function recordLoginEvent(
  email: string,
  userId: string | null,
  success: boolean,
  provider: 'local' | 'google',
  ip: string | null,
): void {
  persistence.enqueueCritical({
    type: 'LOGIN_EVENT',
    email,
    userId,
    success,
    provider,
    ip,
    ts: Date.now(),
  });
}

export function recordGameJoin(
  userId: string | null,
  playId: string,
  sectorId: string,
): void {
  persistence.enqueueCritical({
    type: 'GAME_JOIN',
    userId,
    playId,
    sectorId,
    ts: Date.now(),
  });
}

export function recordGameLeave(playId: string): void {
  persistence.enqueueCritical({ type: 'GAME_LEAVE', playId, ts: Date.now() });
}

export function recordKill(
  killerUserId: string | null,
  victimUserId: string | null,
  weapon: string,
  sectorId: string,
): void {
  persistence.enqueueCritical({
    type: 'KILL',
    killerUserId,
    victimUserId,
    weapon,
    sectorId,
    ts: Date.now(),
  });
}

export function saveSnapshot(sectorId: string, state: object): void {
  persistence.enqueueCritical({
    type: 'SNAPSHOT',
    sectorId,
    payloadJson: JSON.stringify(state),
    ts: Date.now(),
  });
}

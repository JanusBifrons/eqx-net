import { db } from '../db/Database.js';

export function recordLoginEvent(
  email: string,
  userId: string | null,
  success: boolean,
  provider: 'local' | 'google',
  ip: string | null,
): void {
  db.prepare(
    'INSERT INTO login_events (email, user_id, success, provider, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(email, userId, success ? 1 : 0, provider, ip, Date.now());
}

export function recordGameJoin(
  userId: string | null,
  playId: string,
  sectorId: string,
): number {
  const result = db
    .prepare(
      'INSERT INTO game_sessions (user_id, play_id, sector_id, joined_at) VALUES (?, ?, ?, ?)',
    )
    .run(userId, playId, sectorId, Date.now()) as { lastInsertRowid: number };
  return result.lastInsertRowid;
}

export function recordGameLeave(sessionRowId: number): void {
  db.prepare('UPDATE game_sessions SET left_at = ? WHERE id = ?').run(Date.now(), sessionRowId);
}

export function recordKill(
  killerUserId: string | null,
  victimUserId: string | null,
  weapon: string,
  sectorId: string,
): void {
  db.prepare(
    'INSERT INTO player_kills (killer_user_id, victim_user_id, weapon, sector_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(killerUserId, victimUserId, weapon, sectorId, Date.now());
}

export function saveSnapshot(sectorId: string, state: object): void {
  db.prepare(
    'INSERT INTO game_snapshots (sector_id, snapshot, created_at) VALUES (?, ?, ?)',
  ).run(sectorId, JSON.stringify(state), Date.now());
}

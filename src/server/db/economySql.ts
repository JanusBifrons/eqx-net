/**
 * Living World P2 — economy SQL shared by BOTH writers (the production
 * `dbWorker` and the test `SyncSinkAdapter`) so they can never drift (#15).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PersistOp } from '../../core/contracts/IPersistenceSink.js';

export const ECON_PLAYER_PUT_SQL =
  'INSERT INTO player_economy (player_id, payload_json, updated_at) VALUES (?, ?, ?) ' +
  'ON CONFLICT(player_id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at';
export const TRADE_DEAL_PUT_SQL =
  'INSERT INTO trade_deals (deal_id, owner_id, payload_json, updated_at) VALUES (?, ?, ?, ?) ' +
  'ON CONFLICT(deal_id) DO UPDATE SET owner_id=excluded.owner_id, payload_json=excluded.payload_json, updated_at=excluded.updated_at';
export const TRADE_DEAL_DELETE_SQL = 'DELETE FROM trade_deals WHERE deal_id = ?';
export const ECON_STATE_PUT_SQL =
  'INSERT INTO economy_state (key, payload_json, updated_at) VALUES (?, ?, ?) ' +
  'ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at';

type Stmt = ReturnType<DatabaseSync['prepare']>;

export interface EconomyStatements {
  ECON_PLAYER_PUT: Stmt;
  TRADE_DEAL_PUT: Stmt;
  TRADE_DEAL_DELETE: Stmt;
  ECON_STATE_PUT: Stmt;
}

export function prepareEconomyStatements(db: DatabaseSync): EconomyStatements {
  return {
    ECON_PLAYER_PUT: db.prepare(ECON_PLAYER_PUT_SQL),
    TRADE_DEAL_PUT: db.prepare(TRADE_DEAL_PUT_SQL),
    TRADE_DEAL_DELETE: db.prepare(TRADE_DEAL_DELETE_SQL),
    ECON_STATE_PUT: db.prepare(ECON_STATE_PUT_SQL),
  };
}

/** Apply an economy op; returns false when `op` is not an economy op. */
export function applyEconomyOp(s: EconomyStatements, op: PersistOp): boolean {
  switch (op.type) {
    case 'ECON_PLAYER_PUT':
      s.ECON_PLAYER_PUT.run(op.playerId, op.payloadJson, op.ts);
      return true;
    case 'TRADE_DEAL_PUT':
      s.TRADE_DEAL_PUT.run(op.dealId, op.ownerId, op.payloadJson, op.ts);
      return true;
    case 'TRADE_DEAL_DELETE':
      s.TRADE_DEAL_DELETE.run(op.dealId);
      return true;
    case 'ECON_STATE_PUT':
      s.ECON_STATE_PUT.run(op.key, op.payloadJson, op.ts);
      return true;
    default:
      return false;
  }
}

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { SCHEMA_SQL } from './schema.js';

const dbPath = process.env['DB_PATH'] ?? path.resolve(process.cwd(), 'eqx.db');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA foreign_keys=ON');
db.exec(SCHEMA_SQL);

export { db };

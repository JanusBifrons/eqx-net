import { randomUUID } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUUID(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

export function assignPlayerId(requested: unknown): string {
  return isValidUUID(requested) ? requested : randomUUID();
}

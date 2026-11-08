/**
 * Shield contacts from collisions (user report 2026-11-07: "the shield should
 * show on collisions when it's raised, same as on shots hitting the
 * shields"). `collision_resolved` names each side as the client knows it
 * (`eA`/`eB`: -1 = a pilot, its id is the playerId; >= 0 = a swarm entity);
 * each named side gets a contact facing the other body. The renderer draws it
 * only on a raised shield, like a shot's hit.
 */

export interface ShieldContactTrigger {
  kind: 'shield-contact';
  entityId: string;
  /** The other body's position (game space): the contact faces it. */
  worldX: number;
  worldY: number;
}

interface Pos { x: number; y: number }
interface MirrorView {
  ships: ReadonlyMap<string, Pos>;
  swarm?: ReadonlyMap<number, Pos>;
}
interface CollisionIds { aId: string; bId: string; eA?: number; eB?: number }

/** Grinding contacts arrive every tick: one shield contact per shield per this. */
export const SHIELD_CONTACT_MIN_MS = 150;

const swarmKeys = new Map<number, string>();
function keyFor(code: number, id: string): string {
  if (code < 0) return id;
  let k = swarmKeys.get(code);
  if (k === undefined) { k = `swarm-${code}`; swarmKeys.set(code, k); } // once per entity id
  return k;
}
function posOf(code: number, id: string, m: MirrorView): Pos | undefined {
  return code < 0 ? m.ships.get(id) : m.swarm?.get(code);
}

export function pushCollisionShieldContacts(
  msg: CollisionIds, mirror: MirrorView, nowMs: number, last: Map<string, number>, out: { push(t: ShieldContactTrigger): unknown },
): void {
  if (msg.eA === undefined || msg.eB === undefined) return;
  const pa = posOf(msg.eA, msg.aId, mirror), pb = posOf(msg.eB, msg.bId, mirror);
  if (!pa || !pb) return;
  side(keyFor(msg.eA, msg.aId), pb, nowMs, last, out);
  side(keyFor(msg.eB, msg.bId), pa, nowMs, last, out);
}

function side(key: string, other: Pos, nowMs: number, last: Map<string, number>, out: { push(t: ShieldContactTrigger): unknown }): void {
  const t = last.get(key);
  if (t !== undefined && nowMs - t < SHIELD_CONTACT_MIN_MS) return;
  last.set(key, nowMs);
  // TODO: alloc-debt (one trigger per throttled shield contact, <= ~7/s per shield)
  out.push({ kind: 'shield-contact', entityId: key, worldX: other.x, worldY: other.y });
}

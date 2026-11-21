/**
 * `set_shields` — a pilot drops or raises their OWN ship's shields (owner ask,
 * playtest 2026-11-21: tap your shield ring on the HUD). Real ShieldHullRouter,
 * fake room host. Lowering goes through the same break path a hit takes
 * (shield 0 ⇒ the ship's shieldDown flag, hull-exposed collider, 0-damage
 * state-carrier event) and holds regen; raising releases the hold and regen
 * follows the normal delay.
 */
import { describe, expect, it } from 'vitest';
import type { Client } from 'colyseus';
import type { MapSchema } from '@colyseus/schema';
import { registerShieldMessages, type ShieldMessageHost } from './shieldMessages.js';
import { ShieldHullRouter } from '../ShieldHullRouter.js';
import type { ShipState } from '../schema/SectorState.js';
import { Bus } from '../../../core/events/Bus.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import type { WorkerCmd } from '../PhysicsWorkerProxy.js';

/** The ShipState fields the shield path reads (the schema class needs the
 *  Colyseus decorator runtime, so unit tests use a plain shape). */
function ship(playerId: string): ShipState {
  const kind = 'fighter';
  return {
    playerId, shipInstanceId: `ship-${playerId}`, kind, alive: true, isActive: true,
    shield: getShipKind(kind).shieldMax, shieldLastDamageTick: 0, shieldsLowered: false,
    health: 100, maxHealth: 100, statAlloc: {},
  } as unknown as ShipState;
}

function setup() {
  let tick = 1000;
  const ships = new Map<string, ShipState>();
  const p1 = ship('p1');
  const p2 = ship('p2');
  ships.set('p1', p1);
  ships.set('p2', p2);
  const posted: WorkerCmd[] = [];
  const sent: Array<{ type: string; msg: { targetId: string; newShield?: number; damage?: number; phase?: string } }> = [];
  const bus = new Bus();
  const broke: string[] = [];
  bus.on('SHIELD_BROKEN', (e) => broke.push(e.entityId));
  const router = new ShieldHullRouter({
    serverTick: () => tick,
    shipsMap: ships as unknown as MapSchema<ShipState>,
    swarmRegistry: { get: () => null },
    bus,
    serverLogEvent: () => {},
    postToWorker: (cmd) => posted.push(cmd),
    broadcast: (type, msg) => sent.push({ type, msg }),
  });
  const handlers = new Map<string, (client: Client, raw: unknown) => void>();
  let malformed = 0;
  const host: ShieldMessageHost = {
    onMessage: (type, fn) => { handlers.set(type, fn); },
    malformed: { record: () => { malformed++; } },
    sessionToPlayer: () => new Map([['sess-1', 'p1'], ['sess-2', 'p2']]),
    getActiveShip: (pid) => ships.get(pid),
    shieldHull: () => router,
  };
  registerShieldMessages(host);
  const send = (sessionId: string, raw: unknown): void => handlers.get('set_shields')!({ sessionId } as Client, raw);
  const delay = getShipKind(p1.kind).shieldRegenDelayTicks;
  return {
    p1, p2, router, posted, sent, broke, send, delay,
    malformed: () => malformed,
    setTick: (t: number) => { tick = t; },
    tick: () => tick,
  };
}

describe('set_shields — drop / raise your own shields', () => {
  it('lowering drops the shield to 0 (shieldDown), exposes the hull and holds regen', () => {
    const t = setup();
    t.send('sess-1', { type: 'set_shields', up: false });
    expect(t.p1.shield).toBe(0); // the ship's shieldDown flag is `shield <= 0`
    expect(t.p1.shieldsLowered).toBe(true);
    expect(t.broke).toEqual(['ship-p1']);
    expect(t.posted).toContainEqual(expect.objectContaining({ type: 'SET_HULL_EXPOSED', id: 'p1', exposed: true }));
    // Every client learns the 0-cross from the existing 0-damage state carrier.
    expect(t.sent).toContainEqual({ type: 'damage', msg: expect.objectContaining({ targetId: 'p1', damage: 0, newShield: 0 }) });
    // No regen while lowered, however long we wait.
    t.setTick(t.tick() + t.delay * 10);
    for (let i = 0; i < 5; i++) t.router.tickShieldRegen();
    expect(t.p1.shield).toBe(0);
  });

  it('raising resumes regen once the normal regen delay has passed', () => {
    const t = setup();
    t.send('sess-1', { type: 'set_shields', up: false });
    const loweredAt = t.tick();
    t.setTick(loweredAt + t.delay * 2);
    t.router.tickShieldRegen();
    expect(t.p1.shield).toBe(0);
    t.send('sess-1', { type: 'set_shields', up: true });
    expect(t.p1.shieldsLowered).toBe(false);
    t.router.tickShieldRegen();
    expect(t.p1.shield).toBeGreaterThan(0);
    expect(t.sent).toContainEqual({ type: 'shield', msg: expect.objectContaining({ targetId: 'p1', phase: 'restored' }) });
  });

  it('raising cannot skip the recovery delay after a break', () => {
    const t = setup();
    t.router.damageShipLayered(t.p1, 10_000, 'p1'); // shield broken at this tick
    const brokeAt = t.tick();
    t.send('sess-1', { type: 'set_shields', up: false });
    t.setTick(brokeAt + 1);
    t.send('sess-1', { type: 'set_shields', up: true });
    t.router.tickShieldRegen();
    expect(t.p1.shield).toBe(0); // still inside the regen delay
    t.setTick(brokeAt + t.delay);
    t.router.tickShieldRegen();
    expect(t.p1.shield).toBeGreaterThan(0);
  });

  it('a message changes only the sender\'s own ship', () => {
    const t = setup();
    const full = t.p1.shield;
    t.send('sess-2', { type: 'set_shields', up: false });
    expect(t.p2.shield).toBe(0);
    expect(t.p1.shield).toBe(full);
    expect(t.p1.shieldsLowered).toBe(false);
    // There is no target field: naming another ship is a malformed message.
    t.send('sess-2', { type: 'set_shields', up: false, shipId: 'ship-p1' });
    expect(t.malformed()).toBe(1);
    expect(t.p1.shield).toBe(full);
    // An unknown session does nothing.
    t.send('sess-x', { type: 'set_shields', up: false });
    expect(t.p1.shield).toBe(full);
  });

  it('lowering twice is a no-op (one break, one event)', () => {
    const t = setup();
    t.send('sess-1', { type: 'set_shields', up: false });
    t.send('sess-1', { type: 'set_shields', up: false });
    expect(t.broke).toEqual(['ship-p1']);
    expect(t.sent.filter((s) => s.type === 'damage')).toHaveLength(1);
  });
});

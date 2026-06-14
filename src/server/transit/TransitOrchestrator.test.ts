import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TransitOrchestrator, type TransitHostRoom } from './TransitOrchestrator.js';
import { PlayerShipStore } from '../playerShips/PlayerShipStore.js';
import { Bus } from '../../core/events/Bus.js';
import {
  SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_ANGVEL_OFF,
  SAB_TOTAL_BYTES, slotBase,
} from '../../shared-types/sabLayout.js';
import { SPOOL_DURATION_MS } from '../../core/transit/TransitStateMachine.js';

interface FakeClientSent {
  channel: string;
  msg: unknown;
}

function makeFakeClient(): { client: { send: (channel: string, msg: unknown) => void }; sent: FakeClientSent[] } {
  const sent: FakeClientSent[] = [];
  return {
    client: { send: (channel, msg) => { sent.push({ channel, msg }); } },
    sent,
  };
}

interface BroadcastCall { type: string; message: unknown; except: unknown }

function makeRoom(opts: { sectorKey: string | null; playerId: string }): {
  room: TransitHostRoom;
  sent: FakeClientSent[];
  broadcasts: BroadcastCall[];
  setHealth: (h: number) => void;
  setSlotPose: (slot: number, pose: { x: number; y: number; vx: number; vy: number; angle: number; angvel: number }) => void;
} {
  const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
  const sabF32 = new Float32Array(sab);
  const playerToSlot = new Map<string, number>();
  const playerToUser = new Map<string, string | null>();
  const playerToActiveShipInstance = new Map<string, string>();
  const lastFireClientTick = new Map<string, number>();
  let health = 100;

  if (opts.sectorKey !== null) {
    playerToSlot.set(opts.playerId, 0);
    playerToUser.set(opts.playerId, 'user-test');
    lastFireClientTick.set(opts.playerId, 999);
  }
  const setSlotPose: ReturnType<typeof makeRoom>['setSlotPose'] = (slot, pose) => {
    const b = slotBase(slot);
    sabF32[b + SLOT_X_OFF] = pose.x;
    sabF32[b + SLOT_Y_OFF] = pose.y;
    sabF32[b + SLOT_VX_OFF] = pose.vx;
    sabF32[b + SLOT_VY_OFF] = pose.vy;
    sabF32[b + SLOT_ANGLE_OFF] = pose.angle;
    sabF32[b + SLOT_ANGVEL_OFF] = pose.angvel;
  };
  setSlotPose(0, { x: 100, y: 200, vx: 1, vy: -2, angle: 0.5, angvel: 0.1 });

  const fc = makeFakeClient();
  const playerToTransitInFlight = new Set<string>();
  const broadcasts: BroadcastCall[] = [];
  const room: TransitHostRoom = {
    sectorKey: opts.sectorKey,
    bus: new Bus(),
    sabF32,
    playerToSlot,
    playerToUser,
    playerToActiveShipInstance,
    lastFireClientTick,
    getShipHealth: () => health,
    getShipKind: () => 'fighter',
    playerToTransitInFlight,
    clientForPlayer: () => fc.client as unknown as Parameters<TransitHostRoom['clientForPlayer']>[0] extends never ? never : ReturnType<TransitHostRoom['clientForPlayer']>,
    broadcast: (type, message, options) => {
      broadcasts.push({ type, message, except: options?.except });
    },
  };

  return {
    room,
    sent: fc.sent,
    broadcasts,
    setHealth: (h) => { health = h; },
    setSlotPose,
  };
}

describe('TransitOrchestrator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe('beginTransit validation', () => {
    it('rejects when source room has no sectorKey', () => {
      const { room, sent } = makeRoom({ sectorKey: null, playerId: 'p1' });
      const orch = new TransitOrchestrator(room);
      const ok = orch.beginTransit('p1', 'cygnus-arm');
      expect(ok).toBe(false);
      expect(sent).toHaveLength(1);
      const msg = sent[0]!.msg as { state: string; reason?: string };
      expect(msg.state).toBe('DOCKED');
      expect(msg.reason).toBe('manual');
    });

    it('rejects when target is not a neighbour', () => {
      const { room, sent } = makeRoom({ sectorKey: 'orion-belt', playerId: 'p1' });
      const orch = new TransitOrchestrator(room);
      const ok = orch.beginTransit('p1', 'cygnus-arm');
      expect(ok).toBe(false);
      const msg = sent[0]!.msg as { state: string; reason?: string };
      expect(msg.reason).toBe('not_neighbour');
    });

    it('accepts a valid neighbour and emits SPOOLING', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room);
      const ok = orch.beginTransit('p1', 'cygnus-arm');
      expect(ok).toBe(true);
      expect(orch.isInFlight('p1')).toBe(true);
      const msg = sent[0]!.msg as { state: string; targetSectorKey?: string; spoolMs?: number };
      expect(msg.state).toBe('SPOOLING');
      expect(msg.targetSectorKey).toBe('cygnus-arm');
      expect(msg.spoolMs).toBe(SPOOL_DURATION_MS);
    });

    it('a second beginTransit while in flight is a no-op', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room);
      orch.beginTransit('p1', 'cygnus-arm');
      sent.length = 0;
      const ok = orch.beginTransit('p1', 'vega-reach');
      expect(ok).toBe(false);
      expect(sent).toHaveLength(0);
    });
  });

  describe('vulnerable spool-up: SHIP_DESTROYED aborts', () => {
    it('aborts when SHIP_DESTROYED fires for the spooling player', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room);
      orch.beginTransit('p1', 'cygnus-arm');
      sent.length = 0;
      room.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: 'p1', shooterId: 'enemy' });
      expect(orch.isInFlight('p1')).toBe(false);
      const last = sent.find((s) => (s.msg as { state: string }).state === 'DOCKED');
      expect(last).toBeDefined();
      expect((last!.msg as { reason?: string }).reason).toBe('destroyed');
    });

    it('SHIP_DESTROYED for a different player does not abort', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room);
      orch.beginTransit('p1', 'cygnus-arm');
      sent.length = 0;
      room.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: 'p2', shooterId: 'enemy' });
      expect(orch.isInFlight('p1')).toBe(true);
      expect(sent).toHaveLength(0);
    });
  });

  describe('manual cancel', () => {
    it('cancelTransit during SPOOLING transitions back to DOCKED with reason', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room);
      orch.beginTransit('p1', 'cygnus-arm');
      sent.length = 0;
      orch.cancelTransit('p1', 'manual');
      expect(orch.isInFlight('p1')).toBe(false);
      const msg = sent[0]!.msg as { state: string; reason?: string };
      expect(msg.state).toBe('DOCKED');
      expect(msg.reason).toBe('manual');
    });

    it('cancelTransit on unknown player is a no-op', () => {
      const { room } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room);
      expect(() => orch.cancelTransit('nobody', 'manual')).not.toThrow();
    });
  });

  describe('commit', () => {
    // WS-B (Phase 5): the transit reservation is re-homed onto the ROSTER
    // (markStored at the destination sector) instead of a Limbo entry. The
    // fixture seeds an active roster row for p1 + the playerToActiveShipInstance
    // map so commitTransit can resolve + re-home it.
    function withFakeReserve(fn: ReturnType<typeof vi.fn>): {
      orch: TransitOrchestrator;
      room: ReturnType<typeof makeRoom>['room'];
      store: PlayerShipStore;
      shipId: string;
      sent: FakeClientSent[];
      broadcasts: BroadcastCall[];
      setHealth: (h: number) => void;
    } {
      const r = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const store = new PlayerShipStore({ generateShipId: () => 'ship-p1' });
      const rec = store.create({
        playerId: 'p1', userId: 'user-test', kind: 'fighter',
        sectorKey: 'sol-prime', x: 0, y: 0, health: 100,
      });
      (r.room.playerToActiveShipInstance as Map<string, string>).set('p1', rec.shipId);
      const orch = new TransitOrchestrator(r.room, undefined, store);
      orch.setReserveByNameOverride(fn as unknown as Parameters<TransitOrchestrator['setReserveByNameOverride']>[0]);
      return { orch, room: r.room, store, shipId: rec.shipId, sent: r.sent, broadcasts: r.broadcasts, setHealth: r.setHealth };
    }

    it('re-homes the roster row to the destination sector with the commit pose', async () => {
      const reservation = { sessionId: 'reserved', room: { roomId: 'r' } };
      const reserve = vi.fn().mockResolvedValue(reservation);
      const { orch, room, store, shipId, sent, setHealth } = withFakeReserve(reserve);
      setHealth(42);
      orch.beginTransit('p1', 'cygnus-arm');
      sent.length = 0;
      // Skip ahead to commit.
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      // Allow microtasks (the await chain in commitTransit).
      await vi.runAllTimersAsync();

      // Roster row re-homed to the destination sector with the SAB pose.
      const rec = store.get(shipId)!;
      expect(rec.lastSectorKey).toBe('cygnus-arm');
      expect(rec.lastX).toBe(100);
      expect(rec.lastVx).toBe(1);
      expect(rec.health).toBe(42);
      expect(rec.lastFireClientTick).toBe(999);
      // Stored (not active) during the flight; reclaimable (no TTL enforced).
      expect(rec.isActive).toBe(false);

      // playerToTransitInFlight flag set so onLeave skips its own linger.
      expect(room.playerToTransitInFlight.has('p1')).toBe(true);

      // transit_state IN_TRANSIT + transit_ready both sent.
      const inTransit = sent.find((s) => (s.msg as { state: string }).state === 'IN_TRANSIT');
      expect(inTransit).toBeDefined();
      const ready = sent.find((s) => s.channel === 'transit_ready');
      expect(ready).toBeDefined();
      expect((ready!.msg as { reservation: unknown }).reservation).toBe(reservation);

      // No longer in-flight.
      expect(orch.isInFlight('p1')).toBe(false);
    });

    it('reserves the seat for the destination galaxy room (threading the active shipId)', async () => {
      const reserve = vi.fn().mockResolvedValue({ sessionId: 'r', room: { roomId: 'x' } });
      const { orch } = withFakeReserve(reserve);
      orch.beginTransit('p1', 'cygnus-arm');
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      await vi.runAllTimersAsync();
      expect(reserve).toHaveBeenCalledTimes(1);
      const args = reserve.mock.calls[0]!;
      // First arg is the room name; second is the options bag carrying the
      // resolved active shipId so the destination binds via the shipId path.
      expect(args[0]).toBe('galaxy-cygnus-arm');
      expect(args[1]).toEqual(expect.objectContaining({ playerId: 'p1', shipId: 'ship-p1' }));
    });

    it('falls through to destination_unavailable when reserveSeatFor rejects', async () => {
      const reserve = vi.fn().mockRejectedValue(new Error('full'));
      const { orch, room, store, shipId, sent } = withFakeReserve(reserve);
      orch.beginTransit('p1', 'cygnus-arm');
      sent.length = 0;
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      await vi.runAllTimersAsync();
      // Roster row NOT re-homed (reservation failed before the markStored).
      expect(store.get(shipId)!.lastSectorKey).toBe('sol-prime');
      // playerToTransitInFlight NOT set — onLeave will linger normally.
      expect(room.playerToTransitInFlight.has('p1')).toBe(false);
      // transit_state DOCKED with destination_unavailable.
      const last = sent.find((s) => (s.msg as { state: string }).state === 'DOCKED');
      expect(last).toBeDefined();
      expect((last!.msg as { reason?: string }).reason).toBe('destination_unavailable');
    });

    it('uses client-requested arrival x/y when provided (override SAB pose)', async () => {
      const reserve = vi.fn().mockResolvedValue({ sessionId: 'r', room: { roomId: 'x' } });
      const { orch, store, shipId } = withFakeReserve(reserve);
      // Departure pose was 100/200 (set by makeRoom). Request arrival at 500/-300.
      orch.beginTransit('p1', 'cygnus-arm', { x: 500, y: -300 });
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      await vi.runAllTimersAsync();
      const rec = store.get(shipId)!;
      expect(rec.lastX).toBe(500);
      expect(rec.lastY).toBe(-300);
      // Velocity / angle / angvel are NEVER overridden — only landing position.
      // SAB is Float32Array, so use toBeCloseTo for non-integer round-trips.
      expect(rec.lastVx).toBe(1);
      expect(rec.lastVy).toBe(-2);
      expect(rec.lastAngle).toBe(0.5);
      expect(rec.lastAngvel).toBeCloseTo(0.1, 5);
    });

    it('clamps out-of-bounds arrival to sector half-extent', async () => {
      const reserve = vi.fn().mockResolvedValue({ sessionId: 'r', room: { roomId: 'x' } });
      const { orch, store, shipId } = withFakeReserve(reserve);
      orch.beginTransit('p1', 'cygnus-arm', { x: 999_999, y: -50_000 });
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      await vi.runAllTimersAsync();
      const rec = store.get(shipId)!;
      expect(rec.lastX).toBe(5000);   // SECTOR_PLAYABLE_HALF_EXTENT
      expect(rec.lastY).toBe(-5000);
    });

    it('falls back to SAB pose when no arrival is provided (regression lock)', async () => {
      const reserve = vi.fn().mockResolvedValue({ sessionId: 'r', room: { roomId: 'x' } });
      const { orch, store, shipId } = withFakeReserve(reserve);
      // No third arg — legacy PC behaviour.
      orch.beginTransit('p1', 'cygnus-arm');
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      await vi.runAllTimersAsync();
      const rec = store.get(shipId)!;
      // Departure pose from makeRoom: x=100, y=200.
      expect(rec.lastX).toBe(100);
      expect(rec.lastY).toBe(200);
    });

    it('player vanishing mid-spool (no slot) skips reservation cleanly', async () => {
      const reserve = vi.fn().mockResolvedValue({ sessionId: 'r', room: { roomId: 'x' } });
      const { orch, room, store, shipId } = withFakeReserve(reserve);
      orch.beginTransit('p1', 'cygnus-arm');
      // Simulate disconnect: clear the slot map.
      (room.playerToSlot as Map<string, number>).delete('p1');
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      await vi.runAllTimersAsync();
      expect(reserve).not.toHaveBeenCalled();
      // Roster row untouched (no re-home).
      expect(store.get(shipId)!.lastSectorKey).toBe('sol-prime');
      expect(orch.isInFlight('p1')).toBe(false);
    });

    // Warp visual broadcast — when a player commits transit OUT of this
    // sector, the source room must broadcast `warp_out` to every OTHER
    // client in the room so their renderer fires a one-shot flash +
    // burst ripple at the leaver's last world position.
    it('broadcasts warp_out at the leaver\'s SAB pose, excluding the leaver', async () => {
      const reserve = vi.fn().mockResolvedValue({ sessionId: 'r', room: { roomId: 'x' } });
      const { orch, broadcasts } = withFakeReserve(reserve);
      orch.beginTransit('p1', 'cygnus-arm');
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      await vi.runAllTimersAsync();

      const warpOut = broadcasts.find((b) => b.type === 'warp_out');
      expect(warpOut).toBeDefined();
      const payload = warpOut!.message as { type: string; playerId: string; x: number; y: number };
      expect(payload.type).toBe('warp_out');
      expect(payload.playerId).toBe('p1');
      // SAB pose from setSlotPose default in makeRoom — x:100, y:200.
      expect(payload.x).toBe(100);
      expect(payload.y).toBe(200);
      // Excludes the leaver — `except` is the leaver's client.
      expect(warpOut!.except).toBeDefined();
    });

    it('warp_out broadcast uses the SAB pose at commit moment, not the arrival override', async () => {
      const reserve = vi.fn().mockResolvedValue({ sessionId: 'r', room: { roomId: 'x' } });
      const { orch, broadcasts } = withFakeReserve(reserve);
      // Client requests an arrival at (500, -300) but observers should
      // see the burst at the leaver's CURRENT position (100, 200), not
      // at the destination arrival point.
      orch.beginTransit('p1', 'cygnus-arm', { x: 500, y: -300 });
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      await vi.runAllTimersAsync();
      const warpOut = broadcasts.find((b) => b.type === 'warp_out');
      const payload = warpOut!.message as { x: number; y: number };
      expect(payload.x).toBe(100);
      expect(payload.y).toBe(200);
    });

    it('does NOT broadcast warp_out when reservation fails (no transit committed)', async () => {
      const reserve = vi.fn().mockRejectedValue(new Error('destination unavailable'));
      const { orch, broadcasts } = withFakeReserve(reserve);
      orch.beginTransit('p1', 'cygnus-arm');
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      await vi.runAllTimersAsync();
      expect(broadcasts.find((b) => b.type === 'warp_out')).toBeUndefined();
    });
  });

  describe('cancelAll', () => {
    it('cancels every in-flight transit', () => {
      const r1 = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      // Use same room — register a second player by hand.
      (r1.room.playerToSlot as Map<string, number>).set('p2', 1);
      (r1.room.playerToUser as Map<string, string | null>).set('p2', null);
      const orch = new TransitOrchestrator(r1.room);
      orch.beginTransit('p1', 'cygnus-arm');
      orch.beginTransit('p2', 'vega-reach');
      r1.sent.length = 0;
      orch.cancelAll('manual');
      expect(orch.isInFlight('p1')).toBe(false);
      expect(orch.isInFlight('p2')).toBe(false);
      const reasons = r1.sent
        .filter((s) => (s.msg as { state: string }).state === 'DOCKED')
        .map((s) => (s.msg as { reason?: string }).reason);
      expect(reasons).toEqual(['manual', 'manual']);
    });
  });

  // ── Phase 5: shipId routing ─────────────────────────────────────────────
  //
  // beginTransit(playerId, target, arrival?, shipId?) — when shipId is set,
  // the orchestrator validates that the named roster entry is owned by
  // `playerId` (rejects foreign or unknown ids). On commit it routes the
  // shipId through the destination room's reserveSeatFor join options so the
  // destination hydrates the named roster row instead of the source ship. A
  // roster-switch shipId keeps its OWN stored pose (commit does NOT re-home it).
  describe('Phase 5 — shipId routing for in-game roster switch', () => {
    function makePlayerShipStore(playerId: string, shipId: string, sectorKey: string): PlayerShipStore {
      const ownStore = new PlayerShipStore({ generateShipId: () => shipId });
      ownStore.create({
        playerId,
        userId: null,
        kind: 'fighter',
        sectorKey,
        x: 0,
        y: 0,
        health: 100,
      });
      return ownStore;
    }

    it('rejects beginTransit when shipId is unknown to the store', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const playerShipStore = new PlayerShipStore({});
      const orch = new TransitOrchestrator(room, undefined, playerShipStore);
      const ok = orch.beginTransit('p1', 'cygnus-arm', undefined, 'unknown-ship');
      expect(ok).toBe(false);
      const msg = sent[0]!.msg as { state: string; reason?: string };
      expect(msg.state).toBe('DOCKED');
      expect(msg.reason).toBe('destination_unavailable');
    });

    it('rejects beginTransit when shipId is owned by a different player', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const playerShipStore = makePlayerShipStore('OTHER-PLAYER', 'foreign-ship', 'orion-belt');
      const orch = new TransitOrchestrator(room, undefined, playerShipStore);
      const ok = orch.beginTransit('p1', 'cygnus-arm', undefined, 'foreign-ship');
      expect(ok).toBe(false);
      const msg = sent[0]!.msg as { state: string; reason?: string };
      expect(msg.state).toBe('DOCKED');
      expect(msg.reason).toBe('destination_unavailable');
      // Critical: the store must NOT have been mutated (no transit machine
      // spun up).
      expect(orch.isInFlight('p1')).toBe(false);
    });

    it('accepts beginTransit when shipId is owned by the requesting player', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const playerShipStore = makePlayerShipStore('p1', 'own-ship', 'orion-belt');
      const orch = new TransitOrchestrator(room, undefined, playerShipStore);
      const ok = orch.beginTransit('p1', 'cygnus-arm', undefined, 'own-ship');
      expect(ok).toBe(true);
      expect(orch.isInFlight('p1')).toBe(true);
      const msg = sent[0]!.msg as { state: string; targetSectorKey?: string };
      expect(msg.state).toBe('SPOOLING');
      expect(msg.targetSectorKey).toBe('cygnus-arm');
    });

    it('commit passes the explicit shipId through to reserveSeatFor without re-homing it', async () => {
      const { room } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const playerShipStore = makePlayerShipStore('p1', 'own-ship', 'orion-belt');
      const orch = new TransitOrchestrator(room, undefined, playerShipStore);
      const reserve = vi.fn().mockResolvedValue({ sessionId: 'r', room: { roomId: 'x' } });
      orch.setReserveByNameOverride(reserve as unknown as Parameters<TransitOrchestrator['setReserveByNameOverride']>[0]);
      orch.beginTransit('p1', 'cygnus-arm', undefined, 'own-ship');
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      await vi.runAllTimersAsync();
      expect(reserve).toHaveBeenCalledTimes(1);
      const args = reserve.mock.calls[0]!;
      expect(args[0]).toBe('galaxy-cygnus-arm');
      // The reservation options carry the shipId so the destination room's
      // onJoin binds the named roster entry instead of the source ship.
      expect(args[1]).toEqual(expect.objectContaining({ playerId: 'p1', shipId: 'own-ship' }));
      // A roster-switch keeps the switched-to ship's OWN stored pose — commit
      // must NOT clobber it with the source pose (it stays where it was stored).
      expect(playerShipStore.get('own-ship')!.lastSectorKey).toBe('orion-belt');
      expect(playerShipStore.get('own-ship')!.lastX).toBe(0);
    });

    it('regression: absent shipId AND no active hull omits shipId from reserveSeatFor options', async () => {
      const { room } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const playerShipStore = new PlayerShipStore({});
      const orch = new TransitOrchestrator(room, undefined, playerShipStore);
      const reserve = vi.fn().mockResolvedValue({ sessionId: 'r', room: { roomId: 'x' } });
      orch.setReserveByNameOverride(reserve as unknown as Parameters<TransitOrchestrator['setReserveByNameOverride']>[0]);
      // No shipId arg AND playerToActiveShipInstance is empty → nothing to thread.
      orch.beginTransit('p1', 'cygnus-arm');
      vi.advanceTimersByTime(SPOOL_DURATION_MS);
      await vi.runAllTimersAsync();
      const opts = reserve.mock.calls[0]![1] as Record<string, unknown>;
      expect(opts).not.toHaveProperty('shipId');
    });
  });
});

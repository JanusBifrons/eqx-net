import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TransitOrchestrator, type TransitHostRoom } from './TransitOrchestrator.js';
import { LimboStore } from '../limbo/LimboStore.js';
import { Bus } from '../../core/events/Bus.js';
import {
  SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_ANGVEL_OFF,
  SAB_TOTAL_BYTES, slotBase,
} from '../../shared-types/sabLayout.js';

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

function makeRoom(opts: { sectorKey: string | null; playerId: string }): {
  room: TransitHostRoom;
  sent: FakeClientSent[];
  setHealth: (h: number) => void;
  setSlotPose: (slot: number, pose: { x: number; y: number; vx: number; vy: number; angle: number; angvel: number }) => void;
} {
  const sab = new SharedArrayBuffer(SAB_TOTAL_BYTES);
  const sabF32 = new Float32Array(sab);
  const playerToSlot = new Map<string, number>();
  const playerToUser = new Map<string, string | null>();
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
  const room: TransitHostRoom = {
    sectorKey: opts.sectorKey,
    bus: new Bus(),
    sabF32,
    playerToSlot,
    playerToUser,
    lastFireClientTick,
    getShipHealth: () => health,
    playerToTransitInFlight,
    clientForPlayer: () => fc.client as unknown as Parameters<TransitHostRoom['clientForPlayer']>[0] extends never ? never : ReturnType<TransitHostRoom['clientForPlayer']>,
  };

  return {
    room,
    sent: fc.sent,
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
      const orch = new TransitOrchestrator(room, new LimboStore({}));
      const ok = orch.beginTransit('p1', 'orion-belt');
      expect(ok).toBe(false);
      expect(sent).toHaveLength(1);
      const msg = sent[0]!.msg as { state: string; reason?: string };
      expect(msg.state).toBe('DOCKED');
      expect(msg.reason).toBe('manual');
    });

    it('rejects when target is not a neighbour', () => {
      const { room, sent } = makeRoom({ sectorKey: 'orion-belt', playerId: 'p1' });
      const orch = new TransitOrchestrator(room, new LimboStore({}));
      const ok = orch.beginTransit('p1', 'cygnus-arm');
      expect(ok).toBe(false);
      const msg = sent[0]!.msg as { state: string; reason?: string };
      expect(msg.reason).toBe('not_neighbour');
    });

    it('accepts a valid neighbour and emits SPOOLING', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room, new LimboStore({}));
      const ok = orch.beginTransit('p1', 'orion-belt');
      expect(ok).toBe(true);
      expect(orch.isInFlight('p1')).toBe(true);
      const msg = sent[0]!.msg as { state: string; targetSectorKey?: string; spoolMs?: number };
      expect(msg.state).toBe('SPOOLING');
      expect(msg.targetSectorKey).toBe('orion-belt');
      expect(msg.spoolMs).toBe(3000);
    });

    it('a second beginTransit while in flight is a no-op', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room, new LimboStore({}));
      orch.beginTransit('p1', 'orion-belt');
      sent.length = 0;
      const ok = orch.beginTransit('p1', 'vega-reach');
      expect(ok).toBe(false);
      expect(sent).toHaveLength(0);
    });
  });

  describe('vulnerable spool-up: SHIP_DESTROYED aborts', () => {
    it('aborts when SHIP_DESTROYED fires for the spooling player', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room, new LimboStore({}));
      orch.beginTransit('p1', 'orion-belt');
      sent.length = 0;
      room.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: 'p1', shooterId: 'enemy' });
      expect(orch.isInFlight('p1')).toBe(false);
      const last = sent.find((s) => (s.msg as { state: string }).state === 'DOCKED');
      expect(last).toBeDefined();
      expect((last!.msg as { reason?: string }).reason).toBe('destroyed');
    });

    it('SHIP_DESTROYED for a different player does not abort', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room, new LimboStore({}));
      orch.beginTransit('p1', 'orion-belt');
      sent.length = 0;
      room.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: 'p2', shooterId: 'enemy' });
      expect(orch.isInFlight('p1')).toBe(true);
      expect(sent).toHaveLength(0);
    });
  });

  describe('manual cancel', () => {
    it('cancelTransit during SPOOLING transitions back to DOCKED with reason', () => {
      const { room, sent } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room, new LimboStore({}));
      orch.beginTransit('p1', 'orion-belt');
      sent.length = 0;
      orch.cancelTransit('p1', 'manual');
      expect(orch.isInFlight('p1')).toBe(false);
      const msg = sent[0]!.msg as { state: string; reason?: string };
      expect(msg.state).toBe('DOCKED');
      expect(msg.reason).toBe('manual');
    });

    it('cancelTransit on unknown player is a no-op', () => {
      const { room } = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const orch = new TransitOrchestrator(room, new LimboStore({}));
      expect(() => orch.cancelTransit('nobody', 'manual')).not.toThrow();
    });
  });

  describe('commit', () => {
    function withFakeReserve(fn: ReturnType<typeof vi.fn>): { orch: TransitOrchestrator; room: ReturnType<typeof makeRoom>['room']; limbo: LimboStore; sent: FakeClientSent[]; setHealth: (h: number) => void } {
      const r = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      const limbo = new LimboStore({});
      const orch = new TransitOrchestrator(r.room, limbo);
      orch.setReserveByNameOverride(fn as unknown as Parameters<TransitOrchestrator['setReserveByNameOverride']>[0]);
      return { orch, room: r.room, limbo, sent: r.sent, setHealth: r.setHealth };
    }

    it('writes Limbo with the destination sectorKey, transit-in-flight TTL, and current pose', async () => {
      const reservation = { sessionId: 'reserved', room: { roomId: 'r' } };
      const reserve = vi.fn().mockResolvedValue(reservation);
      const { orch, room, limbo, sent, setHealth } = withFakeReserve(reserve);
      setHealth(42);
      orch.beginTransit('p1', 'orion-belt');
      sent.length = 0;
      // Skip ahead to commit.
      vi.advanceTimersByTime(3000);
      // Allow microtasks (the await chain in commitTransit).
      await vi.runAllTimersAsync();

      // Limbo entry exists with the destination key.
      const entry = limbo.peek('p1');
      expect(entry).not.toBeNull();
      expect(entry!.payload.sectorKey).toBe('orion-belt');
      expect(entry!.payload.x).toBe(100);
      expect(entry!.payload.vx).toBe(1);
      expect(entry!.payload.health).toBe(42);
      expect(entry!.payload.lastFireClientTick).toBe(999);
      expect(entry!.payload.userId).toBe('user-test');
      // Transit-in-flight TTL = 30 s.
      expect(entry!.expiresAt - entry!.createdAt).toBe(30_000);

      // playerToTransitInFlight flag set so onLeave skips its own put.
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

    it('reserves the seat for the destination galaxy room', async () => {
      const reserve = vi.fn().mockResolvedValue({ sessionId: 'r', room: { roomId: 'x' } });
      // matchMaker.query is monkey-patched inside getRoomCache; bypass that
      // by using the override (which feeds reservation directly). The test
      // doesn't need to validate query() here — it validates the reserve
      // call shape.
      const { orch } = withFakeReserve(reserve);
      orch.beginTransit('p1', 'orion-belt');
      vi.advanceTimersByTime(3000);
      await vi.runAllTimersAsync();
      expect(reserve).toHaveBeenCalledTimes(1);
      const args = reserve.mock.calls[0]!;
      // First arg is the room name; second is the options bag.
      expect(args[0]).toBe('galaxy-orion-belt');
      expect(args[1]).toEqual(expect.objectContaining({ playerId: 'p1' }));
    });

    it('falls through to destination_unavailable when reserveSeatFor rejects', async () => {
      const reserve = vi.fn().mockRejectedValue(new Error('full'));
      const { orch, room, limbo, sent } = withFakeReserve(reserve);
      orch.beginTransit('p1', 'orion-belt');
      sent.length = 0;
      vi.advanceTimersByTime(3000);
      await vi.runAllTimersAsync();
      // No Limbo entry written.
      expect(limbo.peek('p1')).toBeNull();
      // playerToTransitInFlight NOT set — onLeave will Limbo-put normally.
      expect(room.playerToTransitInFlight.has('p1')).toBe(false);
      // transit_state DOCKED with destination_unavailable.
      const last = sent.find((s) => (s.msg as { state: string }).state === 'DOCKED');
      expect(last).toBeDefined();
      expect((last!.msg as { reason?: string }).reason).toBe('destination_unavailable');
    });

    it('player vanishing mid-spool (no slot) skips reservation cleanly', async () => {
      const reserve = vi.fn().mockResolvedValue({ sessionId: 'r', room: { roomId: 'x' } });
      const { orch, room, limbo } = withFakeReserve(reserve);
      orch.beginTransit('p1', 'orion-belt');
      // Simulate disconnect: clear the slot map.
      (room.playerToSlot as Map<string, number>).delete('p1');
      vi.advanceTimersByTime(3000);
      await vi.runAllTimersAsync();
      expect(reserve).not.toHaveBeenCalled();
      expect(limbo.peek('p1')).toBeNull();
      expect(orch.isInFlight('p1')).toBe(false);
    });
  });

  describe('cancelAll', () => {
    it('cancels every in-flight transit', () => {
      const r1 = makeRoom({ sectorKey: 'sol-prime', playerId: 'p1' });
      // Use same room — register a second player by hand.
      (r1.room.playerToSlot as Map<string, number>).set('p2', 1);
      (r1.room.playerToUser as Map<string, string | null>).set('p2', null);
      const orch = new TransitOrchestrator(r1.room, new LimboStore({}));
      orch.beginTransit('p1', 'orion-belt');
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
});

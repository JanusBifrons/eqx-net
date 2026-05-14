/**
 * Wire-format guard for the renderer-worker protocol.
 *
 * The protocol's correctness depends on every message variant being
 * structured-cloneable (because `postMessage` clones the message
 * before delivering it to the worker / main side). If any field is a
 * function, class instance, or DOM/Pixi handle, the clone throws at
 * runtime — discoverable only via E2E flake otherwise. This file
 * locks the property at the type level + via a runtime structuredClone
 * roundtrip.
 */
import { describe, it, expect } from 'vitest';
import type {
  MainToWorkerMsg,
  WorkerToMainMsg,
  SerialisedPointerEvent,
  SerialisedWheelEvent,
} from './protocol.js';

function roundtrip<T>(msg: T): T {
  return structuredClone(msg);
}

const pointerSample: SerialisedPointerEvent = {
  type: 'pointerdown',
  pointerId: 1,
  pointerType: 'mouse',
  button: 0,
  buttons: 1,
  clientX: 100,
  clientY: 200,
  offsetX: 80,
  offsetY: 180,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  isPrimary: true,
  pressure: 0.5,
  width: 1,
  height: 1,
  twist: 0,
  tiltX: 0,
  tiltY: 0,
  stamp: 1_700_000_000_000,
};

const wheelSample: SerialisedWheelEvent = {
  deltaX: 0,
  deltaY: 100,
  deltaZ: 0,
  deltaMode: 0,
  clientX: 100,
  clientY: 200,
  offsetX: 80,
  offsetY: 180,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  stamp: 1_700_000_000_000,
};

describe('renderer-worker protocol', () => {
  describe('Main → Worker messages roundtrip via structuredClone', () => {
    it('BOOT is structured-cloneable (OffscreenCanvas mocked with a placeholder)', () => {
      // OffscreenCanvas can't be constructed in node test env; use a
      // plain stand-in object. The Transfer mechanism is tested in E2E.
      const msg: MainToWorkerMsg = {
        type: 'BOOT',
        canvas: {} as unknown as OffscreenCanvas,
        width: 800,
        height: 600,
        dpr: 2,
      };
      const back = roundtrip(msg);
      expect(back.type).toBe('BOOT');
      if (back.type === 'BOOT') {
        expect(back.width).toBe(800);
        expect(back.height).toBe(600);
        expect(back.dpr).toBe(2);
      }
    });

    it('MIRROR_UPDATE survives roundtrip with an empty mirror', () => {
      const msg: MainToWorkerMsg = {
        type: 'MIRROR_UPDATE',
        mirror: {
          ships: new Map(),
          localPlayerId: null,
          serverTick: 0,
          swarm: new Map(),
          wrecks: new Map(),
          lingeringShips: new Map(),
          projectiles: new Map(),
          serverGhostX: 0,
          serverGhostY: 0,
          serverGhostVisible: false,
          boostingShips: new Set(),
          thrustingShips: new Set(),
          explodingShips: new Set(),
          pendingDamageNumbers: [],
          pendingHealthBarHits: [],
          liveBeams: new Map(),
        },
      };
      const back = roundtrip(msg);
      expect(back.type).toBe('MIRROR_UPDATE');
    });

    it.each<{ name: string; msg: MainToWorkerMsg }>([
      { name: 'SET_VISIBLE', msg: { type: 'SET_VISIBLE', visible: true } },
      { name: 'SET_CURRENT_SECTOR', msg: { type: 'SET_CURRENT_SECTOR', sectorKey: 'sol-prime' } },
      { name: 'SET_CURRENT_SECTOR null', msg: { type: 'SET_CURRENT_SECTOR', sectorKey: null } },
      { name: 'SET_TRANSIT_DOCKED', msg: { type: 'SET_TRANSIT_DOCKED', docked: true } },
      { name: 'RESIZE', msg: { type: 'RESIZE', width: 1024, height: 768, dpr: 1.5 } },
      { name: 'SET_TICKER_FPS number', msg: { type: 'SET_TICKER_FPS', fps: 30 } },
      { name: 'SET_TICKER_FPS null', msg: { type: 'SET_TICKER_FPS', fps: null } },
      { name: 'SET_TICKER_FPS undefined', msg: { type: 'SET_TICKER_FPS', fps: undefined } },
      { name: 'POINTER_EVENT', msg: { type: 'POINTER_EVENT', native: pointerSample } },
      { name: 'WHEEL_EVENT', msg: { type: 'WHEEL_EVENT', native: wheelSample } },
      { name: 'DISPOSE', msg: { type: 'DISPOSE' } },
    ])('$name survives structuredClone', ({ msg }) => {
      const back = roundtrip(msg);
      expect(back.type).toBe(msg.type);
    });
  });

  describe('Worker → Main messages roundtrip via structuredClone', () => {
    it.each<{ name: string; msg: WorkerToMainMsg }>([
      { name: 'READY', msg: { type: 'READY' } },
      {
        name: 'FEEDBACK',
        msg: {
          type: 'FEEDBACK',
          feedback: {
            mountCounts: new Map([['ship-1', 3], ['ship-2', 1]]),
            haloArrowCount: 7,
            damageNumberActiveCount: 2,
          },
        },
      },
      { name: 'OVERLAY_TAPPED', msg: { type: 'OVERLAY_TAPPED', sectorKey: 'beta-7' } },
      { name: 'ERROR', msg: { type: 'ERROR', message: 'boom' } },
    ])('$name survives structuredClone', ({ msg }) => {
      const back = roundtrip(msg);
      expect(back.type).toBe(msg.type);
      if (back.type === 'FEEDBACK') {
        expect(back.feedback.haloArrowCount).toBe(7);
        expect(back.feedback.mountCounts.get('ship-1')).toBe(3);
      }
    });
  });

  describe('Compile-time exhaustiveness (type-level check, not runtime)', () => {
    it('every MainToWorkerMsg type is in the discriminated union', () => {
      // If this function compiles, the switch is exhaustive at compile
      // time. Adding a new variant to MainToWorkerMsg without adding a
      // case here fails the build.
      function _assertExhaustive(msg: MainToWorkerMsg): string {
        switch (msg.type) {
          case 'BOOT':
          case 'MIRROR_UPDATE':
          case 'SET_VISIBLE':
          case 'SET_CURRENT_SECTOR':
          case 'SET_TRANSIT_DOCKED':
          case 'RESIZE':
          case 'SET_TICKER_FPS':
          case 'POINTER_EVENT':
          case 'WHEEL_EVENT':
          case 'DISPOSE':
            return msg.type;
        }
      }
      expect(_assertExhaustive({ type: 'DISPOSE' })).toBe('DISPOSE');
    });

    it('every WorkerToMainMsg type is in the discriminated union', () => {
      function _assertExhaustive(msg: WorkerToMainMsg): string {
        switch (msg.type) {
          case 'READY':
          case 'FEEDBACK':
          case 'OVERLAY_TAPPED':
          case 'ERROR':
            return msg.type;
        }
      }
      expect(_assertExhaustive({ type: 'READY' })).toBe('READY');
    });
  });
});

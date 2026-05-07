import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GhostManager } from './GhostProjectile.js';
import type { ProjectileRenderState } from '@core/contracts/IRenderer';

describe('GhostManager', () => {
  let manager: GhostManager;
  let mirror: Map<string, ProjectileRenderState>;
  let nowMs: number;

  beforeEach(() => {
    manager = new GhostManager();
    mirror = new Map();
    nowMs = 1000;
    vi.spyOn(performance, 'now').mockReturnValue(nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes expired ghost entries from the output map', () => {
    // Spawn a laser ghost (projectile mode, TTL 500ms).
    manager.spawn('shot-1', 'player-1', 0, 0, 0, 1, 'laser');
    manager.update(16, mirror);
    expect(mirror.has('shot-1')).toBe(true);

    // Advance time past TTL.
    vi.spyOn(performance, 'now').mockReturnValue(nowMs + 600);
    manager.update(16, mirror);

    // The entry must be removed from the mirror — not left as a stale sprite.
    expect(mirror.has('shot-1')).toBe(false);
  });

  it('removes resolved ghost entries from the output map', () => {
    manager.spawn('shot-2', 'player-1', 0, 0, 1, 0, 'laser');
    manager.update(16, mirror);
    expect(mirror.has('shot-2')).toBe(true);

    // Resolve (hit_ack arrived).
    manager.resolve('shot-2', false);
    manager.update(16, mirror);

    expect(mirror.has('shot-2')).toBe(false);
  });

  it('removes expired hitscan beam ghost from output map', () => {
    manager.spawn('beam-1', 'player-1', 0, 0, 0, 1, 'hitscan');
    manager.update(16, mirror);
    expect(mirror.has('beam-1')).toBe(true);
    expect(mirror.get('beam-1')!.beam).toBeDefined();

    // Advance past beam TTL (250ms).
    vi.spyOn(performance, 'now').mockReturnValue(nowMs + 300);
    manager.update(16, mirror);

    expect(mirror.has('beam-1')).toBe(false);
  });

  it('laser ghost reads speed from the catalogue (1600, not legacy 300)', () => {
    manager.spawn('shot-3', 'player-1', 0, 0, 0, 1, 'laser');
    manager.update(0, mirror);
    const entry = mirror.get('shot-3');
    expect(entry).toBeDefined();
    // Speed 1600 in the +y direction (no shooter velocity passed).
    expect(entry!.vy).toBe(1600);
    expect(entry!.vx).toBe(0);
  });

  it('laser ghost inherits shooter velocity when provided', () => {
    // Shooter moving at (40, 10), firing in +y direction.
    manager.spawn('shot-vel', 'player-1', 0, 0, 0, 1, 'laser', 40, 10);
    manager.update(0, mirror);
    const entry = mirror.get('shot-vel');
    expect(entry).toBeDefined();
    expect(entry!.vx).toBe(40);
    expect(entry!.vy).toBe(1600 + 10);
  });

  it('passes weaponId through to the render state', () => {
    manager.spawn('shot-4', 'player-1', 0, 0, 1, 0, 'laser');
    manager.update(0, mirror);
    expect(mirror.get('shot-4')!.weaponId).toBe('laser');
  });
});

/**
 * @vitest-environment jsdom
 *
 * Plan: crispy-kazoo, Commit 6 — dispose-audit lock.
 *
 * Reflection-based regression lock for `ColyseusGameClient.dispose()`:
 *   - Construct a client.
 *   - Reach into `mirror` and populate EVERY Map/Set/Array with sentinel
 *     entries (so an absent clear would leak observably).
 *   - Stamp every nullable subsystem ref with a known value.
 *   - Call `dispose()`.
 *   - Walk every Map/Set/Array on `mirror` via reflection and assert
 *     size===0 / length===0. Walk a curated list of expected-null fields
 *     and assert they're null.
 *
 * The reflection walk is the prophylactic: adding a new field to
 * `RenderMirror` does NOT require touching the dispose method
 * (the `clearMirror` walk auto-clears it). This test stays green
 * unless someone introduces a new field that isn't a Map / Set /
 * Array — at which point the dispose audit needs a deliberate update.
 *
 * Also asserts the live-instance counter decrements correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependency surface so we can construct a client without
// booting a Colyseus room. The mocks cover the minimal contracts:
//   - debug/ClientLogger: logEvent + installWindowLogger + isFullDiagMode
//   - debug/serverHealthPoller: poll noop (referenced at module init in
//     other files, but harmless here — just keeps the module graph small)
vi.mock('../debug/ClientLogger.js', () => ({
  logEvent: vi.fn(),
  installWindowLogger: vi.fn(),
  isFullDiagMode: () => false,
  isDiagEnabled: () => false,
  __resetDiagCache: vi.fn(),
}));

vi.mock('../debug/ClientLogger', () => ({
  logEvent: vi.fn(),
  installWindowLogger: vi.fn(),
  isFullDiagMode: () => false,
  isDiagEnabled: () => false,
  __resetDiagCache: vi.fn(),
}));

import { ColyseusGameClient } from './ColyseusClient.js';

describe('ColyseusGameClient.dispose() — reflection-based mirror clear', () => {
  beforeEach(() => {
    // Reset the static counter so each test starts from 0.
    (ColyseusGameClient as unknown as { _liveInstanceN: number })._liveInstanceN = 0;
  });

  it('clears every Map / Set / Array on mirror via reflection', () => {
    const client = new ColyseusGameClient();
    const mirror = client.mirror as unknown as Record<string, unknown>;

    // Populate every property generically. The test stays robust to
    // future fields — any new Map / Set / Array on mirror automatically
    // gets sentinel-populated AND auto-cleared by the dispose walk.
    let populated = 0;
    for (const k of Object.keys(mirror)) {
      const v = mirror[k];
      if (v instanceof Map) {
        v.set(`sentinel-${k}-a`, 'A');
        v.set(`sentinel-${k}-b`, 'B');
        populated++;
      } else if (v instanceof Set) {
        v.add(`sentinel-${k}`);
        populated++;
      } else if (Array.isArray(v)) {
        v.push({ sentinel: k });
        populated++;
      }
    }
    expect(populated).toBeGreaterThan(0); // sanity: there ARE collection fields

    client.dispose();

    // Every collection must now be empty.
    for (const k of Object.keys(mirror)) {
      const v = mirror[k];
      if (v instanceof Map) {
        expect(v.size, `mirror.${k} should be empty post-dispose`).toBe(0);
      } else if (v instanceof Set) {
        expect(v.size, `mirror.${k} should be empty post-dispose`).toBe(0);
      } else if (Array.isArray(v)) {
        expect(v.length, `mirror.${k} should be empty post-dispose`).toBe(0);
      }
    }
  });

  it('sets disposed=true', () => {
    const client = new ColyseusGameClient();
    expect((client as unknown as { disposed: boolean }).disposed).toBe(false);
    client.dispose();
    expect((client as unknown as { disposed: boolean }).disposed).toBe(true);
  });

  it('nulls keyboard / touchInput / room / predWorld / reconciler / audio', () => {
    const client = new ColyseusGameClient();
    const c = client as unknown as Record<string, unknown>;
    // Stamp some non-null sentinels (these aren't actually setup yet at
    // construction, but stamp anyway in case future fields exist).
    c['keyboard'] = { fake: 'keyboard' };
    c['touchInput'] = { fake: 'touch' };
    c['audio'] = { fake: 'audio' };

    client.dispose();

    expect(c['keyboard']).toBeNull();
    expect(c['touchInput']).toBeNull();
    expect(c['room']).toBeNull();
    expect(c['predWorld']).toBeNull();
    expect(c['reconciler']).toBeNull();
    expect(c['audio']).toBeNull();
  });

  it('decrements live-instance count on dispose', () => {
    expect(ColyseusGameClient.getLiveInstanceCount()).toBe(0);
    const a = new ColyseusGameClient();
    expect(ColyseusGameClient.getLiveInstanceCount()).toBe(1);
    const b = new ColyseusGameClient();
    expect(ColyseusGameClient.getLiveInstanceCount()).toBe(2);
    a.dispose();
    expect(ColyseusGameClient.getLiveInstanceCount()).toBe(1);
    b.dispose();
    expect(ColyseusGameClient.getLiveInstanceCount()).toBe(0);
  });

  it('dispose is idempotent — second call does NOT push the counter negative', () => {
    const client = new ColyseusGameClient();
    expect(ColyseusGameClient.getLiveInstanceCount()).toBe(1);
    client.dispose();
    expect(ColyseusGameClient.getLiveInstanceCount()).toBe(0);
    // Second dispose: clamp via Math.max ensures the counter doesn't go negative.
    client.dispose();
    expect(ColyseusGameClient.getLiveInstanceCount()).toBe(0);
  });

  it('clears combat surfaces (damageFlash + scheduledDamageSpawns)', () => {
    const client = new ColyseusGameClient();
    const c = client as unknown as { _damageFlashFrames: Map<string, number>; _scheduledDamageSpawns: unknown[] };
    c._damageFlashFrames.set('ship-1', 5);
    c._scheduledDamageSpawns.push({ a: 1 }, { b: 2 });
    client.dispose();
    expect(c._damageFlashFrames.size).toBe(0);
    expect(c._scheduledDamageSpawns.length).toBe(0);
  });

  it('5 construct/dispose cycles stay at live=0 (cascade-stability regression lock)', () => {
    // The 2026-05-30 cascade trigger: GameSurface remount creates a fresh
    // ColyseusGameClient while the previous instance's subscriptions /
    // timers retain it. After N cycles, N instances exist. This is the
    // unit-level proxy for that integration symptom.
    for (let i = 0; i < 5; i++) {
      const client = new ColyseusGameClient();
      expect(ColyseusGameClient.getLiveInstanceCount()).toBe(1);
      client.dispose();
      expect(ColyseusGameClient.getLiveInstanceCount()).toBe(0);
    }
  });
});

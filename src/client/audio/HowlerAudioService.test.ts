import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HowlerAudioService } from './HowlerAudioService';

// Plan: crispy-kazoo, Commit 4 — Howler global is mocked so we can
// observe suspend / resume calls and verify ctx.close() is NEVER called
// (it's irreversible global state; the dispose audit in Commit 6
// re-locks the same contract).
const mockCtx = vi.hoisted(() => ({
  suspend: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock('howler', () => ({
  Howl: class {},
  Howler: { ctx: mockCtx },
}));

beforeEach(() => {
  mockCtx.suspend.mockClear();
  mockCtx.resume.mockClear();
  mockCtx.close.mockClear();
});

describe('HowlerAudioService', () => {
  it('setClockRate is a no-op when no howls are registered', () => {
    const svc = new HowlerAudioService();
    expect(() => svc.setClockRate(0.8)).not.toThrow();
  });

  it('setClockRate iterates and calls .rate on every howl', () => {
    const svc = new HowlerAudioService();
    const a = { rate: vi.fn(), unload: vi.fn() };
    const b = { rate: vi.fn(), unload: vi.fn() };
    (svc as unknown as { howls: unknown[] }).howls.push(a, b);
    svc.setClockRate(0.8);
    expect(a.rate).toHaveBeenCalledWith(0.8);
    expect(b.rate).toHaveBeenCalledWith(0.8);
  });

  it('clamps the rate to 0.5 (Howler floor)', () => {
    const svc = new HowlerAudioService();
    const h = { rate: vi.fn(), unload: vi.fn() };
    (svc as unknown as { howls: unknown[] }).howls.push(h);
    svc.setClockRate(0.3);
    expect(h.rate).toHaveBeenCalledWith(0.5);
  });

  it('dispose unloads every howl and empties the array', () => {
    const svc = new HowlerAudioService();
    const h = { rate: vi.fn(), unload: vi.fn() };
    (svc as unknown as { howls: unknown[] }).howls.push(h);
    svc.dispose();
    expect(h.unload).toHaveBeenCalled();
    expect((svc as unknown as { howls: unknown[] }).howls.length).toBe(0);
  });

  it('dispose does NOT close the global Howler context (irreversible)', () => {
    const svc = new HowlerAudioService();
    svc.dispose();
    expect(mockCtx.close).not.toHaveBeenCalled();
  });

  describe('pause boundary (Commit 4)', () => {
    it('suspendAll calls ctx.suspend()', async () => {
      const svc = new HowlerAudioService();
      await svc.suspendAll();
      expect(mockCtx.suspend).toHaveBeenCalledTimes(1);
    });

    it('resumeAll calls ctx.resume()', async () => {
      const svc = new HowlerAudioService();
      await svc.resumeAll();
      expect(mockCtx.resume).toHaveBeenCalledTimes(1);
    });

    it('suspend/resume cycle leaves the context intact for replay', async () => {
      const svc = new HowlerAudioService();
      await svc.suspendAll();
      await svc.resumeAll();
      expect(mockCtx.suspend).toHaveBeenCalledTimes(1);
      expect(mockCtx.resume).toHaveBeenCalledTimes(1);
      expect(mockCtx.close).not.toHaveBeenCalled();
    });

    it('suspend rejection is swallowed (iOS Safari path)', async () => {
      mockCtx.suspend.mockRejectedValueOnce(new Error('iOS Safari rejects'));
      const svc = new HowlerAudioService();
      await expect(svc.suspendAll()).resolves.toBeUndefined();
    });

    it('resume rejection is swallowed', async () => {
      mockCtx.resume.mockRejectedValueOnce(new Error('rejected'));
      const svc = new HowlerAudioService();
      await expect(svc.resumeAll()).resolves.toBeUndefined();
    });
  });
});

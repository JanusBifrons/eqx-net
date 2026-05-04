import { describe, it, expect, vi } from 'vitest';
import { HowlerAudioService } from './HowlerAudioService';

vi.mock('howler', () => ({ Howl: class {} }));

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
});

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('emailStorage', () => {
  it('saveEmail lower-cases + trims; loadEmail returns it; clearEmail removes it', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as unknown as Storage);

    const { saveEmail, loadEmail, clearEmail } = await import('./emailStorage');
    saveEmail('  Alecvickers@HOTMAIL.com  ');
    expect(loadEmail()).toBe('alecvickers@hotmail.com'); // normalised on write
    clearEmail();
    expect(loadEmail()).toBeNull();
  });

  it('loadEmail returns null when localStorage is unavailable (node / SSR)', async () => {
    vi.stubGlobal('localStorage', undefined as unknown as Storage);
    const { loadEmail } = await import('./emailStorage');
    expect(loadEmail()).toBeNull();
  });

  it('saveEmail / clearEmail swallow storage errors (quota / disabled)', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage);

    const { saveEmail, clearEmail, loadEmail } = await import('./emailStorage');
    expect(() => saveEmail('x@y.com')).not.toThrow();
    expect(() => clearEmail()).not.toThrow();
    expect(loadEmail()).toBeNull();
  });
});

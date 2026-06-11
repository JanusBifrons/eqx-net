import { describe, it, expect, vi } from 'vitest';
import { installProcessGuards, type ProcessLike } from './processGuards.js';

/** Fake process that captures the registered handlers so tests can fire them. */
function makeFakeProcess() {
  const handlers: Record<string, (arg: unknown) => void> = {};
  const exit = vi.fn((_code?: number) => undefined as never);
  const proc: ProcessLike = {
    on(event, listener) { handlers[event] = listener; },
    exit,
  };
  return { proc, handlers, exit };
}

function makeLogger() {
  return { fatal: vi.fn() };
}

describe('installProcessGuards (R1)', () => {
  it('registers both uncaughtException and unhandledRejection', () => {
    const { proc, handlers } = makeFakeProcess();
    installProcessGuards({ logger: makeLogger(), onFatal: vi.fn(), proc });
    expect(typeof handlers['uncaughtException']).toBe('function');
    expect(typeof handlers['unhandledRejection']).toBe('function');
  });

  it('on uncaughtException: logs fatal once and calls onFatal once', () => {
    const { proc, handlers } = makeFakeProcess();
    const logger = makeLogger();
    const onFatal = vi.fn();
    installProcessGuards({ logger, onFatal, proc });

    handlers['uncaughtException']!(new Error('boom'));
    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]![1]).toBe('uncaughtException');
  });

  it('routes unhandledRejection through onFatal with the right source tag', () => {
    const { proc, handlers } = makeFakeProcess();
    const onFatal = vi.fn();
    installProcessGuards({ logger: makeLogger(), onFatal, proc });

    handlers['unhandledRejection']!('rejected');
    expect(onFatal.mock.calls[0]![1]).toBe('unhandledRejection');
  });

  it('does not re-enter onFatal on a second fault — exits immediately instead', () => {
    const { proc, handlers, exit } = makeFakeProcess();
    const onFatal = vi.fn();
    installProcessGuards({ logger: makeLogger(), onFatal, proc });

    handlers['uncaughtException']!(new Error('first'));
    handlers['uncaughtException']!(new Error('second — during drain'));
    expect(onFatal).toHaveBeenCalledTimes(1); // not called the second time
    expect(exit).toHaveBeenCalledWith(1);
  });
});

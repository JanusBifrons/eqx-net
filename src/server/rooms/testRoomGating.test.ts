import { describe, it, expect } from 'vitest';
import { shouldRegisterSandboxRoom, shouldRegisterTestRooms } from './testRoomGating.js';

describe('shouldRegisterTestRooms (S6)', () => {
  it('registers test rooms in development', () => {
    expect(shouldRegisterTestRooms({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('registers test rooms when NODE_ENV is unset', () => {
    expect(shouldRegisterTestRooms({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('does NOT register test rooms in production by default', () => {
    expect(shouldRegisterTestRooms({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('re-enables test rooms in production with EQX_ENABLE_TEST_ROOMS=1', () => {
    expect(
      shouldRegisterTestRooms({ NODE_ENV: 'production', EQX_ENABLE_TEST_ROOMS: '1' } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('treats any non-1 EQX_ENABLE_TEST_ROOMS as off in production', () => {
    expect(
      shouldRegisterTestRooms({ NODE_ENV: 'production', EQX_ENABLE_TEST_ROOMS: 'true' } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe('shouldRegisterSandboxRoom', () => {
  const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
  it.each([
    [{}, true],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'production' }, false],
    [{ NODE_ENV: 'production', EQX_ENABLE_TEST_ROOMS: '1' }, true],
    [{ NODE_ENV: 'production', EQX_ENABLE_SANDBOX_ROOM: '1' }, true],
    [{ NODE_ENV: 'production', EQX_ENABLE_SANDBOX_ROOM: 'true' }, false],
    // The phone lane: sandbox on, test rooms off.
    [{ NODE_ENV: 'production', EQX_ENABLE_TEST_ROOMS: '0', EQX_ENABLE_SANDBOX_ROOM: '1' }, true],
  ])('%o -> %s', (e, want) => {
    expect(shouldRegisterSandboxRoom(env(e))).toBe(want);
  });

  it('the sandbox flag never turns the test rooms on', () => {
    expect(shouldRegisterTestRooms(env({ NODE_ENV: 'production', EQX_ENABLE_SANDBOX_ROOM: '1' }))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { shouldRegisterTestRooms } from './testRoomGating.js';

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

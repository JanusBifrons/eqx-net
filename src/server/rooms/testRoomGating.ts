/**
 * Gate for the engineering/test Colyseus rooms (plan squishy-canyon, S6).
 *
 * Galaxy rooms (`galaxy-*`) are always registered. The engineering + test rooms
 * (`test-sector`, `*-test`, `swarm-*`, `feel-test*`, `mount-test`, `shield-test`,
 * …) carry testMode overrides (`initialHull`, `testTimeScale`, `dronePoses`,
 * `startHostile`) and load/burn knobs (`swarm-tidi-burn`'s `tickBurnMs` is a free
 * CPU-burn DoS). A production client must not be able to join them.
 *
 * They are registered only outside production, OR when EQX_ENABLE_TEST_ROOMS=1
 * is set explicitly (a controlled load test against a production-mode build).
 * Same gate shape as the /dev/* routes. Production join of a non-registered
 * room fails at matchmaking — the correct failure mode.
 */
export function shouldRegisterTestRooms(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NODE_ENV'] !== 'production' || env['EQX_ENABLE_TEST_ROOMS'] === '1';
}

/**
 * Gate for the sandbox room (`?room=sandbox`, docs/features/sandbox.md): on
 * wherever the test rooms are, and on a production-mode build only with
 * EQX_ENABLE_SANDBOX_ROOM=1 (the phone lane sets it, test rooms stay off). The
 * sandbox is not testMode, so it opens no test knobs.
 */
export function shouldRegisterSandboxRoom(env: NodeJS.ProcessEnv = process.env): boolean {
  return shouldRegisterTestRooms(env) || env['EQX_ENABLE_SANDBOX_ROOM'] === '1';
}

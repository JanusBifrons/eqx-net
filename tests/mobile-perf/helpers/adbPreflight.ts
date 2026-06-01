/**
 * ADB shell preflight checks for the phone-driven test harness.
 *
 * `playwright._android` will happily launch Chrome on a phone whose
 * screen is off or whose lockscreen is up — but the page navigation
 * then fails with `net::ERR_CONNECTION_ABORTED` because Android
 * restricts background-app networking behind Doze and the keyguard.
 * That error is unactionable in the test log; the real fix is to
 * detect the state via `adb shell dumpsys` and throw a clear message
 * BEFORE we waste time launching Chrome.
 *
 * Detection signals (Android 11+):
 *   - `mWakefulness=Awake` in `dumpsys power`            → screen is on
 *   - `mDreamingLockscreen=false` in `dumpsys window`    → keyguard is dismissed
 *   - Either being wrong means networking-from-Chrome is restricted.
 *
 * We can't programmatically enter a PIN/pattern from ADB (security
 * boundary). The preflight's job is purely to surface "unlock your
 * phone" before launchBrowser.
 */
import { execFileSync } from 'node:child_process';

function adb(...args: string[]): string {
  try {
    return execFileSync('adb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(
      `[phone-poc] \`adb ${args.join(' ')}\` failed. Is adb on PATH? Original: ${(err as Error).message}`,
    );
  }
}

interface PhoneState {
  wakefulness: string;
  dreamingLockscreen: boolean;
  screenOnFully: boolean;
}

function readPhoneState(): PhoneState {
  const power = adb('shell', 'dumpsys', 'power');
  const window = adb('shell', 'dumpsys', 'window');

  const wakefulnessMatch = power.match(/mWakefulness=(\w+)/);
  const wakefulness = wakefulnessMatch?.[1] ?? 'Unknown';

  const lockMatch = window.match(/mDreamingLockscreen=(true|false)/);
  const dreamingLockscreen = lockMatch?.[1] === 'true';

  const screenMatch = window.match(/mScreenOnFully=(true|false)/);
  const screenOnFully = screenMatch?.[1] === 'true';

  return { wakefulness, dreamingLockscreen, screenOnFully };
}

/**
 * Throws with an actionable message if the phone's screen is off,
 * dozing, or showing the lockscreen. Otherwise returns the observed
 * state for logging.
 */
export function assertPhoneAwakeAndUnlocked(): PhoneState {
  const state = readPhoneState();

  if (state.wakefulness !== 'Awake' || !state.screenOnFully) {
    throw new Error(
      `[phone-poc] The phone is not awake (wakefulness=${state.wakefulness}, screenOnFully=${state.screenOnFully}).\n` +
        `Chrome will launch but Android Doze suppresses its networking → page.goto fails with net::ERR_CONNECTION_ABORTED.\n` +
        `Fix: wake the phone (press the power button) before running this test.`,
    );
  }

  if (state.dreamingLockscreen) {
    throw new Error(
      `[phone-poc] The phone is on the lockscreen (mDreamingLockscreen=true).\n` +
        `Chrome will launch but networking is restricted behind the keyguard → page.goto fails with net::ERR_CONNECTION_ABORTED.\n` +
        `Fix: unlock the phone (PIN/pattern/biometric — can't be done via ADB) before running this test.\n` +
        `Wireless-debugging note: if the phone re-locks automatically between runs, increase the screen-timeout in Settings → Display, or briefly tap the screen to keep it awake.`,
    );
  }

  return state;
}

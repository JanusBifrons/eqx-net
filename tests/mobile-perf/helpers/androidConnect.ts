/**
 * Device connection seam for the mobile-perf gate. Hides
 * device-vs-fallback from every spec behind one helper.
 *
 * Three connection modes:
 *
 *   - `'auto'` — try `playwright._android.devices()`; if `adb`
 *     returns no devices OR the `playwright` package isn't
 *     installed, fall back to desktop Chromium + CDP CPU throttle
 *     ×4. Logs which path it took.
 *
 *   - `'force-device'` — REQUIRE a real Android device; THROW if
 *     none. Use when you've intentionally plugged in a USB device
 *     locally and want a hard failure if something's wrong with
 *     ADB.
 *
 *   - `'force-fallback'` — DEFAULT in this repo's remote-container
 *     environment (no `adb`, no USB). Skips the Android probe
 *     entirely and goes straight to CDP-throttled desktop.
 *
 * Why default fallback: the repo's primary execution context is a
 * managed remote container with no `adb` / USB / device. `'auto'`
 * would always fall back here anyway, but `'force-fallback'` makes
 * that intent explicit and avoids a useless dynamic `import`. Local
 * developers with a USB-tethered Pixel run with
 * `MOBILE_PERF_MODE=force-device` (or `auto`).
 *
 * Browser-binary sharing: the full `playwright` package and
 * `@playwright/test` MUST be pinned to the EXACT same version in
 * `package.json` — they share `~/.cache/ms-playwright/` only when
 * versions match. Drift causes both to install their own binaries
 * AND opens a CDP-protocol desync risk.
 *
 * JWT injection (Android branch): `device.launchBrowser()` returns
 * a context that bypasses Playwright's per-project
 * `use.storageState` injection. The Android branch manually loads
 * the storage-state JSON and calls `addCookies` + `addInitScript`
 * for localStorage seeding. Mirrors what `tests/e2e/global-setup.ts`
 * does for the desktop path. Without this the spec fails at
 * Colyseus join with auth denial.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test';

export type ConnectMode = 'auto' | 'force-device' | 'force-fallback';
export type ConnectKind = 'android' | 'desktop-throttled';

export interface MobilePerfConnection {
  kind: ConnectKind;
  page: Page;
  cdp: CDPSession;
  context: BrowserContext;
  cleanup: () => Promise<void>;
}

export interface ConnectOptions {
  /** Defaults to env `MOBILE_PERF_MODE` then `'force-fallback'`. */
  mode?: ConnectMode;
  /** Defaults to env `PLAYWRIGHT_BASE_URL` then
   *  `http://localhost:5173`. The Android branch uses
   *  `http://10.0.2.2:<port>` for AVD or LAN IP for USB devices —
   *  override via env when running against a tethered phone. */
  baseURL?: string;
  /** Defaults to `tests/e2e/.auth/storage-state.json`. */
  storageStatePath?: string;
  /** CPU throttling rate for the fallback path. Defaults to 4 — same
   *  value `tests/perf/perf-baseline.spec.ts` uses for the
   *  "mobile-shaped" arm. */
  cpuThrottleRate?: number;
}

interface StorageState {
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  origins?: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

function readStorageState(path: string): StorageState | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StorageState;
  } catch {
    return null;
  }
}

async function applyStorageState(context: BrowserContext, state: StorageState | null): Promise<void> {
  if (!state) return;
  if (state.cookies && state.cookies.length > 0) {
    await context.addCookies(state.cookies);
  }
  if (state.origins && state.origins.length > 0) {
    // Mirror what Playwright's storageState restore does for localStorage:
    // emit an init script that seeds each origin's localStorage. We don't
    // know which origin the device will load first, so seed every
    // origin's entries unconditionally — the matching origin wins at
    // runtime, the rest are inert.
    const seeds = state.origins.flatMap((o) =>
      o.localStorage.map((kv) => `if (location.origin === ${JSON.stringify(o.origin)}) localStorage.setItem(${JSON.stringify(kv.name)}, ${JSON.stringify(kv.value)});`),
    );
    if (seeds.length > 0) {
      await context.addInitScript(seeds.join('\n'));
    }
  }
}

async function connectAndroid(opts: Required<ConnectOptions>): Promise<MobilePerfConnection> {
  // Dynamic import — the full `playwright` package is optional. If
  // not installed (e.g. fresh checkout, CI before `pnpm install`),
  // the import throws and we either fall back or surface the error
  // depending on caller mode.
  const playwright = (await import('playwright')) as unknown as {
    _android?: { devices: () => Promise<Array<{ launchBrowser: () => Promise<BrowserContext>; close: () => Promise<void> }>> };
  };
  const android = playwright._android;
  if (!android) {
    throw new Error('playwright._android not available — install the `playwright` package (matching @playwright/test version) to enable Android mode');
  }
  const devices = await android.devices();
  if (devices.length === 0) {
    throw new Error('playwright._android.devices() returned no devices — is `adb` on PATH and is a device connected with USB debugging enabled?');
  }
  const device = devices[0];
  const context = await device.launchBrowser();
  const storage = readStorageState(opts.storageStatePath);
  await applyStorageState(context, storage);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(opts.baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // eslint-disable-next-line no-console
  console.warn(`[mobile-perf] mode=android (device count=${devices.length})`);
  return {
    kind: 'android',
    page,
    cdp,
    context,
    cleanup: async () => {
      try {
        await context.close();
      } finally {
        await device.close().catch(() => undefined);
      }
    },
  };
}

async function connectDesktopThrottled(opts: Required<ConnectOptions>): Promise<MobilePerfConnection> {
  // The fallback path uses `@playwright/test`'s `chromium` import —
  // no additional dependency needed. `Emulation.setCPUThrottlingRate`
  // mirrors the `tests/perf/perf-baseline.spec.ts` "mobile-shaped"
  // arm. Note: this throttles CPU only, NOT GPU or memory; pure
  // GPU-texture leaks won't surface here (documented caveat).
  const browser = await chromium.launch({ headless: !process.env['PWHEADED'] });
  const storage = readStorageState(opts.storageStatePath);
  const context = await browser.newContext(storage ? { storageState: storage as never } : {});
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: opts.cpuThrottleRate });
  await page.goto(opts.baseURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // eslint-disable-next-line no-console
  console.warn(`[mobile-perf] mode=desktop-throttled (cpu rate=${opts.cpuThrottleRate}×)`);
  return {
    kind: 'desktop-throttled',
    page,
    cdp,
    context,
    cleanup: async () => {
      try {
        await context.close();
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
  };
}

/**
 * Connect to a real Android device, or fall back to CPU-throttled
 * desktop Chromium. See file header for mode semantics.
 *
 * The returned `MobilePerfConnection` is page-shaped — every spec
 * past this seam treats it identically regardless of `kind`.
 */
export async function connectAndroidOrFallback(
  opts: ConnectOptions = {},
): Promise<MobilePerfConnection> {
  const mode: ConnectMode = opts.mode ?? (process.env['MOBILE_PERF_MODE'] as ConnectMode | undefined) ?? 'force-fallback';
  const baseURL = opts.baseURL ?? process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
  const storageStatePath = opts.storageStatePath ?? resolve(process.cwd(), 'tests/e2e/.auth/storage-state.json');
  const cpuThrottleRate = opts.cpuThrottleRate ?? 4;
  const resolved: Required<ConnectOptions> = { mode, baseURL, storageStatePath, cpuThrottleRate };

  if (mode === 'force-device') {
    return connectAndroid(resolved);
  }
  if (mode === 'force-fallback') {
    return connectDesktopThrottled(resolved);
  }
  // mode === 'auto' — try device, fall back on any failure with a logged warning.
  try {
    return await connectAndroid(resolved);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[mobile-perf] android probe failed — falling back: ${(err as Error).message}`);
    return connectDesktopThrottled(resolved);
  }
}

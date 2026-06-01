# Phone-driven test harness — handoff

**Date:** 2026-06-01
**Branch:** `feat/pixi-heap-bisect` (PoC commit pending)
**Plan:** `.claude/plans/okay-we-are-reaching-kind-castle.md`
**Goal:** Replace manual phone smoke tests with `pnpm e2e:phone` automation driving Chrome on a USB-tethered Android phone via Playwright's `_android` API.

---

## Quick-start (after first-time setup below)

```powershell
# 1. Plug phone in via USB. Make sure it's unlocked.
adb devices
# Expect:
#   List of devices attached
#   <serial>    device          <- must say "device", NOT "unauthorized"

# 2. Run the PoC.
pnpm e2e:phone
# Expect, in order:
#   [phone-poc] LAN IP: 192.168.x.y (candidates: [...])
#   [phone-poc] navigating phone to: http://192.168.x.y:5173/?room=test-sector&...
#   [mobile-perf] mode=android (device count=1)
#   [phone-poc] live game state on phone: hullPct=100, shipX=2000.x, shipY=2000.y
#   1 passed
```

If a screenshot of the game running on the phone appears at `tests/mobile-perf/screenshots/phone-poc.png`, the harness is working end-to-end and any future smoke test can be expressed as a Playwright spec instead of a manual handoff.

---

## First-time setup (do once)

### On the phone

1. **Enable USB debugging.** Settings → About phone → tap "Build number" 7 times to unlock Developer Options → Developer Options → toggle "USB debugging" ON. When the cable is plugged in, accept the host's RSA fingerprint prompt ("Always allow from this computer").
2. **Phone must be UNLOCKED (past the keyguard) for each test run.** Empirically verified 2026-06-01: with the phone Dozing (screen off) OR Awake-but-on-lockscreen (`mDreamingLockscreen=true`), `device.launchBrowser()` succeeds and Chrome opens — but the subsequent `page.goto(...)` fails with `net::ERR_CONNECTION_ABORTED`. Android Doze suppresses background-app networking, and the keyguard restricts foreground networking similarly. The PIN/pattern can't be bypassed via ADB, so YOU must unlock the phone before `pnpm e2e:phone`. The spec runs a preflight (`adbPreflight.ts`) and fails loudly with "unlock your phone" rather than the cryptic ERR_CONNECTION_ABORTED if the keyguard is up. If your phone re-locks between runs (default screen-timeout), bump screen-timeout in Settings → Display or briefly tap the screen between runs.
3. **Enable the required Chrome flag.** Open Chrome on the phone, navigate to:
   ```
   chrome://flags/#enable-command-line-on-non-rooted-devices
   ```
   Set "Enable command line on non-rooted devices" to **Enabled**, then tap **Relaunch** at the bottom. Without this, `playwright._android.launchBrowser()` throws — the helper translates the failure to an actionable error, but you still need the flag to be ON to run the test.
4. **Phone is on the same Wi-Fi as the host PC.** USB carries the ADB control channel; the page fetch itself goes over Wi-Fi to `http://<host-LAN-IP>:5173`.
5. **Chrome (not Chromium / Brave / Firefox)** must be the system Chrome. `_android` only drives the official Chrome.

### On the host (Windows)

1. **ADB on PATH.** `adb --version` from PowerShell should print the version. Android Platform Tools installer or `winget install Google.PlatformTools`.
2. **Vendor USB driver** for your phone OEM (Samsung, Google, OnePlus, etc.) — without it, `adb devices` shows nothing even when the cable is good. Samsung phones in particular need the Samsung USB Driver.
3. **No port conflicts on 2567 / 5173.** Playwright will boot the dev servers via the `webServer` block in `playwright.mobile-perf.config.ts`; if a stale one is already there, kill it (CLAUDE.md "stale dev servers" section).

---

## How it works under the hood

| Piece | File | Purpose |
|---|---|---|
| LAN-IP picker | `tests/mobile-perf/helpers/lanIp.ts` | Heuristic: prefer `192.168.*`, then `10.*`, reject `172.16-31.*` (Docker/WSL bridges). `HOST_LAN_IP=<ip>` env overrides. |
| Device connect helper | `tests/mobile-perf/helpers/androidConnect.ts` | Calls `playwright._android.devices()`, force-stops Chrome, launches it with the right CDP socket, applies JWT storage state. Now supports `extraOrigins` for cross-origin localStorage seeding. |
| Chrome-flag error translator | `androidConnect.ts` (try/catch around `device.launchBrowser()`) | The #1 first-run footgun is the Chrome flag being off. The wrapper detects the launch failure and re-throws with the exact phone steps. |
| PoC spec | `tests/mobile-perf/phone-poc.spec.ts` | Force-device connect → `?room=test-sector&spawnX=2000&spawnY=2000&shipKind=Frigate` → wait for `data-testid="game-surface"` → wait for `data-hull-pct > 0` → read DOM telemetry → screenshot. |
| pnpm script | `package.json` `e2e:phone` | `MOBILE_PERF_MODE=force-device playwright test --config=playwright.mobile-perf.config.ts tests/mobile-perf/phone-poc.spec.ts`. |

### JWT cross-origin seeding (the subtle bit)

`tests/e2e/global-setup.ts` mints a JWT scoped to `http://localhost:5173` (Playwright's default `baseURL`) and writes it to `tests/e2e/.auth/storage-state.json` with that origin. The phone navigates to `http://<LAN-IP>:5173`, which is a DIFFERENT origin — Playwright's storageState restore would skip it.

Fix: the PoC spec passes `extraOrigins: ['http://<LAN-IP>:5173']` to `connectAndroidOrFallback`. The helper synthesises an init-script seed that also fires when `location.origin === 'http://<LAN-IP>:5173'`, restoring the same JWT under the LAN-IP origin. The JWT itself has no `aud`/`iss` claim, so it's origin-agnostic on the server side.

---

## Troubleshooting

**`playwright._android.devices() returned no devices`**
→ Run `adb devices` from PowerShell. If empty: vendor USB driver missing, cable broken, or USB debugging off. If `unauthorized`: accept the RSA prompt on the phone.

**`The phone is on the lockscreen (mDreamingLockscreen=true)` (preflight error)**
→ Unlock the phone (PIN/pattern/biometric). The preflight detected the keyguard via `adb shell dumpsys window` and stopped before launching Chrome (because launching behind the keyguard reliably fails with the unactionable `net::ERR_CONNECTION_ABORTED` at `page.goto`).

**`The phone is not awake (wakefulness=Dozing, ...)` (preflight error)**
→ Press the power button to wake the phone, then unlock.

**`Chrome on the phone failed to launch via _android` (with the chrome://flags message)**
→ The Chrome flag is off (or somehow flipped back to default). Re-enable the flag, relaunch Chrome on the phone, force-stop it (`adb shell am force-stop com.android.chrome`), and re-run.

**`connected via _android (not desktop fallback)` assertion fails**
→ The harness silently fell back to desktop. Cause: the device probe threw and `mode` was `auto` instead of `force-device`. Check the env: `MOBILE_PERF_MODE=force-device pnpm e2e:phone`.

**`waitForSelector data-testid="game-surface"` times out**
→ Page didn't reach the game phase. Check the Chrome address bar on the phone — is it actually loaded to the LAN URL? If the URL bar is blank or shows an error, the LAN-IP pick is wrong. Set `HOST_LAN_IP=<your-actual-LAN-ip>` and re-run.

**Test passes but the screenshot looks blank / black**
→ The canvas may be inside a SecurityContext that blocks the cross-origin screenshot. The DOM-attribute assertions are the real signal; the screenshot is decorative.

**Hull-pct is 0 even though game-surface appeared**
→ Auth issue. The localStorage seed didn't fire on the LAN-IP origin. Confirm `extraOrigins` is being passed (check the test code) and that the JWT in `tests/e2e/.auth/storage-state.json` exists and hasn't expired.

---

## What's next after this PoC is green

The PoC proves the harness works. Once it passes once, the next iterations are cheap:

1. **Capture-flow spec** — add `?autocapture=1` and `?startHostile=1`, play 10 s, assert a fresh `diag/captures/<ts>-*/` directory landed. Mirrors the manual smoke loop exactly.
2. **Port existing smoke specs** — `tests/e2e/happy-path-*.spec.ts` etc. via a small `phone()` fixture wrapping `connectAndroidOrFallback({ mode: 'auto', extraOrigins: [lanOrigin] })`.
3. **Heap & raf gates on real hardware** — re-run the mobile-perf heap-budget specs in device mode for the first time (they default to fallback today).

The big payoff: stop handing the user a smoke-test step every time we touch netcode / render / GC. Every change can verify on real hardware before the user looks at it.

/**
 * Decide whether the WebRTC DataChannel snapshot transport is enabled.
 *
 * **Default ON for real users** (swift-otter default flipped 2026-06-06). On
 * device the DataChannel establishes over LAN host-candidate ICE and carries
 * ~99% of snapshots over UDP; the intent is to avoid the WS/TCP head-of-line
 * amplification that can stretch a brief WiFi-radio stall into a ~530 ms
 * snapshot-delivery gap (the on-device "jumps"). The reliable `WebSocket` path
 * is retained as an automatic fallback whenever the DC can't establish
 * (symmetric NAT / cellular without TURN), so default-on is safe.
 *
 * **Default OFF under automation** (Playwright sets `navigator.webdriver=true`).
 * Two reasons, mirroring the `?diag` webdriver-gate:
 *   1. The per-PR E2E suite stays WS-deterministic (the DC adds a peer-to-peer
 *      UDP path + a connect window that would make timing-sensitive specs flaky).
 *   2. The netgate MUST keep measuring the WS path under its injected-latency
 *      HTTP+WS proxy — the DataChannel is peer-to-peer UDP and BYPASSES that
 *      proxy, which would silently invalidate the gate.
 * `webrtc-vs-ws-recv-gap-comparison.spec.ts` passes `?webrtc=1` explicitly to
 * exercise the DC arm, which overrides this default.
 *
 * Explicit override always wins: `?webrtc=1` forces on, `?webrtc=0` forces off.
 *
 * Pure + side-effect-free so it is unit-testable without a DOM. The caller
 * passes `window.location.search` and `navigator.webdriver`.
 */
export function webrtcEnabledFromSearch(
  search: string | null | undefined,
  isAutomation: boolean,
): boolean {
  let param: string | null = null;
  try {
    param = new URLSearchParams(search ?? '').get('webrtc');
  } catch {
    // Malformed search string — fall through to the default.
  }
  if (param === '1') return true;
  if (param === '0') return false;
  return !isAutomation;
}

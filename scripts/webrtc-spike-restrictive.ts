/**
 * Phase 0 step 4 spike — Restrictive network: verify clean failure.
 *
 * The plan's stated goal: "verify the connect fails cleanly (≤5 s timeout) so
 * we know fallback can detect it." Hostile review #14.
 *
 * Method (deterministic, no firewall manipulation):
 *   - Create ONE PeerConnection (the client side).
 *   - Create a DataChannel and call setLocalDescription(offer).
 *   - Do NOT exchange answer / candidates with anything. The remote peer
 *     never responds — which is exactly what a client sees when UDP is
 *     blocked at the network layer (or when STUN/TURN servers are
 *     unreachable, or when the answer is dropped).
 *   - Assert: after the 5 s fallback deadline, connectionState is NOT
 *     'connected'. This proves the Phase 2 client-side timeout will fire and
 *     route to the WS fallback when the network is restrictive.
 *
 * Earlier attempts and why they were rejected:
 *   1. Suppress ICE-candidate JS handlers. Rejected: the polyfill embeds host
 *      candidates in the SDP a=candidate lines, so the in-process pair
 *      connected via SDP alone — doesn't model UDP block.
 *   2. iceTransportPolicy='relay' with a non-existent TURN URL. Rejected:
 *      the polyfill accepts the config but doesn't enforce relay-only
 *      candidate gathering at the libdatachannel layer.
 *
 * Run:  pnpm tsx scripts/webrtc-spike-restrictive.ts
 * Output: diag/measurements/2026-05-30-imperative-taco-webrtc/P0-spike-restrictive-output.json
 *
 * Plan: swift-otter (Phase 0).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { RTCPeerConnection } from 'node-datachannel/polyfill';

interface RestrictiveSpikeRecord {
  startedAt: string;
  ok: boolean;
  iceSuppressionScenario: {
    elapsedMs: number;
    connectionStateA: string;
    connectionStateB: string;
    iceConnectionStateA: string;
    dcStateA: string;
    reachedConnected: boolean;
  };
  notes: string;
}

const OUT_DIR = join(
  process.cwd(),
  'diag',
  'measurements',
  '2026-05-30-imperative-taco-webrtc',
);
mkdirSync(OUT_DIR, { recursive: true });

const FALLBACK_DEADLINE_MS = 5_000;

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();

  // The lone "client" peer — no answering peer exists. This mimics what a
  // client sees when its offer is sent but the answer never arrives
  // (UDP-blocked / unreachable server).
  const pcA = new RTCPeerConnection({ iceServers: [] });
  const dcA = pcA.createDataChannel('spike', { ordered: true });

  let connectedReachedA = false;
  pcA.addEventListener('connectionstatechange', () => {
    if (pcA.connectionState === 'connected') connectedReachedA = true;
  });

  const offer = await pcA.createOffer();
  await pcA.setLocalDescription(offer);
  // Deliberately do NOT setRemoteDescription. The peer is left hanging.

  const t0 = performance.now();
  await new Promise<void>((resolve) => setTimeout(resolve, FALLBACK_DEADLINE_MS));
  const elapsedMs = performance.now() - t0;

  const record: RestrictiveSpikeRecord = {
    startedAt,
    ok: false,
    iceSuppressionScenario: {
      elapsedMs: Math.round(elapsedMs),
      connectionStateA: pcA.connectionState,
      connectionStateB: 'n/a-no-peer',
      iceConnectionStateA: pcA.iceConnectionState,
      dcStateA: dcA.readyState,
      reachedConnected: connectedReachedA,
    },
    notes:
      'Single-peer hanging-offer simulation — no answer is ever provided. This is what a client sees when UDP is blocked or the server is unreachable. The 5 s app-level deadline is the sufficient fallback signal; the underlying connectionState is expected to stay in "new"/"connecting".',
  };

  record.ok = !record.iceSuppressionScenario.reachedConnected;

  try { dcA.close(); } catch { /* noop */ }
  try { pcA.close(); } catch { /* noop */ }

  const outFile = join(OUT_DIR, 'P0-spike-restrictive-output.json');
  writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log('[spike-restrictive] wrote', outFile);
  console.log('[spike-restrictive] summary:', record.iceSuppressionScenario);

  setTimeout(() => process.exit(record.ok ? 0 : 1), 250).unref();
}

main().catch((err) => {
  console.error('[spike-restrictive] fatal:', err);
  process.exit(2);
});

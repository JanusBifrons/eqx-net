/**
 * Phase 0 step 5 spike — bufferedAmount via the NATIVE node-datachannel API.
 *
 * The W3C polyfill (used by scripts/webrtc-spike.ts) showed bufferedAmount=0
 * across 1000 × 1 KB back-to-back sends in loopback. Two possibilities:
 *   A) The polyfill doesn't surface the underlying SCTP buffered state.
 *   B) In-process loopback drains the buffer faster than JS can read it.
 *
 * This script bypasses the polyfill and reads bufferedAmount directly from
 * the native DataChannel binding. If we see the same 0 across the burst, the
 * cause is (B) — loopback is too fast — and the Phase 1 routing layer must
 * rely on try/catch + send latency timing rather than bufferedAmount as the
 * back-pressure signal.
 *
 * Hostile review #4 mitigation lives in Phase 1; this is the data point.
 *
 * Run:  pnpm tsx scripts/webrtc-spike-buffered-native.ts
 * Output: diag/measurements/2026-05-30-imperative-taco-webrtc/P0-spike-buffered-native-output.json
 *
 * Plan: swift-otter (Phase 0).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import ndc from 'node-datachannel';

interface BufferedNativeRecord {
  startedAt: string;
  ok: boolean;
  sendsAttempted: number;
  sendsReturnedTrue: number;
  sendsReturnedFalse: number;
  threwOnSend: boolean;
  throwIndex: number | null;
  throwMessage: string | null;
  bufferedAmountSamples: { i: number; ba: number }[];
  maxBufferedAmount: number;
  receivedCount: number;
  totalBytesSent: number;
  sendLoopMs: number;
  drainMs: number;
  notes: string;
}

const OUT_DIR = join(
  process.cwd(),
  'diag',
  'measurements',
  '2026-05-30-imperative-taco-webrtc',
);
mkdirSync(OUT_DIR, { recursive: true });

async function main(): Promise<void> {
  const pcA = new ndc.PeerConnection('A', { iceServers: [] });
  const pcB = new ndc.PeerConnection('B', { iceServers: [] });

  pcA.onLocalDescription((sdp, type) => pcB.setRemoteDescription(sdp, type as any));
  pcB.onLocalDescription((sdp, type) => pcA.setRemoteDescription(sdp, type as any));
  pcA.onLocalCandidate((cand, mid) => pcB.addRemoteCandidate(cand, mid));
  pcB.onLocalCandidate((cand, mid) => pcA.addRemoteCandidate(cand, mid));

  const dcA = pcA.createDataChannel('spike', { ordered: true });
  const dcBPromise = new Promise<any>((resolve) => {
    pcB.onDataChannel((dc) => resolve(dc));
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('open timeout')), 5_000);
    dcA.onOpen(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  const dcB = await dcBPromise;
  let receivedCount = 0;
  dcB.onMessage(() => {
    receivedCount++;
  });

  const sends = 1000;
  const payload = Buffer.alloc(1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) & 0xff;

  const samples: { i: number; ba: number }[] = [];
  let maxBA = 0;
  let sendsTrue = 0;
  let sendsFalse = 0;
  let threwOnSend = false;
  let throwIndex: number | null = null;
  let throwMessage: string | null = null;
  let totalBytes = 0;

  const t0 = performance.now();
  for (let i = 0; i < sends; i++) {
    let ok: boolean;
    try {
      ok = dcA.sendMessageBinary(payload);
    } catch (err) {
      threwOnSend = true;
      throwIndex = i;
      throwMessage = err instanceof Error ? err.message : String(err);
      break;
    }
    if (ok) sendsTrue++;
    else sendsFalse++;
    totalBytes += payload.byteLength;

    const ba = dcA.bufferedAmount();
    if (ba > maxBA) maxBA = ba;
    if (i % 50 === 0 || i === sends - 1) samples.push({ i, ba });
  }
  const sendLoopMs = performance.now() - t0;

  const drainStart = performance.now();
  const drainDeadline = drainStart + 30_000;
  while (performance.now() < drainDeadline) {
    const ba = dcA.bufferedAmount();
    if (ba === 0 && receivedCount >= sendsTrue) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const drainMs = performance.now() - drainStart;

  const record: BufferedNativeRecord = {
    startedAt: new Date().toISOString(),
    ok: !threwOnSend && receivedCount > 0,
    sendsAttempted: sends,
    sendsReturnedTrue: sendsTrue,
    sendsReturnedFalse: sendsFalse,
    threwOnSend,
    throwIndex,
    throwMessage,
    bufferedAmountSamples: samples,
    maxBufferedAmount: maxBA,
    receivedCount,
    totalBytesSent: totalBytes,
    sendLoopMs: Math.round(sendLoopMs),
    drainMs: Math.round(drainMs),
    notes:
      maxBA === 0
        ? 'maxBufferedAmount stayed 0 across native + polyfill burst — loopback drains synchronously. Production code must NOT rely on bufferedAmount as the sole back-pressure signal. Use try/catch + send-latency timing per Phase 1 hardening.'
        : 'maxBufferedAmount was nonzero — bufferedAmount can act as a back-pressure signal. Phase 1 routing can read it before each send.',
  };

  try { dcA.close(); } catch { /* noop */ }
  try { dcB.close(); } catch { /* noop */ }
  try { pcA.close(); pcB.close(); } catch { /* noop */ }

  const outFile = join(OUT_DIR, 'P0-spike-buffered-native-output.json');
  writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log('[spike-buffered-native] wrote', outFile);
  console.log('[spike-buffered-native] summary:', {
    ok: record.ok,
    sendsTrue: record.sendsReturnedTrue,
    sendsFalse: record.sendsReturnedFalse,
    threw: record.threwOnSend,
    maxBA: record.maxBufferedAmount,
    received: record.receivedCount,
    sendLoopMs: record.sendLoopMs,
    drainMs: record.drainMs,
  });

  setTimeout(() => process.exit(record.ok ? 0 : 1), 250).unref();
}

main().catch((err) => {
  console.error('[spike-buffered-native] fatal:', err);
  process.exit(2);
});

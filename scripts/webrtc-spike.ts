/**
 * Phase 0 spike for the swift-otter WebRTC DataChannel plan.
 *
 * What this proves (or disproves):
 *   1. node-datachannel's W3C polyfill round-trips offer / answer / ICE
 *      between two PeerConnections in the same Node process. This is the
 *      foundation for the Phase 3 in-process integration test, where one
 *      peer is the SectorRoom and the other is a node-datachannel client
 *      driven by the existing harness.
 *   2. A 1 KB binary frame survives the round-trip with byte-exact equality.
 *   3. bufferedAmount behaviour under back-to-back writes (Phase 0 step 5,
 *      hostile review #4). We send 1000 × 1 KB messages with no awaits and
 *      record the bufferedAmount curve + whether send() ever throws.
 *
 * What this does NOT prove (deliberately):
 *   - Browser ↔ node-datachannel interop (covered by Phase 0 step 3).
 *   - Restrictive-network behaviour (Phase 0 step 4).
 *   - Production routing logic (Phase 1).
 *
 * Run:  pnpm tsx scripts/webrtc-spike.ts
 * Output: diag/measurements/2026-05-30-imperative-taco-webrtc/P0-spike-output.json
 *
 * Plan: swift-otter (Phase 0).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { RTCPeerConnection } from 'node-datachannel/polyfill';

interface SpikeRecord {
  startedAt: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  ndcVersion: string;
  inProcessSpike: {
    ok: boolean;
    connectionStateA: string;
    connectionStateB: string;
    dataChannelStateB: string;
    payloadBytesSent: number;
    payloadBytesReceived: number;
    payloadMatches: boolean;
    handshakeMs: number;
    roundTripMs: number;
  };
  bufferedAmountProbe: {
    ok: boolean;
    sends: number;
    threwOnSend: boolean;
    throwIndex: number | null;
    throwMessage: string | null;
    maxBufferedAmount: number;
    bufferedAmountSamples: { i: number; ba: number }[];
    totalBytesSent: number;
    drainMs: number;
  };
}

const OUT_DIR = join(
  process.cwd(),
  'diag',
  'measurements',
  '2026-05-30-imperative-taco-webrtc',
);
mkdirSync(OUT_DIR, { recursive: true });

function pkgVersion(): string {
  try {
    const pkg = require('node-datachannel/package.json') as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`spike timeout: ${label} > ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface InProcessResult {
  ok: boolean;
  connectionStateA: string;
  connectionStateB: string;
  dataChannelStateB: string;
  payloadBytesSent: number;
  payloadBytesReceived: number;
  payloadMatches: boolean;
  handshakeMs: number;
  roundTripMs: number;
  dcA: any;
  dcB: any;
  pcA: any;
  pcB: any;
}

async function runInProcessSpike(): Promise<InProcessResult> {
  const t0 = performance.now();
  const pcA = new RTCPeerConnection({ iceServers: [] });
  const pcB = new RTCPeerConnection({ iceServers: [] });

  pcA.addEventListener('icecandidate', (e: any) => {
    if (e.candidate) void pcB.addIceCandidate(e.candidate);
  });
  pcB.addEventListener('icecandidate', (e: any) => {
    if (e.candidate) void pcA.addIceCandidate(e.candidate);
  });

  const dcA = pcA.createDataChannel('spike', { ordered: true });

  const dcOpen = new Promise<void>((resolve) => {
    dcA.addEventListener('open', () => resolve());
  });

  const dcBPromise = new Promise<any>((resolve) => {
    pcB.addEventListener('datachannel', (e: any) => resolve(e.channel));
  });

  const offer = await pcA.createOffer();
  await pcA.setLocalDescription(offer);
  await pcB.setRemoteDescription(pcA.localDescription!);
  const answer = await pcB.createAnswer();
  await pcB.setLocalDescription(answer);
  await pcA.setRemoteDescription(pcB.localDescription!);

  const dcB = (await withTimeout(dcBPromise, 5_000, 'datachannel-event-B')) as any;
  await withTimeout(dcOpen, 5_000, 'datachannel-open-A');

  const handshakeMs = performance.now() - t0;

  const payload = new Uint8Array(1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

  const recvPromise = new Promise<Uint8Array>((resolve) => {
    dcB.addEventListener('message', (e: any) => {
      const data = e.data;
      if (data instanceof ArrayBuffer) resolve(new Uint8Array(data));
      else if (data instanceof Uint8Array) resolve(data);
      else if (Buffer.isBuffer(data)) resolve(new Uint8Array(data));
      else resolve(new Uint8Array());
    });
  });

  const tSend = performance.now();
  dcA.send(payload);
  const received = await withTimeout(recvPromise, 5_000, 'message-roundtrip');
  const roundTripMs = performance.now() - tSend;

  let matches = received.byteLength === payload.byteLength;
  if (matches) {
    for (let i = 0; i < payload.length; i++) {
      if (received[i] !== payload[i]) {
        matches = false;
        break;
      }
    }
  }

  return {
    ok: matches,
    connectionStateA: pcA.connectionState,
    connectionStateB: pcB.connectionState,
    dataChannelStateB: dcB.readyState,
    payloadBytesSent: payload.byteLength,
    payloadBytesReceived: received.byteLength,
    payloadMatches: matches,
    handshakeMs,
    roundTripMs,
    dcA,
    dcB,
    pcA,
    pcB,
  };
}

async function runBufferedAmountProbe(dcA: any, dcB: any): Promise<SpikeRecord['bufferedAmountProbe']> {
  const sends = 1000;
  const samples: { i: number; ba: number }[] = [];
  let threwOnSend = false;
  let throwIndex: number | null = null;
  let throwMessage: string | null = null;
  let maxBA = 0;
  let totalBytes = 0;

  const payload = new Uint8Array(1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;

  let receivedCount = 0;
  dcB.addEventListener('message', () => {
    receivedCount++;
  });

  const t0 = performance.now();
  for (let i = 0; i < sends; i++) {
    try {
      dcA.send(payload);
      totalBytes += payload.byteLength;
    } catch (err) {
      threwOnSend = true;
      throwIndex = i;
      throwMessage = err instanceof Error ? err.message : String(err);
      break;
    }
    const ba = dcA.bufferedAmount ?? 0;
    if (ba > maxBA) maxBA = ba;
    if (i % 50 === 0 || i === sends - 1) samples.push({ i, ba });
  }

  // Wait for drain: bufferedAmount → 0 or receivedCount → sends.
  const drainStart = performance.now();
  const drainDeadline = drainStart + 30_000;
  while (performance.now() < drainDeadline) {
    const ba = dcA.bufferedAmount ?? 0;
    if (ba === 0 && receivedCount >= sends - (throwIndex ?? 0)) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const drainMs = performance.now() - drainStart;
  const sendMs = drainStart - t0;

  return {
    ok: !threwOnSend && receivedCount > 0,
    sends: throwIndex ?? sends,
    threwOnSend,
    throwIndex,
    throwMessage,
    maxBufferedAmount: maxBA,
    bufferedAmountSamples: samples,
    totalBytesSent: totalBytes,
    drainMs: Math.round(drainMs),
    sendLoopMs: Math.round(sendMs),
    receivedCount,
  } as any;
}

async function main(): Promise<void> {
  const record: SpikeRecord = {
    startedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    ndcVersion: pkgVersion(),
    inProcessSpike: {
      ok: false,
      connectionStateA: 'n/a',
      connectionStateB: 'n/a',
      dataChannelStateB: 'n/a',
      payloadBytesSent: 0,
      payloadBytesReceived: 0,
      payloadMatches: false,
      handshakeMs: 0,
      roundTripMs: 0,
    },
    bufferedAmountProbe: {
      ok: false,
      sends: 0,
      threwOnSend: false,
      throwIndex: null,
      throwMessage: null,
      maxBufferedAmount: 0,
      bufferedAmountSamples: [],
      totalBytesSent: 0,
      drainMs: 0,
    },
  };

  let inProc: InProcessResult | undefined;
  try {
    inProc = await runInProcessSpike();
    record.inProcessSpike = {
      ok: inProc.ok,
      connectionStateA: inProc.connectionStateA,
      connectionStateB: inProc.connectionStateB,
      dataChannelStateB: inProc.dataChannelStateB,
      payloadBytesSent: inProc.payloadBytesSent,
      payloadBytesReceived: inProc.payloadBytesReceived,
      payloadMatches: inProc.payloadMatches,
      handshakeMs: Math.round(inProc.handshakeMs),
      roundTripMs: Math.round(inProc.roundTripMs * 1000) / 1000,
    };
  } catch (err) {
    console.error('[spike] in-process spike threw:', err);
  }

  if (inProc?.ok) {
    try {
      record.bufferedAmountProbe = await runBufferedAmountProbe(inProc.dcA, inProc.dcB);
    } catch (err) {
      console.error('[spike] bufferedAmount probe threw:', err);
    }
  }

  if (inProc) {
    try {
      inProc.dcA.close();
      inProc.dcB.close();
      inProc.pcA.close();
      inProc.pcB.close();
    } catch {
      /* shutdown best-effort */
    }
  }

  const outFile = join(OUT_DIR, 'P0-spike-output.json');
  writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log('[spike] wrote', outFile);
  console.log('[spike] summary:', {
    inProcOk: record.inProcessSpike.ok,
    handshakeMs: record.inProcessSpike.handshakeMs,
    roundTripMs: record.inProcessSpike.roundTripMs,
    probeOk: record.bufferedAmountProbe.ok,
    threw: record.bufferedAmountProbe.threwOnSend,
    maxBA: record.bufferedAmountProbe.maxBufferedAmount,
  });

  // Force exit so the polyfill's libdatachannel cleanup thread doesn't keep
  // the process alive.
  setTimeout(() => process.exit(record.inProcessSpike.ok ? 0 : 1), 250).unref();
}

main().catch((err) => {
  console.error('[spike] fatal:', err);
  process.exit(2);
});

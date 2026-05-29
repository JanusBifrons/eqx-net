/**
 * Diagnostic spike — does node-datachannel ↔ Chromium DC lose messages at
 * our production broadcast rate?
 *
 * Phase 4 E2E surfaced massive snapshot loss in both reliable and
 * unreliable modes (97 % loss in unreliable healthy-network control).
 * Phase 0 spikes only ever sent ONE message round-trip; this spike
 * actually exercises the high-rate streaming path the Phase 4 test
 * implicitly tests.
 *
 * What this proves (or disproves):
 *   - With `ordered: true`: server sends N msgpackr-encoded snapshot-
 *     shaped payloads at 20 Hz for 10 s, client counts receives.
 *     Healthy loopback should deliver ~all of them. Less than 95 %
 *     delivery means there's a bug in our pipeline.
 *   - With `ordered: false, maxRetransmits: 0`: same workload, expect
 *     similar throughput on loopback (no real packet loss).
 *
 * Bypasses Colyseus entirely — pure node-datachannel server ↔ Chromium
 * browser. If THIS shows loss, the issue is the library / wire. If this
 * is clean, the issue is in our SectorRoom / SnapshotBroadcaster /
 * routing integration.
 *
 * Run: pnpm tsx scripts/webrtc-spike-high-rate.ts
 * Output: diag/measurements/2026-05-30-imperative-taco-webrtc/P4-high-rate-spike.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { Packr } from '@colyseus/msgpackr';
import ndc from 'node-datachannel';

interface Record {
  startedAt: string;
  config: {
    sendRateHz: number;
    durationMs: number;
    expectedMessages: number;
    ordered: boolean;
    maxRetransmits: number | null;
    snapBytes: number;
  };
  serverSentTotal: number;
  serverSendReturnedFalse: number;
  serverSendThrew: number;
  serverMaxBufferedAmount: number;
  clientReceivedTotal: number;
  lossPct: number;
  notes: string;
}

const OUT_DIR = join(
  process.cwd(),
  'diag',
  'measurements',
  '2026-05-30-imperative-taco-webrtc',
);
mkdirSync(OUT_DIR, { recursive: true });

async function startSignaling(port: number, onPeer: (send: (m: unknown) => void, onMsg: (cb: (m: any) => void) => void) => void) {
  const wss = new WebSocketServer({ port });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  wss.on('connection', (sock) => {
    const send = (m: unknown) => sock.send(JSON.stringify(m));
    const listeners: ((m: any) => void)[] = [];
    sock.on('message', (data) => {
      let parsed: any;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      for (const fn of listeners) fn(parsed);
    });
    onPeer(send, (cb) => listeners.push(cb));
  });
  return wss;
}

const PAGE_HTML = (port: number, ordered: boolean, maxRetransmits: number | null) => `<!DOCTYPE html>
<html><head><title>high-rate spike</title></head><body>
<script>
(async () => {
  const result = { connected: false, receivedCount: 0, errors: [] };
  (window).__spike = result;
  const ws = new WebSocket('ws://127.0.0.1:${port}');
  const send = (m) => ws.send(JSON.stringify(m));
  await new Promise((r) => ws.onopen = r);
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.onicecandidate = (e) => { if (e.candidate) send({ kind: 'ice', candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => { result.connectionState = pc.connectionState; };
  const dcOptions = ${JSON.stringify({ ordered, ...(maxRetransmits !== null ? { maxRetransmits } : {}) })};
  const dc = pc.createDataChannel('snapshot', dcOptions);
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => { result.connected = true; result.dcOpenAt = performance.now(); };
  dc.onmessage = (e) => { result.receivedCount += 1; result.lastRecvAt = performance.now(); };
  dc.onerror = (e) => { result.errors.push('dc-error'); };
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.kind === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    else if (m.kind === 'ice') {
      try { await pc.addIceCandidate(m.candidate); } catch (err) { result.errors.push('addIce: ' + err.message); }
    }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ kind: 'offer', sdp: pc.localDescription.sdp });
})();
</script>
</body></html>`;

async function runConfig(ordered: boolean, maxRetransmits: number | null): Promise<Record> {
  const port = 35713 + (ordered ? 0 : 1);
  const SEND_RATE_HZ = 20;
  const DURATION_MS = 10_000;
  const SEND_INTERVAL_MS = 1000 / SEND_RATE_HZ;
  const EXPECTED = SEND_RATE_HZ * DURATION_MS / 1000;

  // Build a realistic snapshot-shaped payload (~1.5 KB encoded).
  const packr = new Packr({ encodeUndefinedAsNil: true });
  const samplePayload = {
    type: 'snapshot' as const,
    serverTick: 0,
    states: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [
      `ship-${i}`,
      {
        playerId: `p${i}`, isActive: true,
        x: i * 100, y: -i * 100, vx: 12.5, vy: -8.3,
        angle: i * 0.7, angvel: 0.01,
      },
    ])),
    drones: Array.from({ length: 25 }, (_, i) => ({ id: i, mountAngles: [0.5, 1.2] })),
    ackedTick: 0,
    serverSendPerfNow: 0,
  };
  const packedBytes = packr.pack(samplePayload).byteLength;

  const record: Record = {
    startedAt: new Date().toISOString(),
    config: {
      sendRateHz: SEND_RATE_HZ, durationMs: DURATION_MS, expectedMessages: EXPECTED,
      ordered, maxRetransmits, snapBytes: packedBytes,
    },
    serverSentTotal: 0,
    serverSendReturnedFalse: 0,
    serverSendThrew: 0,
    serverMaxBufferedAmount: 0,
    clientReceivedTotal: 0,
    lossPct: 100,
    notes: '',
  };

  let pc: ndc.PeerConnection | null = null;
  let dc: ndc.DataChannel | null = null;
  let dcOpenResolve: () => void = () => {};
  const dcOpenPromise = new Promise<void>((r) => { dcOpenResolve = r; });

  const wss = await startSignaling(port, (send, onMsg) => {
    pc = new ndc.PeerConnection('spike', { iceServers: [] });
    pc.onLocalDescription((sdp, type) => send({ kind: type, sdp }));
    pc.onLocalCandidate((cand, mid) => send({ kind: 'ice', candidate: cand, mid }));
    pc.onDataChannel((d) => {
      dc = d;
      d.onOpen(() => dcOpenResolve());
    });
    onMsg(async (msg) => {
      if (msg.kind === 'offer') pc!.setRemoteDescription(msg.sdp, 'offer');
      else if (msg.kind === 'ice') {
        try { pc!.addRemoteCandidate(typeof msg.candidate === 'string' ? msg.candidate : msg.candidate.candidate, msg.mid ?? msg.candidate.sdpMid ?? ''); } catch { /* noop */ }
      }
    });
  });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent(PAGE_HTML(port, ordered, maxRetransmits), { waitUntil: 'load' });

  // Wait for DC open or 15s timeout.
  await Promise.race([
    dcOpenPromise,
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error('DC never opened')), 15_000)),
  ]).catch((err) => { record.notes = `dc-open-failed: ${(err as Error).message}`; });

  if (!dc) {
    record.notes ||= 'no dc';
    try { await browser.close(); } catch { /* noop */ }
    try { wss.close(); } catch { /* noop */ }
    return record;
  }

  // Drain a moment for ICE to stabilise.
  await new Promise((r) => setTimeout(r, 250));

  // High-rate burst loop on the server side.
  const t0 = performance.now();
  let next = t0;
  while (performance.now() - t0 < DURATION_MS) {
    samplePayload.serverTick = record.serverSentTotal + 1;
    samplePayload.serverSendPerfNow = performance.now();
    const buf = packr.pack(samplePayload);
    let sent = false;
    try {
      sent = dc.sendMessageBinary(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    } catch {
      record.serverSendThrew += 1;
    }
    if (sent) {
      record.serverSentTotal += 1;
      const ba = dc.bufferedAmount();
      if (ba > record.serverMaxBufferedAmount) record.serverMaxBufferedAmount = ba;
    } else {
      record.serverSendReturnedFalse += 1;
    }
    next += SEND_INTERVAL_MS;
    const wait = Math.max(0, next - performance.now());
    await new Promise((r) => setTimeout(r, wait));
  }

  // Let the client drain the wire.
  await new Promise((r) => setTimeout(r, 750));

  record.clientReceivedTotal = await page.evaluate(() => (window as any).__spike?.receivedCount ?? 0);
  record.lossPct = Math.round(
    (1 - record.clientReceivedTotal / Math.max(1, record.serverSentTotal)) * 1000,
  ) / 10;
  record.notes ||=
    record.serverSentTotal === 0
      ? 'server never sent anything'
      : record.lossPct < 5
        ? 'OK — wire delivers'
        : `${record.lossPct}% loss server→client`;

  try { dc.close(); } catch { /* noop */ }
  try { pc?.close(); } catch { /* noop */ }
  try { await browser.close(); } catch { /* noop */ }
  try { wss.close(); } catch { /* noop */ }

  return record;
}

async function main(): Promise<void> {
  console.log('[high-rate-spike] ordered:true reliable:true');
  const reliable = await runConfig(true, null);
  console.log('[high-rate-spike] ordered:false maxRetransmits:0 (UDP-semantics)');
  const unreliable = await runConfig(false, 0);

  const out = {
    reliable,
    unreliable,
    diagnosis:
      reliable.lossPct < 5 && unreliable.lossPct < 5
        ? 'WIRE OK — loss in Phase 4 must be in our integration (SectorRoom / SnapshotBroadcaster / routing / decode pipeline).'
        : reliable.lossPct >= 5 && unreliable.lossPct < 5
          ? 'RELIABLE MODE LOSSY — investigate library-side reliable-mode flow control.'
          : unreliable.lossPct >= 5 && reliable.lossPct < 5
            ? 'UNRELIABLE MODE LOSSY — investigate node-datachannel unreliable send semantics.'
            : 'BOTH LOSSY — wire-level bug; node-datachannel or its Chromium interop has a high-rate send issue.',
  };

  const outFile = join(OUT_DIR, 'P4-high-rate-spike.json');
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('[high-rate-spike] wrote', outFile);
  console.log('[high-rate-spike] reliable:', {
    sent: reliable.serverSentTotal,
    recv: reliable.clientReceivedTotal,
    loss: `${reliable.lossPct}%`,
  });
  console.log('[high-rate-spike] unreliable:', {
    sent: unreliable.serverSentTotal,
    recv: unreliable.clientReceivedTotal,
    loss: `${unreliable.lossPct}%`,
  });
  console.log('[high-rate-spike] diagnosis:', out.diagnosis);

  setTimeout(() => process.exit(0), 250).unref();
}

main().catch((err) => {
  console.error('[high-rate-spike] fatal:', err);
  process.exit(2);
});

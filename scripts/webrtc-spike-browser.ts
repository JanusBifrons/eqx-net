/**
 * Phase 0 step 3 spike — Browser ↔ node-datachannel.
 *
 * Replaces the plan's "open chrome://about, paste offer in DevTools" with a
 * fully-automated Playwright run: spins up a tiny ws signaling server backed
 * by node-datachannel on the Node side, then launches Chromium against a
 * data: URL that runs the WHATWG RTCPeerConnection API client-side.
 *
 * What this proves:
 *   1. node-datachannel's RTCPeerConnection (W3C-polyfill side) interops with
 *      a real browser's RTCPeerConnection (Chromium 131-ish via Playwright).
 *   2. ICE candidate trickle works over a hand-rolled ws signaling channel.
 *   3. 1 KB binary message round-trips byte-exact.
 *   4. The connection comes up over LAN (no STUN, no TURN) — the production
 *      path's host-candidate baseline.
 *   5. The plan's restrictive-network worry (#14) only needs TURN when both
 *      peers are NAT'd; on the LAN we expect host candidates to suffice.
 *
 * Run:  pnpm tsx scripts/webrtc-spike-browser.ts
 * Output: diag/measurements/2026-05-30-imperative-taco-webrtc/P0-spike-browser-output.json
 *
 * Plan: swift-otter (Phase 0).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { RTCPeerConnection } from 'node-datachannel/polyfill';

interface BrowserSpikeRecord {
  startedAt: string;
  ok: boolean;
  step: string;
  signalingPort: number;
  iceGatheringMsServer: number;
  handshakeMs: number;
  roundTripMs: number;
  payloadBytes: number;
  payloadMatches: boolean;
  selectedCandidateTypeServer: string | null;
  selectedCandidateTypeBrowser: string | null;
  errors: string[];
}

const OUT_DIR = join(
  process.cwd(),
  'diag',
  'measurements',
  '2026-05-30-imperative-taco-webrtc',
);
mkdirSync(OUT_DIR, { recursive: true });

async function startSignaling(port: number, onPeer: (send: (msg: unknown) => void, onMsg: (cb: (msg: any) => void) => void) => void) {
  const wss = new WebSocketServer({ port });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  wss.on('connection', (sock) => {
    const send = (msg: unknown) => sock.send(JSON.stringify(msg));
    const listeners: ((m: any) => void)[] = [];
    sock.on('message', (data) => {
      let parsed: any;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      for (const fn of listeners) fn(parsed);
    });
    onPeer(send, (cb) => listeners.push(cb));
  });
  return wss;
}

async function runServerPeer(send: (m: unknown) => void, onMsg: (cb: (m: any) => void) => void, record: BrowserSpikeRecord): Promise<{ dc: any; pc: any; received: Promise<Uint8Array>; iceGatheringMs: number }> {
  const pc = new RTCPeerConnection({ iceServers: [] });

  let gatheringStart = performance.now();
  pc.addEventListener('icegatheringstatechange', () => {
    if (pc.iceGatheringState === 'complete') {
      record.iceGatheringMsServer = Math.round(performance.now() - gatheringStart);
    }
  });
  pc.addEventListener('icecandidate', (e: any) => {
    if (e.candidate) send({ kind: 'ice', candidate: e.candidate });
    else send({ kind: 'ice-end' });
  });

  let dcResolve: (dc: any) => void;
  const dcPromise = new Promise<any>((r) => (dcResolve = r));
  pc.addEventListener('datachannel', (e: any) => dcResolve(e.channel));

  onMsg(async (msg) => {
    if (msg.kind === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ kind: 'answer', sdp: pc.localDescription!.sdp });
    } else if (msg.kind === 'ice') {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch (err) {
        record.errors.push(`server addIceCandidate: ${(err as Error).message}`);
      }
    }
  });

  const dc = await Promise.race([
    dcPromise,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('server datachannel timeout')), 10_000)),
  ]) as any;

  const received: Promise<Uint8Array> = new Promise((resolve) => {
    dc.addEventListener('message', (e: any) => {
      const d = e.data;
      if (d instanceof ArrayBuffer) resolve(new Uint8Array(d));
      else if (d instanceof Uint8Array) resolve(d);
      else if (Buffer.isBuffer(d)) resolve(new Uint8Array(d));
      else resolve(new Uint8Array());
    });
  });

  return { dc, pc, received, iceGatheringMs: record.iceGatheringMsServer };
}

const BROWSER_PAGE = (port: number) => `<!DOCTYPE html>
<html><head><title>spike</title></head><body>
<script>
(async () => {
  const ws = new WebSocket('ws://127.0.0.1:${port}');
  const send = (m) => ws.send(JSON.stringify(m));
  const log = (msg) => { (window).__spikeLog ??= []; (window).__spikeLog.push(msg); };
  const result = { ok: false, errors: [] };
  (window).__spikeResult = result;
  try {
    await new Promise((r) => ws.onopen = r);
    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel('spike', { ordered: true });
    let receivedAt = null;
    let receivedBytes = -1;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      log('dc-open');
      const payload = new Uint8Array(1024);
      for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
      result.tSend = performance.now();
      dc.send(payload);
    };
    dc.onmessage = (e) => {
      receivedAt = performance.now();
      const view = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : new Uint8Array();
      receivedBytes = view.byteLength;
      let matches = view.byteLength === 1024;
      if (matches) for (let i = 0; i < 1024; i++) if (view[i] !== (i & 0xff)) { matches = false; break; }
      result.payloadMatches = matches;
      result.roundTripMs = receivedAt - result.tSend;
      result.ok = matches;
    };
    pc.onicecandidate = (e) => { if (e.candidate) send({ kind: 'ice', candidate: e.candidate.toJSON() }); };
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

    pc.addEventListener('iceconnectionstatechange', () => log('ice:' + pc.iceConnectionState));
    pc.addEventListener('connectionstatechange', async () => {
      log('conn:' + pc.connectionState);
      if (pc.connectionState === 'connected') {
        const stats = await pc.getStats();
        stats.forEach((s) => {
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
            const local = stats.get(s.localCandidateId);
            const remote = stats.get(s.remoteCandidateId);
            result.selectedCandidateTypeBrowser = (local?.candidateType ?? '?') + '/' + (remote?.candidateType ?? '?');
          }
        });
      }
    });
  } catch (err) {
    result.errors.push(String(err && err.message || err));
  }
})();
</script>
</body></html>`;

async function main(): Promise<void> {
  const port = 35711;
  const record: BrowserSpikeRecord = {
    startedAt: new Date().toISOString(),
    ok: false,
    step: 'init',
    signalingPort: port,
    iceGatheringMsServer: 0,
    handshakeMs: 0,
    roundTripMs: 0,
    payloadBytes: 1024,
    payloadMatches: false,
    selectedCandidateTypeServer: null,
    selectedCandidateTypeBrowser: null,
    errors: [],
  };

  let wss: any;
  let browser: any;

  const t0 = performance.now();
  try {
    record.step = 'signaling';
    let serverPeerResolve: ((v: any) => void) | undefined;
    const serverPeerPromise = new Promise<any>((r) => (serverPeerResolve = r));
    wss = await startSignaling(port, (send, onMsg) => {
      runServerPeer(send, onMsg, record).then(serverPeerResolve).catch((err) => {
        record.errors.push('serverPeer: ' + (err as Error).message);
        serverPeerResolve?.(null);
      });
    });

    record.step = 'browser-launch';
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') record.errors.push('browser-console: ' + msg.text());
    });

    record.step = 'goto-spike-page';
    const html = BROWSER_PAGE(port);
    await page.setContent(html, { waitUntil: 'load' });

    record.step = 'wait-server-peer';
    const serverPeer = await Promise.race([
      serverPeerPromise,
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error('server peer never connected')), 15_000)),
    ]);
    if (!serverPeer) throw new Error('server peer setup failed');

    record.step = 'wait-server-msg';
    const serverMsg = await Promise.race([
      serverPeer.received as Promise<Uint8Array>,
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error('server never received message')), 15_000)),
    ]);
    if (!serverMsg) throw new Error('server message never arrived');

    record.step = 'echo-back';
    // Echo the same payload back so the browser side has its own RTT.
    (serverPeer.dc as any).send(serverMsg);

    record.step = 'wait-browser-rtt';
    await page.waitForFunction(() => (window as any).__spikeResult?.ok === true, {}, { timeout: 10_000 });

    const browserResult = await page.evaluate(() => (window as any).__spikeResult);
    record.roundTripMs = Math.round((browserResult.roundTripMs ?? 0) * 1000) / 1000;
    record.payloadMatches = !!browserResult.payloadMatches;
    record.selectedCandidateTypeBrowser = browserResult.selectedCandidateTypeBrowser ?? null;
    if (browserResult.errors?.length) record.errors.push(...browserResult.errors.map((s: string) => 'browser:' + s));

    record.handshakeMs = Math.round(performance.now() - t0);

    // Snapshot the server-side selected candidate type via getStats() if the
    // polyfill supports it.
    try {
      const stats = await (serverPeer.pc as any).getStats();
      if (stats && typeof stats.forEach === 'function') {
        stats.forEach((s: any) => {
          if (s.type === 'candidate-pair' && (s.state === 'succeeded' || s.nominated)) {
            record.selectedCandidateTypeServer = `${s.localCandidateType ?? '?'}/${s.remoteCandidateType ?? '?'}`;
          }
        });
      }
    } catch (err) {
      record.errors.push('serverGetStats: ' + (err as Error).message);
    }

    record.ok = record.payloadMatches && record.errors.length === 0;
  } catch (err) {
    record.errors.push('main: ' + (err as Error).message);
  } finally {
    try { await browser?.close(); } catch { /* noop */ }
    try { wss?.close(); } catch { /* noop */ }
  }

  const outFile = join(OUT_DIR, 'P0-spike-browser-output.json');
  writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log('[spike-browser] wrote', outFile);
  console.log('[spike-browser] summary:', {
    ok: record.ok,
    step: record.step,
    handshakeMs: record.handshakeMs,
    rttMs: record.roundTripMs,
    matches: record.payloadMatches,
    errors: record.errors.length,
  });

  setTimeout(() => process.exit(record.ok ? 0 : 1), 250).unref();
}

main().catch((err) => {
  console.error('[spike-browser] fatal:', err);
  process.exit(2);
});

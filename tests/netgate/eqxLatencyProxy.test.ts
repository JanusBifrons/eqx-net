/**
 * Phase 1 / Mechanism 2 (plan: e2e-rebuild) — the full HTTP+WS reverse
 * proxy, integration-tested at the level it lives (real sockets).
 *
 * HOSTILE F1: colyseus.js derives the matchmake/auth REST endpoint from
 * the SAME host:port as the WS (Client.js:211-220). So `VITE_WS_URL`
 * pointed at this proxy means BOTH transports traverse it. A WS-only
 * pipe would HTTP-POST `joinOrCreate` into a socket that doesn't speak
 * HTTP → no room join → zero stats → the whole gate collapses. This
 * proxy therefore MUST:
 *   - reverse-proxy HTTP REST to upstream, UNDELAYED (join/auth latency
 *     is not what the gate measures; steady-state is);
 *   - relay the WS upgrade with a deterministic jittered delay, ORDERED
 *     (TCP/WS byte order MUST be preserved or framing breaks — jitter
 *     widens gaps, never reorders).
 *
 * RED today: the module does not exist. The level is "real bytes over
 * real local sockets" — a node integration test, exactly where the F1
 * defect would live (a unit test of the relay class would not catch the
 * HTTP-passthrough requirement).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, connect as netConnect, type Server as NetServer } from 'node:net';
import { EqxLatencyProxy } from './eqxLatencyProxy';
import { PROFILE_PRIMARY } from './latencyProfile';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function listenHttp(handler: (body: string) => string): Promise<{ srv: HttpServer; port: number }> {
  return new Promise((resolve) => {
    const srv = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const out = handler(body);
        // Explicit Content-Length ⇒ no chunked framing (matches a real
        // colyseus matchmake response and keeps the raw test parser simple).
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-length': Buffer.byteLength(out),
          connection: 'close',
        });
        res.end(out);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: (srv.address() as { port: number }).port }));
  });
}

/** Minimal upstream that consumes the proxy's rewritten upgrade request
 *  (everything up to the blank line) then echoes all subsequent bytes. */
function listenWsEcho(): Promise<{ srv: NetServer; port: number }> {
  return new Promise((resolve) => {
    const srv = createNetServer((sock) => {
      let sawHeaderEnd = false;
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        if (sawHeaderEnd) {
          sock.write(d); // echo payload
          return;
        }
        buf = Buffer.concat([buf, d]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx >= 0) {
          sawHeaderEnd = true;
          const rest = buf.subarray(idx + 4);
          sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
          if (rest.length) sock.write(rest); // echo any payload that rode in
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: (srv.address() as { port: number }).port }));
  });
}

describe('EqxLatencyProxy — HTTP REST passthrough (the F1 fix)', () => {
  it('reverse-proxies an HTTP POST to upstream and returns the body UNDELAYED', async () => {
    const up = await listenHttp((body) => `echo:${body}`);
    cleanups.push(() => new Promise<void>((r) => up.srv.close(() => r())));
    const proxy = new EqxLatencyProxy({ listenPort: 0, upstreamPort: up.port, profile: PROFILE_PRIMARY });
    await proxy.listen();
    cleanups.push(() => proxy.close());

    const t0 = Date.now();
    const body = await new Promise<string>((resolve, reject) => {
      const req = netHttpPost(proxy.port, '/matchmake/joinOrCreate/feel-test-25', 'HELLO', resolve);
      req.on('error', reject);
    });
    const elapsed = Date.now() - t0;
    expect(body).toBe('echo:HELLO');
    expect(elapsed).toBeLessThan(100); // NOT delayed by the ~60ms one-way profile
  });
});

describe('EqxLatencyProxy — WS upgrade relay (deterministic, ordered, bidirectional)', () => {
  it('round-trips bytes through the WS path, intact and IN ORDER, clearly delayed', async () => {
    const up = await listenWsEcho();
    cleanups.push(() => new Promise<void>((r) => up.srv.close(() => r())));
    const proxy = new EqxLatencyProxy({ listenPort: 0, upstreamPort: up.port, profile: PROFILE_PRIMARY });
    await proxy.listen();
    cleanups.push(() => proxy.close());

    const received = await new Promise<{ data: string; elapsed: number }>((resolve, reject) => {
      const sock = netConnect(proxy.port, '127.0.0.1', () => {
        sock.write(
          'GET /2567/room?sessionId=x HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${proxy.port}\r\n` +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let acc = '';
      let payloadStart = 0;
      const t0 = Date.now();
      sock.on('data', (d) => {
        acc += d.toString('latin1');
        const hdr = acc.indexOf('\r\n\r\n');
        if (hdr >= 0 && payloadStart === 0) {
          payloadStart = hdr + 4;
          // fire the three ordered chunks once the 101 is through
          sock.write('A');
          sock.write('B');
          sock.write('C');
        }
        const payload = payloadStart ? acc.slice(payloadStart) : '';
        if (payload === 'ABC') resolve({ data: payload, elapsed: Date.now() - t0 });
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(acc)}`)), 5000);
    });

    expect(received.data).toBe('ABC'); // intact + in order (no byte reorder)
    expect(received.elapsed).toBeGreaterThanOrEqual(50); // the jittered delay was applied
  });
});

/** Tiny raw HTTP POST helper (avoids pulling in anything heavier). */
function netHttpPost(
  port: number,
  path: string,
  body: string,
  onBody: (b: string) => void,
): import('node:net').Socket {
  const sock = netConnect(port, '127.0.0.1', () => {
    sock.write(
      `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  });
  let acc = '';
  sock.on('data', (d) => (acc += d.toString('utf8')));
  sock.on('close', () => {
    const i = acc.indexOf('\r\n\r\n');
    onBody(i >= 0 ? acc.slice(i + 4) : '');
  });
  return sock;
}

/**
 * Full HTTP + WS reverse proxy with a deterministic, ORDERED, jittered
 * WS delay — Phase-1 / Mechanism 2 (plan: e2e-rebuild). Standalone Node;
 * NO Vite / Playwright / src-server imports (boundary invariant #1).
 *
 * Why HTTP too (hostile F1): colyseus.js derives the matchmake/auth REST
 * endpoint from the same host:port as the WS (`Client.js:211-220`).
 * `VITE_WS_URL` pointed here ⇒ BOTH transports traverse this proxy. HTTP
 * REST is reverse-proxied UNDELAYED (join/auth latency is not the gate's
 * subject; steady-state is). The WS upgrade is relayed with a seeded
 * jittered delay, delivered IN ORDER (TCP/WS byte order MUST be
 * preserved or framing breaks — jitter widens gaps, never reorders).
 *
 * The WS upgrade-line rewrite mirrors the proven `vite.config.ts:32-52`
 * dev proxy byte-for-byte, so Colyseus 0.16 sees an identical handshake.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { LatencyScheduler, type Direction, type LatencyProfileSpec } from './latencyProfile';

export interface EqxLatencyProxyOptions {
  /** Port to listen on. 0 ⇒ ephemeral (read `.port` after `listen()`). */
  listenPort: number;
  /** Upstream Colyseus port (e.g. 2567). */
  upstreamPort: number;
  /** Upstream host (default 127.0.0.1). */
  upstreamHost?: string;
  /** The fixed adverse-network profile (seeded). */
  profile: LatencyProfileSpec;
}

/**
 * Per-direction relay that delays each chunk but delivers strictly in
 * arrival order: `sendAt` is monotonic (max of "now + jittered delay" and
 * the previous chunk's sendAt), so jitter only widens gaps — bytes never
 * reorder. A reorder would corrupt the WS frame stream, not model a
 * worse network.
 */
class OrderedDelayRelay {
  private lastSendAt = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly dst: Duplex,
    private readonly dir: Direction,
    private readonly sched: LatencyScheduler,
  ) {}

  push(chunk: Buffer): void {
    if (this.closed) return;
    const now = Date.now();
    const sendAt = Math.max(now + this.sched.delayFor(this.dir), this.lastSendAt);
    this.lastSendAt = sendAt;
    const wait = Math.max(0, sendAt - now);
    const copy = Buffer.from(chunk); // own the bytes (source buffer may be reused)
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.closed || !this.dst.writable) return;
      try {
        this.dst.write(copy);
      } catch {
        // Peer closed between the writable check and the delayed write
        // (e.g. Playwright closed the context mid-flight) — a delayed
        // chunk landing on a torn-down socket is expected at teardown,
        // not a proxy fault. Swallow; the socket 'error'/'close' handler
        // drives the connection cleanup.
      }
    }, wait);
    this.timers.add(t);
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

export class EqxLatencyProxy {
  private readonly server: HttpServer;
  private readonly upstreamHost: string;
  private readonly live = new Set<{ destroy(): void }>();

  constructor(private readonly opts: EqxLatencyProxyOptions) {
    this.upstreamHost = opts.upstreamHost ?? '127.0.0.1';
    this.server = createServer((req, res) => this.onHttp(req, res));
    this.server.on('upgrade', (req, socket, head) =>
      this.onUpgrade(req, socket as Socket, head),
    );
  }

  /** Actual bound port (valid after `listen()` resolves). */
  get port(): number {
    const a = this.server.address();
    return a && typeof a !== 'string' ? (a as AddressInfo).port : this.opts.listenPort;
  }

  /** HTTP REST → upstream, UNDELAYED. Makes colyseus.js joinOrCreate work. */
  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    console.error(`[eqxproxy] HTTP ${req.method} ${req.url}`);
    const upstream = httpRequest(
      {
        host: this.upstreamHost,
        port: this.opts.upstreamPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${this.upstreamHost}:${this.opts.upstreamPort}` },
      },
      (up) => {
        console.error(`[eqxproxy] HTTP ${req.method} ${req.url} -> ${up.statusCode}`);
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (e) => {
      console.error(`[eqxproxy] HTTP upstream error ${req.url}: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }

  /** WS upgrade → upstream raw socket, byte-faithful rewrite, then an
   *  ordered jittered relay each way. */
  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = req.url ?? '/';
    console.error(`[eqxproxy] WS upgrade ${url}`);
    const proxy = netConnect(this.opts.upstreamPort, this.upstreamHost);
    const sched = new LatencyScheduler(this.opts.profile);
    const c2s = new OrderedDelayRelay(proxy, 'c2s', sched);
    const s2c = new OrderedDelayRelay(socket, 's2c', sched);
    let loggedFirstS2c = false;

    proxy.once('connect', () => {
      let raw = `GET ${url} HTTP/1.1\r\nHost: ${this.upstreamHost}:${this.opts.upstreamPort}\r\n`;
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === 'host') continue;
        raw += `${k}: ${Array.isArray(v) ? v.join(', ') : String(v ?? '')}\r\n`;
      }
      raw += '\r\n';
      proxy.write(raw);
      if (head?.length) proxy.write(head);
      console.error(
        `[eqxproxy] WS upstream connected; wrote ${raw.length}b GET + ${head?.length ?? 0}b head`,
      );
    });

    socket.on('data', (d: Buffer) => c2s.push(d));
    proxy.on('data', (d: Buffer) => {
      if (!loggedFirstS2c) {
        loggedFirstS2c = true;
        console.error(
          `[eqxproxy] WS first upstream->client ${d.length}b: ${JSON.stringify(d.subarray(0, 48).toString('latin1'))}`,
        );
      }
      s2c.push(d);
    });
    // ECONNRESET/ECONNABORTED/EPIPE on a relayed socket are the expected
    // shape of a peer (browser/upstream) going away at test teardown —
    // not a proxy fault. Don't spam the gate log with them.
    const benign = (e: NodeJS.ErrnoException): boolean =>
      e.code === 'ECONNRESET' || e.code === 'ECONNABORTED' || e.code === 'EPIPE';
    proxy.on('error', (e) => {
      if (!benign(e)) console.error(`[eqxproxy] WS upstream socket error: ${e.message}`);
    });
    socket.on('error', (e) => {
      if (!benign(e)) console.error(`[eqxproxy] WS client socket error: ${e.message}`);
    });

    const entry = {
      destroy: (): void => {
        c2s.close();
        s2c.close();
        socket.destroy();
        proxy.destroy();
        this.live.delete(entry);
      },
    };
    this.live.add(entry);
    for (const ev of ['error', 'close'] as const) {
      socket.on(ev, entry.destroy);
      proxy.on(ev, entry.destroy);
    }
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onErr = (e: Error): void => reject(e);
      this.server.once('error', onErr);
      this.server.listen(this.opts.listenPort, () => {
        this.server.off('error', onErr);
        this.server.unref(); // a forgotten proxy must not wedge process exit
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const e of [...this.live]) e.destroy();
    const withClose = this.server as HttpServer & { closeAllConnections?: () => void };
    withClose.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

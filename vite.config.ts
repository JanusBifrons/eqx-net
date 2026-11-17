import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { createConnection } from 'node:net';
import type { IncomingMessage, ServerResponse, Server as NodeHttpServer } from 'node:http';
import type { Http2SecureServer } from 'node:http2';
import type { Duplex } from 'node:stream';
import { gateDecision, keyCookie } from './scripts/dev/phone-lane-core.mjs';

type HttpServer = NodeHttpServer | Http2SecureServer;

// Backend port the client server's proxy targets. Default 2567; the showcase capture
// pipeline (showcase/) sets EQX_SERVER_PORT so it can run an isolated
// server + Vite pair without colliding with a dev session on 2567/5173.
const SERVER_PORT = Number(process.env['EQX_SERVER_PORT'] ?? 2567);

// Phone lane (docs/ops/phone-link.md): when set, every request without the
// key cookie is refused before it reaches the game — this build is public
// through a Cloudflare quick tunnel. Unset everywhere else (no-op).
const PHONE_KEY = process.env['EQX_PHONE_KEY'] || undefined;

/** Backend routes the client server (dev or preview) forwards to the game server. */
const API_PROXY: Record<string, string | ProxyOptions> = {
  '/matchmake': {
    target: `http://localhost:${SERVER_PORT}`,
    changeOrigin: true,
  },
  '/auth': {
    target: `http://localhost:${SERVER_PORT}`,
    changeOrigin: true,
    bypass(req) {
      // Let Vite serve TypeScript/JS source files; proxy everything else to backend
      if (req.url?.match(/\.(ts|tsx|js|jsx|json|css|svg|png)(\?.*)?$/)) return req.url;
      return null;
    },
  },
  '/healthz': {
    target: `http://localhost:${SERVER_PORT}`,
    changeOrigin: true,
  },
  '/diag': {
    target: `http://localhost:${SERVER_PORT}`,
    changeOrigin: true,
  },
  '/dev': {
    target: `http://localhost:${SERVER_PORT}`,
    changeOrigin: true,
  },
  '/galaxy': {
    target: `http://localhost:${SERVER_PORT}`,
    changeOrigin: true,
  },
  '/push': {
    target: `http://localhost:${SERVER_PORT}`,
    changeOrigin: true,
  },
  // Living World P2 economy reads. NOTE: never add a top-level
  // `src/client/trade/` dir — its module URLs would collide with this proxy
  // (the 2026-06-14 `/galaxy` lesson).
  '/trade': {
    target: `http://localhost:${SERVER_PORT}`,
    changeOrigin: true,
  },
};

/**
 * Colyseus room WebSocket connections go to ws://<client origin>/<processId>/<roomId>?sessionId=…
 * Vite's built-in proxy config cannot reliably differentiate HTTP vs WS upgrades for the
 * same path prefix, so we proxy WS upgrades directly at the TCP level here.
 * HMR is on a separate port (24678) so those upgrades never reach this server.
 */
function attachColyseusWsProxy(httpServer: HttpServer | null): void {
  httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.headers['sec-websocket-protocol'] === 'vite-hmr') return;
    if (PHONE_KEY && gateDecision({ url: req.url, cookie: req.headers.cookie }, PHONE_KEY) === 'deny') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    const url = req.url ?? '/';
    console.log('[vite:colyseus-ws-proxy] proxying WS upgrade:', url);

    const proxy = createConnection(SERVER_PORT, '127.0.0.1');

    proxy.once('connect', () => {
      let raw = `GET ${url} HTTP/1.1\r\nHost: localhost:${SERVER_PORT}\r\n`;
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === 'host') continue;
        raw += `${k}: ${Array.isArray(v) ? v.join(', ') : String(v ?? '')}\r\n`;
      }
      raw += '\r\n';
      proxy.write(raw);
      if (head?.length) proxy.write(head);
    });

    socket.pipe(proxy);
    proxy.pipe(socket);

    const cleanup = (): void => { socket.destroy(); proxy.destroy(); };
    socket.on('error', cleanup);
    proxy.on('error', (err) => { console.error('[vite:colyseus-ws-proxy] proxy error:', err.message); cleanup(); });
    socket.on('close', cleanup);
    proxy.on('close', cleanup);
  });
}

/** The phone-lane key gate for HTTP (WS upgrades are gated in attachColyseusWsProxy). */
function phoneGate(): Plugin {
  const gate = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (!PHONE_KEY) return next();
    const verdict = gateDecision({ url: req.url, cookie: req.headers.cookie }, PHONE_KEY);
    if (verdict === 'deny') {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end("EQX Peri phone link: open today's link (it carries the key).");
      return;
    }
    if (verdict === 'pass+cookie') res.setHeader('Set-Cookie', keyCookie(PHONE_KEY));
    next();
  };
  return {
    name: 'eqx-phone-gate',
    configurePreviewServer(server) { server.middlewares.use(gate); },
  };
}

export default defineConfig({
  root: 'src/client',
  publicDir: path.resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@shared-types': path.resolve(__dirname, 'src/shared-types'),
    },
  },
  plugins: [
    react(),
    {
      // Colyseus room WS upgrades, dev and preview alike (see attachColyseusWsProxy).
      name: 'colyseus-ws-proxy',
      configureServer(server) {
        attachColyseusWsProxy(server.httpServer);
      },
      configurePreviewServer(server) {
        attachColyseusWsProxy(server.httpServer);
      },
    },
    phoneGate(),
    // PWA — installable manifest + a Workbox service worker (precache the app
    // shell so launch is instant + the app installs to the home screen, which
    // is what unlocks Web Push on iOS). See docs/architecture/web-push.md.
    //
    // `registerType: 'prompt'` (NOT 'autoUpdate') is load-bearing: 'autoUpdate'
    // injects skipWaiting + clientsClaim + an auto-reload, which would force a
    // mid-session reload AND risk the new SW claiming the running page and
    // serving freshly-hashed code-split chunks (incl. the Pixi render worker)
    // that mismatch the loaded app. 'prompt' leaves the new SW WAITING; it
    // activates on the next full launch. We register it silently (no prompt UI
    // — see main.tsx), which is exactly "auto-update, apply on next launch".
    //
    // The SW is PRODUCTION-ONLY (`devOptions.enabled: false`), so Playwright +
    // the netgate (both run against `vite dev`) never see it — zero test/gate
    // interference. The custom push + notificationclick handlers ride in via
    // `workbox.importScripts(['push-sw.js'])` (public/push-sw.js), avoiding an
    // injectManifest setup + extra workbox-* deps.
    VitePWA({
      registerType: 'prompt',
      injectRegister: null, // registered explicitly in src/client/main.tsx
      // The phone gate refuses a cookie-less manifest fetch (it holds the key).
      useCredentials: Boolean(PHONE_KEY),
      manifest: {
        name: 'EQX Peri',
        short_name: 'EQX Peri',
        description: 'Multiplayer space combat in a hex galaxy.',
        // Phone lane: the installed app starts WITH the key (an iOS home-screen
        // app has its own cookie jar, so Safari's cookie never reaches it).
        start_url: PHONE_KEY ? `/?k=${PHONE_KEY}` : '/',
        display: 'fullscreen',
        orientation: 'any',
        background_color: '#05070f',
        theme_color: '#05070f',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Pixi + rapier chunks exceed the 2 MB Workbox default; bump the cap so
        // the whole app shell precaches. Content-hashed assets are safe to keep
        // forever; `cleanupOutdatedCaches` prunes superseded revisions.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 6_000_000,
        cleanupOutdatedCaches: true,
        // Keep the SPA navigation fallback OFF the proxied API/WS routes — the
        // SW must never serve index.html for an /auth, /push, /galaxy… request.
        navigateFallbackDenylist: [/^\/(matchmake|auth|galaxy|diag|dev|healthz|push|trade)/],
        // Custom push handlers (push + notificationclick) live in
        // public/push-sw.js, imported into the generated SW at root scope.
        importScripts: ['push-sw.js'],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    // Bind to 0.0.0.0 so the dev server is reachable from phones on the LAN.
    // Look for the printed "Network:" URL in the dev console.
    host: true,
    // Default 24678 (unchanged for normal dev). The netcode-health gate
    // runs TWO dev servers at once and never edits files mid-run, so it
    // sets VITE_HMR_PORT=off to disable HMR entirely on BOTH arms —
    // eliminating the 24678 collision as a symmetric, zero-noise source
    // (an asymmetric broken-HMR arm would skew the comparison).
    hmr:
      process.env['VITE_HMR_PORT'] === 'off'
        ? false
        : { port: Number(process.env['VITE_HMR_PORT'] ?? 24678) },
    proxy: API_PROXY,
  },
  // `vite preview` (a production build) gets the same API + WS bridge, so a
  // build is playable through one origin (the phone lane, docs/ops/phone-link.md).
  preview: {
    proxy: API_PROXY,
    allowedHosts: ['.trycloudflare.com'],
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  // The OffscreenCanvas render worker (`render/worker/WorkerRendererClient.ts`)
  // is instantiated as an ES-module worker (`new Worker(url, { type: 'module' })`)
  // and pulls in pixi.js, so its production bundle requires code-splitting.
  // Vite's default `worker.format` is `iife`, which rejects code-splitting
  // ("UMD and IIFE output formats are not supported for code-splitting
  // builds") and also mismatches the `type: 'module'` runtime. `es` matches
  // the runtime and supports the shared chunks. Dev already serves the worker
  // as ESM, so this only affects `pnpm run build`.
  worker: {
    format: 'es',
  },
});

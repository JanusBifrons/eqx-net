import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { createConnection } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

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
      // Colyseus room WebSocket connections go to ws://localhost:5173/<processId>/<roomId>?sessionId=…
      // Vite's built-in proxy config cannot reliably differentiate HTTP vs WS upgrades for the
      // same path prefix, so we proxy WS upgrades directly at the TCP level here.
      // HMR is on a separate port (24678) so those upgrades never reach this server.
      name: 'colyseus-ws-proxy',
      configureServer(server) {
        server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          if (req.headers['sec-websocket-protocol'] === 'vite-hmr') return;

          const url = req.url ?? '/';
          console.log('[vite:colyseus-ws-proxy] proxying WS upgrade:', url);

          const proxy = createConnection(2567, '127.0.0.1');

          proxy.once('connect', () => {
            let raw = `GET ${url} HTTP/1.1\r\nHost: localhost:2567\r\n`;
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
      },
    },
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
      manifest: {
        name: 'EQX Peri',
        short_name: 'EQX Peri',
        description: 'Multiplayer space combat in a hex galaxy.',
        start_url: '/',
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
        navigateFallbackDenylist: [/^\/(matchmake|auth|galaxy|diag|dev|healthz|push)/],
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
    proxy: {
      '/matchmake': {
        target: 'http://localhost:2567',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:2567',
        changeOrigin: true,
        bypass(req) {
          // Let Vite serve TypeScript/JS source files; proxy everything else to backend
          if (req.url?.match(/\.(ts|tsx|js|jsx|json|css|svg|png)(\?.*)?$/)) return req.url;
          return null;
        },
      },
      '/healthz': {
        target: 'http://localhost:2567',
        changeOrigin: true,
      },
      '/diag': {
        target: 'http://localhost:2567',
        changeOrigin: true,
      },
      '/dev': {
        target: 'http://localhost:2567',
        changeOrigin: true,
      },
      '/galaxy': {
        target: 'http://localhost:2567',
        changeOrigin: true,
      },
      '/push': {
        target: 'http://localhost:2567',
        changeOrigin: true,
      },
    },
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

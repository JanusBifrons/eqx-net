import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
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
  ],
  server: {
    port: 5173,
    hmr: { port: 24678 },
    proxy: {
      '/matchmake': {
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
});

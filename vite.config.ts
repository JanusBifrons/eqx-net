import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: 'src/client',
  publicDir: path.resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@shared-types': path.resolve(__dirname, 'src/shared-types'),
    },
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Colyseus WebSocket endpoint in dev. Changes to Phase 1 server port
      // propagate here and to env.VITE_WS_URL for prod builds.
      '/ws': {
        target: 'ws://localhost:2567',
        ws: true,
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

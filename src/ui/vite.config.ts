import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI lives in src/ui and is built into src/ui/dist, which the Fastify
// server serves as static assets with an SPA fallback.
export default defineConfig({
  root: __dirname,
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: process.env.CRICNEX_API ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
});

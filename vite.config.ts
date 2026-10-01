import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.PORT ?? 3001}`,
      '/unsubscribe': process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.PORT ?? 3001}`,
    },
  },
  build: { sourcemap: false },
});

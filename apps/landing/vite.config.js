import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5275, proxy: { '/api': 'http://127.0.0.1:3100' } },
  build: { sourcemap: false },
});

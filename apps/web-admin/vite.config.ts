import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Bound explicitly to the loopback IPv4 address: `localhost` resolves to
    // ::1 first on this machine, and a dev server should not be reachable
    // from the network by accident.
    host: '127.0.0.1',
    port: 5175,
    // The API is same-origin through this proxy in development, so the browser
    // never makes a cross-origin request and no CORS allowlist is needed here.
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});

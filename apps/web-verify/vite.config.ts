import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    /**
     * Loopback by default: `localhost` resolves to ::1 first on this machine,
     * and a dev server should not be reachable from the network by accident.
     *
     * `DEV_HOST=0.0.0.0` opens it to the LAN, which is what testing a QR scan
     * needs — the member app has to be on a phone the verification page's
     * camera can point at. Opt-in, and never the default, because this serves
     * seeded member data.
     */
    host: process.env['DEV_HOST'] ?? '127.0.0.1',
    port: 5174,
    // The API is same-origin through this proxy in development, so the browser
    // never makes a cross-origin request and no CORS allowlist is needed here.
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    /**
     * Loopback by default: `localhost` resolves to ::1 first on this machine, and
     * a dev server should not be reachable from the network by accident.
     *
     * `DEV_HOST=0.0.0.0` opens it to the LAN, which is what testing a scan needs —
     * this screen has to be on the tablet whose camera points at a phone showing
     * the member card. Opt-in, and never the default, because this serves seeded
     * member data.
     *
     * **A LAN address is not enough for the camera.** `getUserMedia` refuses
     * outside a secure context: `localhost` counts, `http://192.168.x.x` does not.
     * So scanning over the LAN needs TLS, and the scanner says so rather than
     * showing a dead black rectangle. Typing the membership number always works.
     */
    host: process.env['DEV_HOST'] ?? '127.0.0.1',
    port: 5176,
    // The API is same-origin through this proxy in development, so the browser
    // never makes a cross-origin request and no CORS allowlist is needed here.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});

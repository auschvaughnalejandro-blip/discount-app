import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    /**
     * Installable member app — Stage 23.
     *
     * A member adds this to their home screen and it launches as an app: own
     * icon, no browser chrome, works without a signal. The admin dashboard and
     * the verification page get none of this deliberately — staff sit at a PC or
     * a counter tablet and open a URL.
     */
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],

      manifest: {
        name: 'Privilege Guest',
        short_name: 'Privilege',
        description: 'Your Privilege Guest membership, benefits and digital card.',
        // Standalone, not fullscreen: the status bar stays, which members expect
        // when they want the time or their signal mid-dinner.
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        // Matches theme.css. The splash screen and the Android status bar are
        // tinted from these, so a mismatch shows as a flash of the wrong colour
        // on every launch.
        background_color: '#0d1420',
        theme_color: '#0d1420',
        lang: 'en',
        dir: 'ltr', // Stage 22 switches this for Arabic.
        categories: ['lifestyle', 'travel'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          // Maskable keeps the diamond inside the safe area, so a launcher that
          // crops to a circle does not slice it.
          { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],

        /**
         * Caching rules — and the one that matters most is a *refusal* to cache.
         *
         * The identity payload rotates every 60 seconds and the server checks
         * its freshness. A cached one is a credential that fails at a spa
         * reception with no useful error: the member sees a QR, staff see a
         * rejection, and nothing on screen explains why. So it is NetworkOnly
         * explicitly, rather than relying on it not matching a pattern by luck.
         */
        runtimeCaching: [
          { urlPattern: /\/api\/member\/me\/identity-code$/, handler: 'NetworkOnly' },
          // Auth must never be served from a cache either.
          { urlPattern: /\/api\/auth\//, handler: 'NetworkOnly' },
          {
            /**
             * Benefit content, cached for offline reading. A member in a
             * restaurant basement with no signal should still be able to show
             * staff the terms — that is the paper sheet's one advantage over an
             * app, and losing it would be a downgrade.
             *
             * NetworkFirst, not CacheFirst: R14 means an administrator changing
             * a percentage must reach members without a deployment, so the
             * network wins whenever it is reachable and the cache is a fallback
             * rather than the default.
             */
            urlPattern: /\/api\/benefits$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'benefits',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // The member's own profile and history, same reasoning.
            urlPattern: /\/api\/member\/me(\/redemptions)?$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'member-profile',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],

        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },

      devOptions: {
        // Off in development: a service worker caching a dev bundle is the most
        // confusing class of "my change didn't apply" bug there is.
        enabled: false,
      },
    }),
  ],
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
    port: 5173,
    // The API is same-origin through this proxy in development, so the browser
    // never makes a cross-origin request and no CORS allowlist is needed here.
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});

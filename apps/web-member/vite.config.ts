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
     * the administrator panel gets none of this deliberately — administrators sit at a PC or
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
        background_color: '#221c1b',
        theme_color: '#221c1b',
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
         * Caching rules — and the ones that matter most are *refusals* to cache.
         *
         * A benefit request and its approval state are the two things a member
         * must never read from a cache: a stale "approved" would send someone to
         * a spa counter expecting a discount that was declined an hour ago, and
         * nothing on screen would explain why.
         */
        runtimeCaching: [
          { urlPattern: /\/api\/member\/me\/requests$/, handler: 'NetworkOnly' },
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
            /**
             * The member's own profile and history, same reasoning — with one
             * extra consideration the benefits rule does not have.
             *
             * The history is written by an *outlet*, at the counter, after this
             * app loaded. So the member's copy can be wrong while the member is
             * standing there looking at it, and a cached response would keep it
             * wrong. `api.redemptions(true)` therefore asks with a query string,
             * and the `$` below is what lets that through: a URL carrying a
             * search string does not match this pattern, so it never reaches
             * this cache and always goes to the network.
             *
             * Dropping the `$` would silently restore the stale history this was
             * written to prevent. `client-invariants.test.ts` holds it.
             */
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
     * `DEV_HOST=0.0.0.0` opens it to the LAN, which is what opening the member
     * app on a real phone needs — the one thing a laptop browser cannot tell
     * you about a phone-first app. Opt-in, and never the default, because this
     * serves seeded member data.
     */
    host: process.env['DEV_HOST'] ?? '127.0.0.1',
    port: 5173,
    // The API is same-origin through this proxy in development, so the browser
    // never makes a cross-origin request and no CORS allowlist is needed here.
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});

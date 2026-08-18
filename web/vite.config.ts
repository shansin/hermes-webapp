import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'node:path';

/**
 * The PWA layer is built but dormant on plain HTTP: browsers only register a
 * service worker (and only offer install / push) on a secure context. Adding
 * TLS later activates all of it with no code change — see README.
 */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: {
    host: true, // listen on the LAN so the phone can hit the dev server
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', ws: true, changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      /**
       * No `manualChunks` for recharts or the markdown pipeline any more.
       * Grouping them by hand produced separate *files* that were still
       * reached by a static import from the entry, so Vite emitted a
       * `modulepreload` for both and the phone downloaded every byte before
       * first paint — the opposite of the intent. The routes in `App.tsx` are
       * `React.lazy` now, so Rollup splits along the dynamic-import boundaries
       * and each chunk loads on the navigation that needs it.
       */
      output: {
        /**
         * Mermaid splits itself into ~40 chunks — one per diagram type, plus
         * cytoscape, katex, dagre and friends — under opaque hashed names like
         * `chunk-2GRJ4B5K`. Emitting them into their own directory gives the
         * service worker a stable way to exclude them from precache (see
         * `globIgnores`), instead of maintaining a list of names that changes
         * with every mermaid release.
         */
        chunkFileNames(chunk) {
          const fromDiagrams = chunk.moduleIds.some((id) =>
            // Deliberately not `d3`: recharts depends on it too, and pulling it
            // in here would move the Hub's charts out of precache as well.
            /node_modules\/(\.pnpm\/)?(mermaid|cytoscape|katex|dagre|@mermaid-js)/.test(id),
          );
          return fromDiagrams ? 'assets/diagrams/[name]-[hash].js' : 'assets/[name]-[hash].js';
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Dev-mode SW registration off: it only confuses the HTTP dev loop.
      devOptions: { enabled: false },
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Hermes Control',
        short_name: 'Hermes',
        description: 'Phone-first control center for the Hermes Agent',
        theme_color: '#0b0b0f',
        background_color: '#0b0b0f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        categories: ['productivity', 'developer'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'New Chat', short_name: 'Chat', url: '/chat?new=1' },
          { name: 'Voice', short_name: 'Voice', url: '/chat?new=1&voice=1' },
          { name: 'Kanban', short_name: 'Board', url: '/kanban' },
        ],
        // Android share sheet → straight into a new chat.
        share_target: {
          action: '/chat',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      },
      workbox: {
        /**
         * The `push` / `notificationclick` / `pushsubscriptionchange`
         * listeners. `generateSW` builds the whole worker from this config and
         * offers no hook to add code, so they are imported from a hand-written
         * file in `public/` — see the comment at the top of `push-sw.js`.
         */
        importScripts: ['push-sw.js'],
        /**
         * Take control of the page that registered us, instead of waiting for
         * the next navigation. Without this the first load is uncontrolled, so
         * nothing populates the runtime caches — install the app, lose
         * connectivity, open it, and the session list fails with "Couldn't
         * load" because its only chance to cache never happened.
         */
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        /**
         * Mermaid ships one lazy chunk per diagram type — architecture,
         * swimlanes, cynefin, plus cytoscape and katex — and together they are
         * larger than the rest of the app. Precaching them would quadruple what
         * an install downloads to make diagrams nobody has asked for available
         * offline. They stay network-loaded, and `runtimeCaching` below keeps
         * whichever ones actually get used.
         */
        // `push-sw.js` is imported by the worker itself, so precaching it
        // would have the worker cache a copy of its own source and serve a
        // stale one after an update.
        globIgnores: ['**/assets/diagrams/**', '**/push-sw.js'],
        navigateFallback: '/index.html',
        // Never let the SW answer an API call from cache by accident.
        navigateFallbackDenylist: [/^\/api/, /^\/healthz/, /^\/push/],
        runtimeCaching: [
          {
            // Session history is the one thing worth reading offline.
            urlPattern: /\/api\/sessions\/[^/]+\/messages/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'hermes-session-history',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            // The diagram chunks excluded from precache above: cache each one
            // the first time a diagram actually needs it.
            urlPattern: /\/assets\/diagrams\/.*\.js$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'hermes-lazy-chunks',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /\/api\/(sessions|skills|cron|plugins\/kanban)\b.*$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'hermes-lists',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
    }),
  ],
});

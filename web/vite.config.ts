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
        /**
         * Every parameter here has to be one a screen actually reads. `Voice`
         * used to sit in this list pointing at `/chat?new=1&voice=1`; nothing
         * consumed `voice`, so the shortcut opened an ordinary new chat and
         * the mic stayed exactly where it always was. A menu entry that
         * quietly does something other than what it says is worse than no
         * entry — `test/deepLinks.test.ts` now fails if one is added back.
         */
        shortcuts: [
          { name: 'New Chat', short_name: 'Chat', url: '/chat?new=1' },
          { name: 'Kanban', short_name: 'Board', url: '/kanban' },
        ],
        /**
         * Android share sheet → straight into a new chat, photos included.
         *
         * `POST` + `multipart/form-data` is not a preference: it is the only
         * form of share target that can carry files. The cost is that the
         * browser posts a document request at `/share`, which a single-page
         * app cannot receive — `public/share-sw.js` intercepts it in the
         * service worker and redirects to `/chat?new=1&share=<id>`.
         *
         * Consequences worth knowing before changing this:
         *  - It only works in an installed PWA over HTTPS, because it is the
         *    service worker that answers. See the Tailscale section in README.
         *  - iOS does not implement Web Share Target at all, so nothing here
         *    reaches an iPhone. The composer's paperclip remains the path
         *    there, and it already opens the photo library.
         */
        share_target: {
          action: '/share',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                // Mirrors the composer's own file input: images go to the
                // gateway as vision tiles, the rest land in the workspace.
                accept: ['image/*', 'text/*', 'application/pdf'],
              },
            ],
          },
        },
      },
      workbox: {
        /**
         * The `push` / `notificationclick` / `pushsubscriptionchange`
         * listeners, and the share-target `fetch` handler. `generateSW` builds
         * the whole worker from this config and offers no hook to add code, so
         * they are imported from hand-written files in `public/` — see the
         * comments at the top of `push-sw.js` and `share-sw.js`.
         */
        importScripts: ['push-sw.js', 'share-sw.js'],
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
        // The imported scripts are pulled in by the worker itself, so
        // precaching them would have the worker cache a copy of its own source
        // and serve a stale one after an update.
        globIgnores: ['**/assets/diagrams/**', '**/push-sw.js', '**/share-sw.js'],
        navigateFallback: '/index.html',
        /**
         * Never let the SW answer an API call from cache by accident. `/share`
         * is here for a different reason: `share-sw.js` handles that POST
         * itself, and Workbox must not race it with an index.html from
         * precache.
         */
        navigateFallbackDenylist: [/^\/api/, /^\/healthz/, /^\/push/, /^\/share/],
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

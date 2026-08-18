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
      output: {
        // Keep the charting library out of the initial bundle — the Hub is the
        // only screen that needs it, and the phone should paint chat fast.
        manualChunks: {
          charts: ['recharts'],
          markdown: ['react-markdown', 'remark-gfm', 'rehype-highlight'],
        },
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
        globIgnores: ['**/assets/diagrams/**'],
        navigateFallback: '/index.html',
        // Never let the SW answer an API call from cache by accident.
        navigateFallbackDenylist: [/^\/api/, /^\/healthz/],
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

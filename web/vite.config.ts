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
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
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

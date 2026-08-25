import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { visualizer } from 'rollup-plugin-visualizer';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/**
 * A stamp identifying this build, baked into the bundle and written beside it.
 *
 * It exists to answer one question that was previously unanswerable from the
 * outside: *is the browser running the code we last deployed?* A phone holds
 * the app in a service worker precache, so a tab can serve a build from days
 * ago while every server-side symptom says the fix is live. Diagnosing that
 * meant grepping the built bundle for a string and comparing asset hashes by
 * hand.
 *
 * Minute precision, because it is read by a person comparing two values on a
 * screen, not by a machine. The short SHA rides along when git is available —
 * the timestamp says *when*, the SHA says *what*, and only the second one
 * survives being rebuilt from an unchanged tree.
 */
function buildStamp(): string {
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return `${when} ${sha}${dirty ? '+' : ''}`;
  } catch {
    // Not a git checkout, or git is absent. The timestamp alone still
    // identifies the build well enough to compare two of them.
    return when;
  }
}

const BUILD_ID = buildStamp();

/**
 * Write the same stamp into `dist/`, so the server can report what it is
 * *serving* while the bundle reports what the browser is *running*. Those two
 * being different is exactly the stale-service-worker case, and it is only
 * detectable because the value is recorded in both places.
 */
function emitBuildStamp() {
  return {
    name: 'hermes-build-stamp',
    closeBundle() {
      writeFileSync(
        resolve(__dirname, 'dist', 'build.json'),
        JSON.stringify({ id: BUILD_ID }) + '\n',
      );
    },
  };
}

/**
 * The PWA layer is built but dormant on plain HTTP: browsers only register a
 * service worker (and only offer install / push) on a secure context. Adding
 * TLS later activates all of it with no code change — see README.
 */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
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
    emitBuildStamp(),
    react(),
    /**
     * Behind a flag, because it is a diagnostic and not part of a deploy.
     *
     * `ANALYZE=1 pnpm build` writes `web/dist/stats.html` — a treemap of what
     * ended up in each chunk and which module put it there. Off by default:
     * it costs build time, and `start.sh` builds on every launch.
     *
     * The reason it exists at all is that every size decision in this config
     * was previously argued from a guess. The `manualChunks` note above is the
     * cautionary tale — a change made to shrink the entry that measurably
     * enlarged what the phone downloaded before first paint, and which took a
     * hand-read of the emitted HTML to notice. `pnpm size` prints the numbers;
     * this says who is responsible for them.
     */
    ...(process.env.ANALYZE
      ? [
          visualizer({
            filename: resolve(__dirname, 'dist', 'stats.html'),
            template: 'treemap',
            gzipSize: true,
            brotliSize: true,
          }),
        ]
      : []),
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
        // `cf_login` is load-bearing: it is how the app hands a navigation back
        // to Cloudflare Access. Without it here, `navigateFallback` answers the
        // reload out of the precache and the login redirect never happens.
        navigateFallbackDenylist: [/^\/api/, /^\/healthz/, /^\/push/, /^\/share/, /[?&]cf_login=/],
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
            /**
             * This route swallows an expired Cloudflare Access session.
             *
             * NetworkFirst falls back to the cache on a network *error*, and a
             * cross-origin bounce to the Access login page is exactly that: the
             * `fetch` rejects, Workbox catches it, and `api/client.ts` is handed
             * a cheerful cached 200 instead of the failure it probes on. So the
             * REST side of the expiry detection in `lib/accessSession.ts` cannot
             * fire for these reads at all, and the authority is the gateway
             * socket — the WS handshake is not a `fetch` and nothing caches it.
             *
             * Two things do still reach the app, which is why this is a gap and
             * not a hole: a 401/403 is a real response, so Workbox returns it
             * rather than the cache, and the route matches GET only, so every
             * write still rejects and still probes.
             *
             * Narrowing this to un-mask the reads would trade a detection path
             * the socket already covers for the offline session list, which is
             * the whole reason the route exists.
             */
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

/**
 * Test runner configuration.
 *
 * Two projects, because the two halves of this repo run in different worlds:
 * the proxy is Node (fs, zlib, ws) and the app is a browser (jsdom, React).
 * A single environment would force one of them to be faked, and the things
 * most worth testing here — static file serving, service-worker behaviour —
 * are exactly the things that fake would hide.
 */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          root: resolve(__dirname, 'server'),
          environment: 'node',
          include: ['test/**/*.test.ts'],
          // The proxy's stores are module-level singletons keyed to a state
          // directory, so two files mutating them in one process would see
          // each other's writes. A fresh worker per file keeps them honest.
          isolate: true,
          pool: 'forks',
        },
      },
      {
        test: {
          name: 'web',
          root: resolve(__dirname, 'web'),
          environment: 'jsdom',
          include: ['test/**/*.test.{ts,tsx}'],
          setupFiles: ['test/setup.ts'],
          globals: false,
        },
        resolve: {
          alias: { '@': resolve(__dirname, 'web/src') },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['server/src/**/*.ts', 'web/src/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', 'web/src/main.tsx'],
    },
  },
});

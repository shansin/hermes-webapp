/**
 * What the phone actually downloads, and whether it grew.
 *
 * Bundle size had no observability at all here: no analyzer, no report, no
 * budget. The one size decision on record (`manualChunks`, see the note in
 * `vite.config.ts`) was made by reasoning, shipped, and turned out to have
 * done the opposite of what it intended — which was only discovered by
 * reading the emitted HTML by hand. This is the cheap version of never doing
 * that again.
 *
 * Two things it reports, and the second is the point:
 *
 *  - Every emitted chunk over a threshold, gzipped, because gzip is what
 *    crosses the wire and raw byte counts overstate JavaScript by ~3×.
 *  - The **eager** total — the entry plus everything statically reachable from
 *    it, i.e. everything Vite emits a `modulepreload` for. That is the number
 *    that decides how long a phone stares at a blank screen, and it is the one
 *    a well-meaning refactor can inflate without changing any single chunk
 *    enough to notice.
 *
 * Budgets fail the command, so this can go in CI. They are set a little above
 * where things stand rather than at some ideal: a budget's job is to catch a
 * step change, and one that is already breached teaches everyone to ignore it.
 *
 *   node web/scripts/size.mjs          # report
 *   node web/scripts/size.mjs --json   # machine-readable
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/**
 * Budgets, in gzipped kilobytes.
 *
 * `eager` is the one that matters; `chunk` catches a single dependency
 * landing somewhere unexpected. Raise them deliberately, in the same commit
 * as the growth, with the reason in the message.
 */
const BUDGET = { eager: 190, chunk: 260 };

/** Files under 4KB gzipped are noise in a report meant to be read. */
const FLOOR = 4 * 1024;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

if (!existsSync(DIST)) {
  console.error('No web/dist — run `pnpm build` first.');
  process.exit(1);
}

const html = existsSync(join(DIST, 'index.html'))
  ? readFileSync(join(DIST, 'index.html'), 'utf8')
  : '';

/**
 * Everything the browser is told to fetch before it runs anything: the entry
 * script plus every `modulepreload`. Read out of the HTML rather than inferred
 * from the module graph, because the HTML is the actual instruction the phone
 * receives — and the last time these two disagreed, the inference was the half
 * that was wrong.
 */
const eagerNames = new Set(
  [...html.matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]),
);

const files = walk(DIST)
  .filter((f) => /\.(js|css)$/.test(f))
  .map((path) => {
    const buf = readFileSync(path);
    const name = relative(DIST, path).replaceAll('\\', '/');
    return {
      name,
      raw: buf.length,
      gzip: gzipSync(buf).length,
      eager: eagerNames.has(name),
      // Mermaid's chunks are excluded from the service worker precache and
      // only fetched by a transcript that contains a diagram, so they are
      // reported apart rather than counted against anything.
      diagrams: name.startsWith('assets/diagrams/'),
    };
  })
  .sort((a, b) => b.gzip - a.gzip);

const eagerTotal = files.filter((f) => f.eager).reduce((n, f) => n + f.gzip, 0);
const diagramTotal = files.filter((f) => f.diagrams).reduce((n, f) => n + f.gzip, 0);
const lazyTotal = files
  .filter((f) => !f.eager && !f.diagrams)
  .reduce((n, f) => n + f.gzip, 0);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ eagerTotal, lazyTotal, diagramTotal, files }, null, 2));
} else {
  console.log('');
  console.log('  gzip      raw       chunk');
  console.log('  ────────  ────────  ─────────────────────────────────────────');
  for (const f of files) {
    if (f.gzip < FLOOR) continue;
    const tag = f.eager ? ' ‹eager›' : f.diagrams ? ' ‹diagram›' : '';
    console.log(`  ${kb(f.gzip).padEnd(8)}  ${kb(f.raw).padEnd(8)}  ${f.name}${tag}`);
  }
  console.log('');
  console.log(`  Eager (before first paint): ${kb(eagerTotal)} gzipped`);
  console.log(`  Lazy routes and chunks:     ${kb(lazyTotal)} gzipped`);
  console.log(`  Diagrams (never precached): ${kb(diagramTotal)} gzipped`);
  console.log('');
}

const over = [];
if (eagerTotal > BUDGET.eager * 1024) {
  over.push(`eager total ${kb(eagerTotal)} exceeds the ${BUDGET.eager} KB budget`);
}
for (const f of files) {
  if (f.diagrams) continue;
  if (f.gzip > BUDGET.chunk * 1024) {
    over.push(`${f.name} is ${kb(f.gzip)}, over the ${BUDGET.chunk} KB per-chunk budget`);
  }
}

if (over.length) {
  console.error('Bundle budget exceeded:');
  for (const line of over) console.error(`  - ${line}`);
  console.error('\nRaise the budget in web/scripts/size.mjs only with the reason in the commit.');
  process.exit(1);
}

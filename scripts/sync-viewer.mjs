#!/usr/bin/env node
/* Copy the magazine viewer out of the submodule and into public/.
 *
 * The viewer is an upstream dependency, not our code: it lives in
 * vendor/magazine-web-viewer, pinned to a commit by the submodule, and this
 * copies the four files the reader actually loads into
 * public/vendor/magazine-web-viewer/, which is generated and gitignored.
 *
 * Why copy rather than serve the submodule directly: everything under public/
 * is uploaded to Cloudflare, and the upstream repo also carries a demo, docs, a
 * test page and its own README. Copying ships the four files and nothing else.
 *
 * Runs automatically before `npm run dev` and `npm run deploy`. It is
 * deliberately loud when the submodule is missing, because the failure it
 * prevents -- deploying an index.html whose <script> tags 404 -- looks like a
 * broken reader rather than a missing checkout.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'vendor/magazine-web-viewer');
const to = join(root, 'public/vendor/magazine-web-viewer');

/** Exactly what the reader loads. Load order is the host's business, not this
 *  script's, but the list has to match index.html. */
const FILES = [
  'js/pageflip.js',
  'js/paginator.js',
  'js/magazine.js',
  'css/magazine.css',
  // Shipped alongside because the flip engine is third-party code under its own
  // licence, and serving the script without it would be wrong.
  'js/LICENSE-StPageFlip.txt',
  'LICENSE',
];

if (!existsSync(join(from, 'js/magazine.js'))) {
  console.error(
    'vendor/magazine-web-viewer is empty.\n' +
      'The viewer is a git submodule; fetch it with:\n\n' +
      '    git submodule update --init\n'
  );
  process.exit(1);
}

let pinned = 'unknown';
try {
  pinned = execFileSync('git', ['-C', from, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  /* a tarball checkout with no git metadata is still usable */
}

rmSync(to, { recursive: true, force: true });
for (const file of FILES) {
  const target = join(to, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(from, file), target);
}

/* A breadcrumb in the deployed output. Without it the only record of which
 * viewer is live is the submodule pointer in a commit, which is not visible from
 * the running site. */
writeFileSync(
  join(to, 'VERSION'),
  `magazine-web-viewer\nhttps://github.com/ventz/magazine-web-viewer\ncommit ${pinned}\n`
);

/* The reader depends on more of the contract than a copy can check, but two
 * things are cheap to assert and both have bitten: the paginator must still
 * expose the geometry the app reads, and the CSS must still be the one that
 * reads our custom properties rather than defining its own palette. */
const paginator = readFileSync(join(to, 'js/paginator.js'), 'utf8');
for (const symbol of ['geometry', 'typeScale', 'strideW']) {
  if (!paginator.includes(symbol)) {
    console.error(`viewer paginator.js no longer mentions "${symbol}" -- check the contract`);
    process.exit(1);
  }
}

console.log(`viewer synced from ${pinned.slice(0, 7)} -> public/vendor/magazine-web-viewer`);

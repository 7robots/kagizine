import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/* The tests run inside workerd, not Node.
 *
 * That is not a preference. The sanitiser is built on HTMLRewriter and the
 * content-addressing on crypto.subtle, both runtime APIs; a Node harness could
 * only test a reimplementation of the thing that matters, and the point of these
 * tests is the security boundary in src/kagi/feed.ts.
 *
 * `cloudflareTest` is the vitest-4 entry point. Older guides use
 * `defineWorkersConfig` from '@cloudflare/vitest-pool-workers/config', which no
 * longer exists -- that specifier fails at config load with 'Missing "./config"
 * specifier'.
 *
 * The wrangler config is reused so the tests see the same compatibility date and
 * bindings as production.
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['test/**/*.test.ts'],
  },
});

/* R2, against a real bucket provided by the test pool.
 *
 * `prune` is the only code in the project that destroys data, so its refusals
 * matter more than its deletions. Each of the three guards here corresponds to a
 * way it previously deleted pictures that were still referenced.
 */

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Article, Edition } from '../src/kagi/feed';
import * as store from '../src/kagi/store';
import * as fx from './fixtures';

const bucket = env.EDITIONS;
const NOW = '2026-08-10T12:00:00+00:00';

/** Far enough ahead that anything written during the test looks old, so the
 *  grace window is not what a deletion test is really measuring. */
const LATER = Date.parse('2026-09-01T00:00:00Z');

function edition(date: string, assets: string[]): Edition {
  return {
    schema_version: 1,
    date,
    title: `Kagi News, ${date}`,
    weekday: 'Monday',
    source_url: 'https://news.kagi.com/',
    cover_asset: assets[0] ?? null,
    sections: [{ title: 'World', slug: 'world', article_ids: assets.map((_, i) => `world/a${i}`) }],
    built_from: fx.BUILT,
  };
}

function articles(assets: string[]): Record<string, Article> {
  return Object.fromEntries(
    assets.map((asset, i) => [
      `world/a${i}`,
      {
        id: `world/a${i}`,
        slug: `a${i}`,
        title: `A${i}`,
        dek: null,
        rubric: 'World',
        section_slug: 'world',
        source_url: 'https://x.test/a',
        published: null,
        word_count: 100,
        blocks: [
          {
            id: 'b0000',
            kind: 'figure' as const,
            asset,
            alt: '',
            caption: null,
            credit: null,
            width: 400,
            height: 300,
            role: 'hero',
          },
        ],
        sources: [],
        audio_asset: null,
      },
    ])
  );
}

async function seed(date: string, assets: string[]) {
  for (const asset of assets) {
    await store.putImage(bucket, asset, fx.png(400, 300), 'image/png');
  }
  const day = { edition: edition(date, assets), articles: articles(assets) };
  await store.putJson(bucket, store.editionKey(date), day);
  await store.upsertIndex(bucket, day.edition, assets.length, NOW);
}

async function wipe() {
  for (const prefix of ['img/', 'editions/', 'reports/', 'index.json']) {
    await store.deleteKeys(bucket, await store.listKeys(bucket, prefix));
  }
}

beforeEach(wipe);

describe('storing and reading', () => {
  it('round-trips an edition', async () => {
    await seed('2026-08-10', ['aaa.png']);
    const day = await store.getJson<store.StoredDay>(bucket, store.editionKey('2026-08-10'));
    expect(day?.edition.date).toBe('2026-08-10');
  });

  it('stores a picture once and skips the rewrite', async () => {
    await store.putImage(bucket, 'same.png', fx.png(400, 300), 'image/png');
    const first = await bucket.head(store.imageKey('same.png'));
    await store.putImage(bucket, 'same.png', fx.png(400, 300), 'image/png');
    const second = await bucket.head(store.imageKey('same.png'));
    expect(second!.uploaded.getTime()).toBe(first!.uploaded.getTime());
  });

  it('records the immutable cache header on a picture', async () => {
    await store.putImage(bucket, 'cache.png', fx.png(400, 300), 'image/png');
    const object = await bucket.head(store.imageKey('cache.png'));
    expect(object!.httpMetadata?.cacheControl).toContain('immutable');
  });

  it('keeps the index newest first', async () => {
    await seed('2026-08-08', ['a.png']);
    await seed('2026-08-10', ['b.png']);
    await seed('2026-08-09', ['c.png']);
    const index = await store.readIndex(bucket);
    expect(index.editions.map((e) => e.date)).toEqual(['2026-08-10', '2026-08-09', '2026-08-08']);
  });

  it('replaces rather than duplicates an edition already in the index', async () => {
    await seed('2026-08-10', ['a.png']);
    await seed('2026-08-10', ['a.png', 'b.png']);
    const index = await store.readIndex(bucket);
    expect(index.editions).toHaveLength(1);
    expect(index.editions[0]!.article_count).toBe(2);
  });
});

describe('pruning', () => {
  it('drops editions past the retention window', async () => {
    await seed('2026-08-08', ['a.png']);
    await seed('2026-08-09', ['b.png']);
    await seed('2026-08-10', ['c.png']);

    const result = await store.prune(bucket, NOW, 2, LATER);
    expect(result.editions_removed).toEqual(['2026-08-08']);
    expect((await store.readIndex(bucket)).editions.map((e) => e.date)).toEqual([
      '2026-08-10',
      '2026-08-09',
    ]);
    expect(await bucket.head(store.editionKey('2026-08-08'))).toBeNull();
  });

  it('collects a picture no retained edition references', async () => {
    await seed('2026-08-10', ['kept.png']);
    await store.putImage(bucket, 'orphan.png', fx.png(400, 300), 'image/png');

    const result = await store.prune(bucket, NOW, 14, LATER);
    expect(result.images_removed).toBe(1);
    expect(await bucket.head(store.imageKey('orphan.png'))).toBeNull();
    expect(await bucket.head(store.imageKey('kept.png'))).not.toBeNull();
  });

  it('spares a picture written moments ago', async () => {
    // Closes the race between a concurrent refresh's putImage and its putJson:
    // in that window the new pictures are referenced by nothing at all.
    await seed('2026-08-10', ['kept.png']);
    await store.putImage(bucket, 'justnow.png', fx.png(400, 300), 'image/png');

    const result = await store.prune(bucket, NOW, 14, Date.now());
    expect(result.images_removed).toBe(0);
    expect(await bucket.head(store.imageKey('justnow.png'))).not.toBeNull();
  });

  it('collects nothing when a retained edition will not read back', async () => {
    // Previously this deleted every picture of the unreadable day, leaving an
    // edition pointing at objects that no longer existed.
    await seed('2026-08-10', ['a.png', 'b.png']);
    await seed('2026-08-09', ['c.png']);
    await store.deleteKeys(bucket, [store.editionKey('2026-08-09')]); // still in the index

    const result = await store.prune(bucket, NOW, 14, LATER);
    expect(result.collection_skipped).toMatch(/2026-08-09/);
    expect(result.images_removed).toBe(0);
    for (const asset of ['a.png', 'b.png', 'c.png']) {
      expect(await bucket.head(store.imageKey(asset))).not.toBeNull();
    }
  });

  it('collects nothing when the index is empty', async () => {
    // An index that failed to load is not evidence that nothing is referenced.
    await store.putImage(bucket, 'lonely.png', fx.png(400, 300), 'image/png');

    const result = await store.prune(bucket, NOW, 14, LATER);
    expect(result.collection_skipped).toMatch(/no retained editions/);
    expect(await bucket.head(store.imageKey('lonely.png'))).not.toBeNull();
  });

  it('keeps a picture shared between two editions when one is dropped', async () => {
    await seed('2026-08-09', ['shared.png']);
    await seed('2026-08-10', ['shared.png']);

    await store.prune(bucket, NOW, 1, LATER);
    expect(await bucket.head(store.imageKey('shared.png'))).not.toBeNull();
  });
});

describe('listing', () => {
  it('returns every key under a prefix', async () => {
    for (const n of [1, 2, 3]) {
      await store.putImage(bucket, `k${n}.png`, fx.png(400, 300 + n), 'image/png');
    }
    expect((await store.listKeys(bucket, 'img/')).sort()).toEqual([
      'img/k1.png',
      'img/k2.png',
      'img/k3.png',
    ]);
  });

  it('tolerates an empty prefix', async () => {
    expect(await store.listKeys(bucket, 'nothing/')).toEqual([]);
  });
});

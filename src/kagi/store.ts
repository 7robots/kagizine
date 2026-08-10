/* The R2 layer.
 *
 * Layout in the bucket, unchanged from the Python implementation so that
 * editions already stored stay readable:
 *
 *   index.json            every stored edition, newest first
 *   editions/<date>.json  one day: {"edition": {...}, "articles": {...}}
 *   reports/<date>.json   what the refresh did, for reading after the fact
 *   img/<sha256>.<ext>    pictures, content-addressed
 *
 * The bucket is the source of truth; index.json is derived from it and can be
 * rebuilt by listing editions/.
 */

import type { Article, Edition } from './feed';

export const INDEX_KEY = 'index.json';

/** Editions retained before pruning. Two weeks is enough to catch up after a
 *  holiday without the bucket growing without bound. */
export const KEEP_EDITIONS = 14;

export interface IndexEntry {
  date: string;
  title: string;
  weekday: string | null;
  cover_asset: string | null;
  article_count: number;
  section_count: number;
}

export interface StoredDay {
  edition: Edition;
  articles: Record<string, Article>;
}

export const editionKey = (date: string) => `editions/${date}.json`;
export const reportKey = (date: string) => `reports/${date}.json`;
export const imageKey = (asset: string) => `img/${asset}`;

const JSON_TYPE = 'application/json; charset=utf-8';

// ------------------------------------------------------------------- writing

export async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: JSON_TYPE },
  });
}

/**
 * Store a picture, skipping the write if those exact bytes are already there.
 *
 * Keys are content hashes, so an object that exists is by definition the same
 * picture -- and most days repeat at least a few. `head` is far cheaper than
 * re-uploading half a megabyte.
 */
export async function putImage(
  bucket: R2Bucket,
  asset: string,
  data: Uint8Array,
  mime: string
): Promise<void> {
  const key = imageKey(asset);
  if (await bucket.head(key)) return;
  await bucket.put(key, data as unknown as ArrayBuffer, {
    httpMetadata: {
      contentType: mime,
      // Content-addressed, so a stored object never changes and the header can
      // say so. This is what the served response echoes.
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });
}

// ------------------------------------------------------------------- reading

export async function getText(bucket: R2Bucket, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  return object ? object.text() : null;
}

export async function getJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? ((await object.json()) as T) : null;
}

// --------------------------------------------------------------------- index

export async function readIndex(bucket: R2Bucket): Promise<{ editions: IndexEntry[] }> {
  return (await getJson<{ editions: IndexEntry[] }>(bucket, INDEX_KEY)) ?? { editions: [] };
}

export function indexEntry(edition: Edition, articleCount: number): IndexEntry {
  return {
    date: edition.date,
    title: edition.title,
    weekday: edition.weekday ?? null,
    cover_asset: edition.cover_asset ?? null,
    article_count: articleCount,
    section_count: edition.sections.length,
  };
}

export async function writeIndex(
  bucket: R2Bucket,
  entries: IndexEntry[],
  generatedAt: string
): Promise<void> {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1));
  await putJson(bucket, INDEX_KEY, { generated_at: generatedAt, editions: sorted });
}

/** Add or replace one edition in the index, newest first. */
export async function upsertIndex(
  bucket: R2Bucket,
  edition: Edition,
  articleCount: number,
  generatedAt: string
): Promise<IndexEntry[]> {
  const index = await readIndex(bucket);
  const entries = index.editions.filter((e) => e.date !== edition.date);
  entries.push(indexEntry(edition, articleCount));
  entries.sort((a, b) => (a.date < b.date ? 1 : -1));
  await writeIndex(bucket, entries, generatedAt);
  return entries;
}

// ------------------------------------------------------------------- pruning

/**
 * Every key under a prefix, following R2's pagination.
 *
 * R2 truncates a listing at 1000 objects and hands back a cursor. Ignoring that
 * is the bug that makes a collector delete pictures it merely failed to see, so
 * the loop is not optional.
 */
export async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const listing = await bucket.list({ prefix, limit: 1000, cursor });
    for (const object of listing.objects) keys.push(object.key);
    if (!listing.truncated) return keys;
    cursor = listing.cursor;
  }
}

export async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  // R2's delete takes up to 1000 keys at a time.
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }
}

/**
 * Drop editions past the retention window, then collect orphaned pictures.
 *
 * Order matters: the surviving editions are what define which pictures are
 * still referenced, so the index has to be trimmed before anything is
 * collected.
 */
export async function prune(
  bucket: R2Bucket,
  generatedAt: string,
  keep = KEEP_EDITIONS
): Promise<{ editions_removed: string[]; images_removed: number }> {
  const index = await readIndex(bucket);
  const entries = [...index.editions].sort((a, b) => (a.date < b.date ? 1 : -1));
  const keeping = entries.slice(0, keep);
  const dropping = entries.slice(keep);

  for (const entry of dropping) {
    await deleteKeys(bucket, [editionKey(entry.date), reportKey(entry.date)]);
  }
  if (dropping.length) await writeIndex(bucket, keeping, generatedAt);

  // Which pictures are still spoken for.
  const live = new Set<string>();
  for (const entry of keeping) {
    const day = await getJson<StoredDay>(bucket, editionKey(entry.date));
    if (!day) continue;
    if (day.edition.cover_asset) live.add(imageKey(day.edition.cover_asset));
    for (const article of Object.values(day.articles)) {
      for (const block of article.blocks) {
        if (block.kind === 'figure') live.add(imageKey(block.asset));
      }
    }
  }

  const orphans = (await listKeys(bucket, 'img/')).filter((key) => !live.has(key));
  await deleteKeys(bucket, orphans);

  return { editions_removed: dropping.map((e) => e.date), images_removed: orphans.length };
}

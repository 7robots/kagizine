/* Assembling one day's edition.
 *
 * The only module that sequences work, and it still does no I/O of its own: the
 * caller injects `fetchBytes` and `putImage`. That keeps the shape of the build
 * independent of R2 and of the network.
 */

import * as F from './feed';
import * as I from './images';

/** Concurrent subrequests. A Worker caps simultaneous outbound connections and
 *  an edition wants around thirty-five of them; six at a time finishes in about
 *  the same wall-clock as firing them all and cannot trip the limit. */
export const CONCURRENCY = 6;

/** The smallest thing we are willing to call a lead picture.
 *
 *  A floor in *bytes* was the obvious guard and the wrong one: it rejects a
 *  small but legitimate graphic while happily accepting a 1x1 spacer that
 *  happens to be padded. Dimensions say what we actually mean -- this has to
 *  work as the picture at the top of a story, and as the cover. */
export const MIN_WIDTH = 200;
export const MIN_HEIGHT = 100;

/** Below this there is not even a header to read. */
export const MIN_BYTES = 64;

export type FetchBytes = (url: string) => Promise<{ data: Uint8Array; contentType: string | null }>;
export type PutImage = (asset: string, data: Uint8Array, mime: string) => Promise<void>;
export type IsCurrent = (date: string, builtFrom: string) => Promise<boolean>;

/** Raised before any picture is fetched when the feeds have not been rebuilt.
 *
 *  That timing is the point: the cron fires twice a day to cover the
 *  Eastern-time DST shift, and the firing that finds nothing new should cost
 *  four requests rather than thirty-five. */
export class Unchanged extends Error {
  constructor(
    readonly date: string,
    readonly builtFrom: string
  ) {
    super(`edition ${date} already built from ${builtFrom}`);
    this.name = 'Unchanged';
  }
}

export interface Report {
  feeds: { slug: string; url: string; built_at: string | null; items: number; kept: number }[];
  failures: { feed: string; error: string }[];
  warnings: string[];
  edition_date?: string;
  articles?: number;
  sections?: number;
  pictures?: number;
  image_retries?: number;
  feeds_ms?: number;
  images_ms?: number;
  articles_ms?: number;
  started_at?: string;
  finished_at?: string;
}

/** Run tasks `limit` at a time, preserving input order.
 *
 *  Takes factories rather than promises so nothing starts until a slot is free:
 *  a promise created and left waiting is an unhandled rejection in the making. */
export async function gatherLimited<T>(
  factories: (() => Promise<T>)[],
  limit = CONCURRENCY
): Promise<(T | Error)[]> {
  const results: (T | Error)[] = new Array(factories.length);
  let next = 0;

  const worker = async () => {
    while (next < factories.length) {
      const index = next++;
      try {
        results[index] = await factories[index]!();
      } catch (error) {
        // One failure must not sink the edition.
        results[index] = error instanceof Error ? error : new Error(String(error));
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, factories.length) }, () => worker())
  );
  return results;
}

interface Picked {
  fields: F.ItemFields;
  section: F.FeedSpec;
  imageUrl: string | null;
  alt: string;
  image?: F.StoredImage | null;
}

export async function buildEdition(
  fetchBytes: FetchBytes,
  putImage: PutImage,
  feeds: F.FeedSpec[] = F.FEEDS,
  isCurrent?: IsCurrent
): Promise<{ edition: F.Edition; articles: Record<string, F.Article>; report: Report }> {
  const report: Report = { feeds: [], failures: [], warnings: [] };
  let clock = Date.now();

  // --- the feeds themselves, all at once --------------------------------
  const documents = await gatherLimited(
    feeds.map((feed) => async () => {
      const { data } = await fetchBytes(feed.url);
      return new TextDecoder().decode(data);
    })
  );

  const channels: (F.Channel | null)[] = documents.map((document, index) => {
    const feed = feeds[index]!;
    if (document instanceof Error) {
      report.failures.push({ feed: feed.slug, error: document.message });
      return null;
    }
    try {
      return F.parseChannel(document);
    } catch (error) {
      report.failures.push({ feed: feed.slug, error: String((error as Error).message ?? error) });
      return null;
    }
  });

  const date = F.editionDate(channels.map((c) => c?.builtAt ?? null));
  if (!date) throw new Error('no feed reported a lastBuildDate; refusing to guess the date');

  const builtFrom = channels.reduce<string>(
    (latest, channel) => (channel?.builtAt && channel.builtAt > latest ? channel.builtAt : latest),
    ''
  );
  report.feeds_ms = Date.now() - clock;

  // Nothing new upstream: stop here, before the expensive half.
  if (isCurrent && (await isCurrent(date, builtFrom))) throw new Unchanged(date, builtFrom);

  // --- pick the items, in reading order ---------------------------------
  const picked: Picked[] = [];
  const seen = new Set<string>();

  for (const [index, feed] of feeds.entries()) {
    const channel = channels[index];
    if (!channel) continue;
    let kept = 0;
    for (const fields of channel.items) {
      if (!fields.title) continue;
      const key = F.slugify(fields.title);
      if (seen.has(key)) {
        // The same cluster can appear in two feeds (a US story in World). The
        // first section in reading order keeps it.
        report.warnings.push(`${feed.slug}: skipped duplicate of '${fields.title}'`);
        continue;
      }
      seen.add(key);
      const described = await F.describe(fields.description);
      const { url, alt } = F.leadImage(described);
      picked.push({ fields, section: feed, imageUrl: url, alt });
      kept += 1;
    }
    report.feeds.push({
      slug: feed.slug,
      url: feed.url,
      built_at: channel.builtAt,
      items: channel.items.length,
      kept,
    });
  }

  if (!picked.length) throw new Error('every feed failed or was empty');

  // --- the pictures -----------------------------------------------------
  clock = Date.now();
  const stats = { retries: 0 };
  const wanted = picked.filter((p) => p.imageUrl);
  const stored = await gatherLimited(
    wanted.map((p) => () => fetchImage(fetchBytes, putImage, p.imageUrl!, stats))
  );

  wanted.forEach((p, index) => {
    const result = stored[index];
    if (result instanceof Error || result === null) {
      report.warnings.push(
        `${p.fields.title}: picture unavailable (${result instanceof Error ? result.message : 'unreadable'})`
      );
      p.image = null;
    } else {
      p.image = { ...(result as F.StoredImage), alt: p.alt };
    }
  });
  report.images_ms = Date.now() - clock;
  report.image_retries = stats.retries;

  // --- articles and sections -------------------------------------------
  clock = Date.now();
  const articles: Record<string, F.Article> = {};
  const sections: F.Section[] = [];
  const order = new Map(feeds.map((feed, index) => [feed.slug, index]));

  for (const p of picked) {
    const article = await F.buildArticle(p.fields, p.section, p.image ?? null);
    if (articles[article.id]) {
      // The same headline twice inside one section.
      article.slug = `${article.slug}-${Object.keys(articles).length}`;
      article.id = `${p.section.slug}/${article.slug}`;
    }
    if (article.word_count < F.STUB_WORDS) {
      report.warnings.push(`${article.id}: only ${article.word_count} words; possible stub`);
    }
    articles[article.id] = article;

    let block = sections.find((s) => s.slug === p.section.slug);
    if (!block) {
      block = { title: p.section.title, slug: p.section.slug, article_ids: [] };
      sections.push(block);
    }
    block.article_ids.push(article.id);
  }

  sections.sort((a, b) => (order.get(a.slug) ?? 99) - (order.get(b.slug) ?? 99));

  const edition: F.Edition = {
    schema_version: F.SCHEMA_VERSION,
    date,
    title: F.editionTitle(date),
    weekday: F.weekday(date),
    source_url: 'https://news.kagi.com/',
    cover_asset: F.chooseCover(sections, articles),
    sections,
    // What the feeds said when this was built. The refresh compares against it
    // to know whether there is anything new, which is what makes the two daily
    // cron firings idempotent.
    built_from: builtFrom,
  };

  report.edition_date = date;
  report.articles = Object.keys(articles).length;
  report.sections = sections.length;
  report.pictures = picked.filter((p) => p.image).length;
  // Recorded because this runs unattended: a refresh creeping towards the CPU
  // limit should be visible in the stored report rather than discovered when it
  // first fails.
  report.articles_ms = Date.now() - clock;

  return { edition, articles, report };
}

/**
 * Fetch one picture and store it under its content hash.
 *
 * Content-addressed so the same photograph appearing in two sections -- or on
 * two days -- is stored once, and so a stored object never has to be
 * invalidated: the key changes when the bytes do, which is what lets the Worker
 * serve pictures as immutable.
 *
 * One retry, because this runs unattended: a single transient failure at the
 * image proxy was observed to cost a story its picture for a whole day. Only
 * transport errors are retried -- an error page or a spacer will be identical
 * on a second look.
 */
async function fetchImage(
  fetchBytes: FetchBytes,
  putImage: PutImage,
  url: string,
  stats: { retries: number }
): Promise<F.StoredImage | null> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    let data: Uint8Array;
    try {
      ({ data } = await fetchBytes(url));
    } catch (error) {
      lastError = error;
      stats.retries += 1;
      continue;
    }

    if (!data || data.length < MIN_BYTES) return null;
    const mime = I.contentType(data);
    const size = I.dimensions(data);
    if (!mime || !size) return null; // not an image, or a format we cannot measure
    if (size.width < MIN_WIDTH || size.height < MIN_HEIGHT) return null; // a spacer or an icon

    const asset = `${await sha256Hex(data)}.${I.extension(mime)}`;
    await putImage(asset, data, mime);
    return { asset, width: size.width, height: size.height };
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Native and zero-copy: the bytes never leave the runtime's own buffers. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

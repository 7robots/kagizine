/* Assembling an edition, with the network and R2 replaced by maps.
 *
 * This is where the failure modes live: a feed that 500s, a picture that comes
 * back as an HTML error page, the same story syndicated into two sections. The
 * cron runs unattended once a day, so anything that turns a partial failure into
 * no edition at all is worth a test.
 */

import { describe, expect, it } from 'vitest';

import * as B from '../src/kagi/build';
import type { FeedSpec } from '../src/kagi/feed';
import * as fx from './fixtures';

const FEEDS: FeedSpec[] = [
  { slug: 'world', title: 'World', url: 'https://feed/world' },
  { slug: 'science', title: 'Science', url: 'https://feed/science' },
];

const IMG = 'https://img.example/one.png';

/** Stands in for fetch and for the R2 bucket. */
class Fake {
  requests: string[] = [];
  puts: string[] = [];
  stored = new Map<string, Uint8Array>();

  constructor(private responses: Map<string, Uint8Array | Error>) {}

  fetchBytes = async (url: string) => {
    this.requests.push(url);
    const value = this.responses.get(url);
    if (value === undefined) throw new Error(`404 for ${url}`);
    if (value instanceof Error) throw value;
    return { data: value, contentType: null };
  };

  putImage = async (asset: string, data: Uint8Array) => {
    this.puts.push(asset);
    this.stored.set(asset, data);
  };
}

const encode = (s: string) => new TextEncoder().encode(s);

function feedsWith(
  worldItems: string,
  scienceItems = '',
  images: Record<string, Uint8Array | Error> = {}
): Fake {
  const map = new Map<string, Uint8Array | Error>([
    ['https://feed/world', encode(fx.channel('World', fx.BUILT, worldItems))],
    ['https://feed/science', encode(fx.channel('Science', fx.BUILT, scienceItems))],
  ]);
  for (const [key, value] of Object.entries(images)) map.set(key, value);
  return new Fake(map);
}

describe('gatherLimited', () => {
  it('preserves order and caps concurrency', async () => {
    let live = 0;
    let peak = 0;
    const factories = Array.from({ length: 20 }, (_, i) => async () => {
      live += 1;
      peak = Math.max(peak, live);
      await Promise.resolve();
      live -= 1;
      return i;
    });
    expect(await B.gatherLimited(factories, 4)).toEqual([...Array(20).keys()]);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('captures a failure without sinking the batch', async () => {
    const results = await B.gatherLimited([
      async () => 'fine',
      async () => {
        throw new Error('nope');
      },
      async () => 'fine',
    ]);
    expect(results[0]).toBe('fine');
    expect(results[1]).toBeInstanceOf(Error);
    expect(results[2]).toBe('fine');
  });

  it('handles an empty list', async () => {
    expect(await B.gatherLimited([])).toEqual([]);
  });
});

describe('building an edition', () => {
  it('builds the happy path', async () => {
    const fake = feedsWith(
      fx.item('Wildfires spread', { extras: fx.FULL_EXTRAS }),
      fx.item('A new telescope', { section: 'Science', sub: 'Astronomy' }),
      { [IMG]: fx.png(1600, 900) }
    );
    const { edition, articles, report } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);

    expect(edition.date).toBe('2026-08-10');
    expect(edition.title).toBe('Kagi News, 10 August 2026');
    expect(edition.weekday).toBe('Monday');
    expect(edition.built_from).toBe(fx.BUILT);
    expect(edition.sections.map((s) => s.slug)).toEqual(['world', 'science']);
    expect(Object.keys(articles)).toHaveLength(2);
    expect(report.failures).toEqual([]);
  });

  it('takes the cover from the lead story', async () => {
    const fake = feedsWith(
      fx.item('Lead', { image: 'https://img.example/lead.png' }),
      fx.item('Second', { section: 'Science', image: 'https://img.example/two.png' }),
      {
        'https://img.example/lead.png': fx.png(1200, 800),
        'https://img.example/two.png': fx.png(400, 400),
      }
    );
    const { edition, articles } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(edition.cover_asset).toBe((articles['world/lead']!.blocks[0] as { asset: string }).asset);
  });

  it('stores identical pictures once', async () => {
    const same = fx.png(800, 600);
    const fake = feedsWith(
      fx.item('One', { image: 'https://img.example/a.png' }) +
        fx.item('Two', { image: 'https://img.example/b.png' }),
      '',
      { 'https://img.example/a.png': same, 'https://img.example/b.png': same }
    );
    const { articles } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    const assets = new Set(
      Object.values(articles).map((a) => (a.blocks[0] as { asset: string }).asset)
    );
    expect(assets.size).toBe(1);
    expect(fake.stored.size).toBe(1);
  });

  it('keeps a syndicated story once, in reading order', async () => {
    const shared = 'Shared headline';
    const fake = feedsWith(fx.item(shared), fx.item(shared, { section: 'Science' }), {
      [IMG]: fx.png(400, 300),
    });
    const { edition, articles, report } = await B.buildEdition(
      fake.fetchBytes,
      fake.putImage,
      FEEDS
    );
    expect(Object.keys(articles)).toEqual(['world/shared-headline']);
    expect(edition.sections.map((s) => s.slug)).toEqual(['world']);
    expect(report.warnings.some((w) => w.includes('duplicate'))).toBe(true);
  });

  it('still publishes when one feed fails', async () => {
    const fake = new Fake(
      new Map<string, Uint8Array | Error>([
        ['https://feed/world', new Error('upstream 503')],
        [
          'https://feed/science',
          encode(fx.channel('Science', fx.BUILT, fx.item('Alive', { section: 'Science' }))),
        ],
        [IMG, fx.png(400, 300)],
      ])
    );
    const { edition, articles, report } = await B.buildEdition(
      fake.fetchBytes,
      fake.putImage,
      FEEDS
    );
    expect(Object.keys(articles)).toHaveLength(1);
    expect(report.failures.map((f) => f.feed)).toEqual(['world']);
    expect(edition.sections.map((s) => s.slug)).toEqual(['science']);
  });

  it('treats malformed xml as a feed failure, not a crash', async () => {
    const fake = new Fake(
      new Map<string, Uint8Array | Error>([
        ['https://feed/world', encode('<rss><not-a-channel/></rss>')],
        [
          'https://feed/science',
          encode(fx.channel('Science', fx.BUILT, fx.item('Alive', { section: 'Science' }))),
        ],
        [IMG, fx.png(400, 300)],
      ])
    );
    const { report } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(report.failures[0]!.feed).toBe('world');
  });

  it('refuses to guess the date when every feed fails', async () => {
    const fake = new Fake(new Map());
    await expect(B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS)).rejects.toThrow(
      /lastBuildDate/
    );
  });

  it('refuses to publish an empty edition', async () => {
    const fake = feedsWith('', '');
    await expect(B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS)).rejects.toThrow(/empty/);
  });

  it('orders sections by the configured reading order, not response order', async () => {
    const reversed = [FEEDS[1]!, FEEDS[0]!];
    const fake = feedsWith(fx.item('W', { image: null }), fx.item('S', { section: 'Science', image: null }));
    const { edition } = await B.buildEdition(fake.fetchBytes, fake.putImage, reversed);
    expect(edition.sections.map((s) => s.slug)).toEqual(['science', 'world']);
  });
});

describe('pictures', () => {
  it('costs only the picture when one is missing', async () => {
    const fake = feedsWith(fx.item('No picture for me')); // image URL absent from the map
    const { articles, report } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    const article = articles['world/no-picture-for-me']!;
    expect(article.blocks.every((b) => b.kind !== 'figure')).toBe(true);
    expect(article.word_count).toBeGreaterThan(0);
    expect(report.warnings.some((w) => w.includes('picture unavailable'))).toBe(true);
  });

  it('does not treat an html error page as a picture', async () => {
    const fake = feedsWith(fx.item('Story'), '', { [IMG]: fx.notAnImage() });
    const { articles } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(fake.puts).toEqual([]);
    expect(articles['world/story']!.blocks.every((b) => b.kind !== 'figure')).toBe(true);
  });

  it('rejects a tracking pixel', async () => {
    const fake = feedsWith(fx.item('Story'), '', { [IMG]: fx.png(1, 1) });
    const { articles } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(fake.puts).toEqual([]);
    expect(articles['world/story']!.blocks.every((b) => b.kind !== 'figure')).toBe(true);
  });

  it('rejects an icon-sized graphic', async () => {
    const fake = feedsWith(fx.item('Story'), '', { [IMG]: fx.png(64, 64) });
    const { articles } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(articles['world/story']!.blocks.every((b) => b.kind !== 'figure')).toBe(true);
  });

  it('keeps a small but usable photograph', async () => {
    const fake = feedsWith(fx.item('Story'), '', { [IMG]: fx.png(240, 120) });
    const { articles } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(articles['world/story']!.blocks[0]).toMatchObject({
      kind: 'figure',
      width: 240,
      height: 120,
    });
  });

  it('flags a stub but keeps it', async () => {
    const fake = feedsWith(fx.item('Thin', { body: '<p>Four words only here.</p>', image: null }));
    const { articles, report } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(articles['world/thin']).toBeDefined();
    expect(report.warnings.some((w) => w.includes('possible stub'))).toBe(true);
  });
});

describe('image retries', () => {
  /** Fails the first `failTimes` picture requests, then behaves. */
  class Flaky extends Fake {
    attempts = 0;
    constructor(
      responses: Map<string, Uint8Array | Error>,
      private failTimes: number
    ) {
      super(responses);
    }
    override fetchBytes = async (url: string) => {
      if (url.startsWith('https://img')) {
        this.attempts += 1;
        if (this.attempts <= this.failTimes) throw new Error('transient proxy error');
      }
      this.requests.push(url);
      const value = (this as unknown as { responses: Map<string, Uint8Array | Error> }).responses.get(url);
      if (value === undefined) throw new Error(`404 for ${url}`);
      if (value instanceof Error) throw value;
      return { data: value, contentType: null };
    };
  }

  const responses = () =>
    new Map<string, Uint8Array | Error>([
      ['https://feed/world', encode(fx.channel('World', fx.BUILT, fx.item('Story')))],
      ['https://feed/science', encode(fx.channel('Science', fx.BUILT, ''))],
      [IMG, fx.png(400, 300)],
    ]);

  it('retries a single transient failure', async () => {
    const fake = new Flaky(responses(), 1);
    const { articles, report } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(articles['world/story']!.blocks[0]!.kind).toBe('figure');
    expect(report.image_retries).toBe(1);
  });

  it('gives up after two failures, and the story survives', async () => {
    const fake = new Flaky(responses(), 2);
    const { articles, report } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(articles['world/story']!.blocks.every((b) => b.kind !== 'figure')).toBe(true);
    expect(report.image_retries).toBe(2);
    expect(report.warnings.some((w) => w.includes('picture unavailable'))).toBe(true);
  });

  it('does not retry an error page', async () => {
    // Nothing transient about a 403 body: a second look wastes a request.
    const fake = feedsWith(fx.item('Story'), '', { [IMG]: fx.notAnImage() });
    const { report } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(report.image_retries).toBe(0);
    expect(fake.requests.filter((u) => u === IMG)).toHaveLength(1);
  });
});

describe('the unchanged short-circuit', () => {
  const fake = () => feedsWith(fx.item('One'), '', { [IMG]: fx.png(400, 300) });

  it('throws before any picture is fetched', async () => {
    // The whole point: the redundant daily firing must cost four requests, not
    // thirty-five.
    const f = fake();
    await expect(
      B.buildEdition(f.fetchBytes, f.putImage, FEEDS, async () => true)
    ).rejects.toBeInstanceOf(B.Unchanged);
    expect(f.puts).toEqual([]);
    expect(f.requests.every((u) => u.startsWith('https://feed/'))).toBe(true);
    expect(f.requests).toHaveLength(2);
  });

  it('carries the date and build stamp on the exception', async () => {
    const f = fake();
    await B.buildEdition(f.fetchBytes, f.putImage, FEEDS, async () => true).catch((e) => {
      expect(e).toBeInstanceOf(B.Unchanged);
      expect(e.date).toBe('2026-08-10');
      expect(e.builtFrom).toBe(fx.BUILT);
    });
  });

  it('rebuilds when the stored edition is stale', async () => {
    const f = fake();
    const seen: [string, string][] = [];
    const { articles } = await B.buildEdition(f.fetchBytes, f.putImage, FEEDS, async (d, b) => {
      seen.push([d, b]);
      return false;
    });
    expect(seen).toEqual([['2026-08-10', fx.BUILT]]);
    expect(Object.keys(articles)).toHaveLength(1);
    expect(f.puts.length).toBeGreaterThan(0);
  });

  it('records timings for an unattended job', async () => {
    const f = fake();
    const { report } = await B.buildEdition(f.fetchBytes, f.putImage, FEEDS);
    for (const key of ['feeds_ms', 'images_ms', 'articles_ms'] as const) {
      expect(typeof report[key]).toBe('number');
    }
  });
});

describe('content addressing', () => {
  it('hashes with sha-256', async () => {
    // The empty-string digest, so the encoding is pinned and not merely
    // self-consistent.
    expect(await B.sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('gives the same key for the same bytes', async () => {
    const a = await B.sha256Hex(fx.png(10, 10));
    const b = await B.sha256Hex(fx.png(10, 10));
    expect(a).toBe(b);
    expect(a).not.toBe(await B.sha256Hex(fx.png(11, 10)));
  });
});


describe('outbound request discipline', () => {
  /** Rejects picture requests with a typed HTTP status, as the Worker's real
   *  fetchBytes does for any non-200 response. */
  class Refusing extends Fake {
    asked = 0;
    constructor(responses: Map<string, Uint8Array | Error>) {
      super(responses);
    }
    override fetchBytes = async (url: string) => {
      this.requests.push(url);
      if (url.startsWith('https://img')) {
        this.asked += 1;
        throw new B.HttpStatusError(403, url);
      }
      const value = (this as unknown as { responses: Map<string, Uint8Array | Error> }).responses.get(url);
      if (value === undefined) throw new Error(`404 for ${url}`);
      if (value instanceof Error) throw value;
      return { data: value, contentType: null };
    };
  }

  it('does not retry a refusal', async () => {
    // A 403 is the same 403 a second later, and retrying it doubled the load on
    // a host that had already answered cleanly.
    const fake = new Refusing(
      new Map<string, Uint8Array | Error>([
        ['https://feed/world', encode(fx.channel('World', fx.BUILT, fx.item('Story')))],
        ['https://feed/science', encode(fx.channel('Science', fx.BUILT, ''))],
      ])
    );
    const { articles, report } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(fake.asked).toBe(1);
    expect(report.image_retries).toBe(0);
    expect(articles['world/story']!.blocks.every((b) => b.kind !== 'figure')).toBe(true);
    expect(report.warnings.some((w) => w.includes('picture unavailable'))).toBe(true);
  });

  it('caps the items taken from one feed', async () => {
    // Items are subrequests, and an unbounded item count is a subrequest count
    // chosen by whoever controls the feed.
    const many = Array.from({ length: B.MAX_ITEMS_PER_FEED + 15 }, (_, i) =>
      fx.item(`Story ${i}`, { image: null })
    ).join('');
    const fake = feedsWith(many);
    const { articles, report } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(Object.keys(articles)).toHaveLength(B.MAX_ITEMS_PER_FEED);
    expect(report.warnings.some((w) => w.includes(`first ${B.MAX_ITEMS_PER_FEED}`))).toBe(true);
  });

  it('compares build stamps chronologically, not as strings', async () => {
    // "Fri, 01 ..." sorts above "Mon, 10 ..." lexicographically, so a string
    // comparison would pick the wrong build to compare against.
    const fake = new Fake(
      new Map<string, Uint8Array | Error>([
        [
          'https://feed/world',
          encode(fx.channel('World', 'Sun, 09 Aug 2026 12:00:00 +0000', fx.item('A', { image: null }))),
        ],
        [
          'https://feed/science',
          encode(
            fx.channel('Science', 'Mon, 10 Aug 2026 12:00:00 +0000', fx.item('B', { section: 'Science', image: null }))
          ),
        ],
      ])
    );
    const { edition } = await B.buildEdition(fake.fetchBytes, fake.putImage, FEEDS);
    expect(edition.built_from).toBe('Mon, 10 Aug 2026 12:00:00 +0000');
  });
});

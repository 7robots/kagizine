/* The parser and the sanitiser.
 *
 * The sanitiser cases are the ones to keep honest: `Paragraph.html` and list
 * items are the only fields the reader hands to innerHTML, so anything that
 * survives `describe` runs in the browser.
 */

import { describe as group, expect, it } from 'vitest';

import * as F from '../src/kagi/feed';
import * as fx from './fixtures';

/** The sanitised markup of a single paragraph -- what the reader would set. */
async function html(input: string): Promise<string> {
  const described = await F.describe(input);
  return described.paragraphs[0] ?? '';
}

group('sanitising: what survives', () => {
  it('keeps allowed inline markup', async () => {
    expect(await html('<p>plain <b>bold</b> and <em>italic</em></p>')).toBe(
      'plain <b>bold</b> and <em>italic</em>'
    );
  });

  it('keeps small, sub and sup', async () => {
    expect(await html('<p><small>s</small><sub>b</sub><sup>p</sup></p>')).toBe(
      '<small>s</small><sub>b</sub><sup>p</sup>'
    );
  });

  it('drops disallowed tags but keeps their text', async () => {
    const out = await html('<p><div onmouseover=x>kept <small>small</small></div></p>');
    expect(out).toContain('kept');
    expect(out).toContain('<small>small</small>');
    expect(out).not.toContain('div');
  });

  it('drops <br> rather than emitting it', async () => {
    expect(await html('<p>a<br>b</p>')).not.toContain('<br');
  });

  it('collapses runs of whitespace', async () => {
    expect(await html('<p>a  \n  b</p>')).toBe('a b');
  });
});

group('sanitising: escaping', () => {
  it('escapes bare angle brackets', async () => {
    expect(await html('<p>5 &lt; 6 &amp; 7 &gt; 2</p>')).toBe('5 &lt; 6 &amp; 7 &gt; 2');
  });

  it('does not double-escape entities', async () => {
    // HTMLRewriter hands text back undecoded, so escaping blindly would turn
    // &amp; into &amp;amp;.
    expect(await html('<p>Spain&#x27;s fires &amp; smoke</p>')).toBe("Spain's fires &amp; smoke");
  });

  it('decodes numeric and named references', async () => {
    expect(await html('<p>&#8212; &mdash; &hellip;</p>')).toBe('— — …');
  });

  it('leaves an unknown named entity alone rather than mangling it', async () => {
    expect(await html('<p>&notarealentity; x</p>')).toContain('notarealentity');
  });
});

group('sanitising: links', () => {
  it('strips event handlers from allowed tags', async () => {
    const out = await html('<p><a href="https://ok.example" onclick="evil()">good</a></p>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('href="https://ok.example"');
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,x'],
    ['vbscript:msgbox'],
    ['/relative/path'],
    ['mailto:someone@example.com'],
    ['#fragment'],
  ])('drops links with unsafe scheme %s', async (href) => {
    const out = await html(`<p><a href="${href}">x</a></p>`);
    expect(out).toBe('x');
  });

  it('drops an ENCODED javascript: scheme', async () => {
    // The reason hrefs are decoded before the check. A naive startsWith test on
    // the raw attribute would pass this straight through as a live link.
    expect(await html('<p><a href="&#106;avascript:alert(1)">x</a></p>')).toBe('x');
  });

  it('drops a scheme hidden by leading whitespace', async () => {
    expect(await html('<p><a href="  javascript:alert(1)">x</a></p>')).toBe('x');
  });

  it('accepts an uppercase scheme', async () => {
    expect(await html('<p><a href="HTTPS://x.test">x</a></p>')).toContain('href="HTTPS://x.test"');
  });

  it('sends external links away from the reader', async () => {
    const out = await html('<p><a href="https://ok.example">x</a></p>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noreferrer noopener"');
  });

  it('escapes quotes so an href cannot open a new attribute', async () => {
    const out = await html(`<p><a href='https://x.example/"onmouseover="evil()'>x</a></p>`);
    expect(out).toContain('&quot;');
    expect(out).not.toMatch(/\sonmouseover\s*=/);
  });

  it('escapes an ampersand in a query string', async () => {
    expect(await html('<p><a href="https://x.test/?a=1&amp;b=2">x</a></p>')).toContain(
      'href="https://x.test/?a=1&amp;b=2"'
    );
  });
});

group('sanitising: hostile structure', () => {
  it('discards script contents, not just the tag', async () => {
    // A <script> body still reaches a document text handler, so muting is
    // required -- dropping the element alone would print the code as prose.
    expect(await html('<p>before<script>alert("x")</script>after</p>')).toBe('beforeafter');
  });

  it('discards style contents', async () => {
    expect(await html('<p>keep<style>p{color:red}</style></p>')).toBe('keep');
  });

  it('discards noscript and template contents', async () => {
    expect(await html('<p>a<noscript>hidden</noscript><template>tpl</template>b</p>')).toBe('ab');
  });

  it('cannot be made to emit an img or its handlers', async () => {
    const out = await html('<p><img src=x onerror=alert(1)>after</p>');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('<img');
    expect(out).toContain('after');
  });

  it('closes unbalanced markup', async () => {
    expect(await html('<p>unclosed <em>italic')).toBe('unclosed <em>italic</em>');
  });

  it('balances crossed tags', async () => {
    // <em>a<strong>b</em>c</strong> is not representable; the output must at
    // least balance, because innerHTML would otherwise reparent nodes.
    const out = await html('<p><em>a<strong>b</em>c</strong></p>');
    const count = (needle: string) => out.split(needle).length - 1;
    expect(count('<em>')).toBe(count('</em>'));
    expect(count('<strong>')).toBe(count('</strong>'));
  });

  it('does not lose a paragraph that the parser auto-closes', async () => {
    // onEndTag never fires for an auto-closed <p>, so blocks must also close
    // when the next one opens.
    const described = await F.describe('<p>one<p>two');
    expect(described.paragraphs).toEqual(['one', 'two']);
  });

  it('ignores markup outside any block', async () => {
    const described = await F.describe('loose text <b>bold</b><p>real</p>');
    expect(described.paragraphs).toEqual(['real']);
  });
});

group('description structure', () => {
  it('separates paragraphs, picture and headed groups', async () => {
    const described = await F.describe(
      '<p>Body.</p><img src="https://i.example/a.png" alt="Cap"/>' +
        '<h3>Highlights:</h3><ul><li>One</li><li>Two</li></ul>' +
        '<h3>Sources:</h3><ul><li><a href="https://one.example/a">T</a> - one.example</li></ul>'
    );
    expect(described.paragraphs).toEqual(['Body.']);
    expect(described.images).toEqual([{ src: 'https://i.example/a.png', alt: 'Cap' }]);
    expect(described.groups.map((g) => g.title)).toEqual(['Highlights', 'Sources']);
    expect(described.groups[0]!.items).toEqual(['One', 'Two']);
  });

  it('strips the colon from a heading', async () => {
    const described = await F.describe('<h3>Perspectives:</h3><ul><li>x</li></ul>');
    expect(described.groups[0]!.title).toBe('Perspectives');
  });

  it('handles an item with no picture', async () => {
    const described = await F.describe('<p>Body.</p>');
    expect(F.leadImage(described)).toEqual({ url: null, alt: '' });
  });

  it('takes only the first picture as the lead', async () => {
    const described = await F.describe(
      '<p>a</p><img src="https://i.example/1.png" alt="one"/><img src="https://i.example/2.png"/>'
    );
    expect(F.leadImage(described).url).toBe('https://i.example/1.png');
  });
});

group('sources', () => {
  it('extracts title, url and domain, dropping duplicates', async () => {
    const described = await F.describe(fx.SOURCES.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    const sources = F.parseSources(described.groups[0]!.items);
    expect(sources.map((s) => s.domain)).toEqual(['one.example', 'two.example']);
    expect(sources[0]!.title).toBe('Headline one');
  });

  it('falls back to the host when no domain follows the link', () => {
    const sources = F.parseSources([
      '<a href="https://www.example.com/a" target="_blank" rel="noreferrer noopener">T</a>',
    ]);
    expect(sources[0]!.domain).toBe('example.com');
  });

  it('ignores a list item with no link', () => {
    expect(F.parseSources(['just text'])).toEqual([]);
  });
});

group('slugs', () => {
  it.each([
    ['Wildfires force evacuations', 'wildfires-force-evacuations'],
    ['Athletics end Red Sox streaks!', 'athletics-end-red-sox-streaks'],
    ['Häagen  —  Dazs', 'haagen-dazs'],
    ['21.62C in June-July', '21-62c-in-june-july'],
    ['', 'untitled'],
    ['!!!', 'untitled'],
  ])('slugifies %s', (input, expected) => {
    expect(F.slugify(input)).toBe(expected);
  });

  it('drops a typographic apostrophe rather than making it a separator', () => {
    // Article ids are URLs, so this rule is part of the stored schema.
    expect(F.slugify('Alzheimer’s studies')).toBe('alzheimers-studies');
  });

  it('truncates on a word boundary', () => {
    const slug = F.slugify(`${'a'.repeat(30)} ${'b'.repeat(30)} ${'c'.repeat(30)}`, 40);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });
});

group('word counts', () => {
  it('ignores markup', () => {
    expect(F.wordCount(F.stripTags('<b>two</b> words'))).toBe(2);
  });

  it('counts an accented word once', () => {
    // JavaScript's \w is ASCII-only, which would split this into three.
    expect(F.wordCount('Deux-Sèvres and Montpellier')).toBe(3);
  });

  it('does not count punctuation as a word', () => {
    expect(F.wordCount('one - two')).toBe(2);
  });
});

group('dates', () => {
  // Pinned, so these do not start failing as the calendar moves past the
  // freshness window that editionDate now enforces.
  const NOW = new Date('2026-08-10T12:30:00Z');

  it('takes the latest build date', () => {
    expect(
      F.editionDate(
        [
          'Mon, 10 Aug 2026 12:01:32 +0000',
          'Mon, 10 Aug 2026 12:04:00 +0000',
          'Sun, 09 Aug 2026 12:00:00 +0000',
        ],
        NOW
      )
    ).toBe('2026-08-10');
  });

  it('ignores unparseable and empty values', () => {
    expect(F.editionDate(['', 'not a date', 'Mon, 10 Aug 2026 12:01:32 +0000'], NOW)).toBe(
      '2026-08-10'
    );
    expect(F.editionDate([], NOW)).toBeNull();
    expect(F.editionDate(['nonsense'], NOW)).toBeNull();
  });

  it('normalises to UTC, so Eastern morning is the same day', () => {
    expect(F.editionDate(['Mon, 10 Aug 2026 08:01:00 -0400'], NOW)).toBe('2026-08-10');
  });

  it('refuses a date far in the future', () => {
    // Unbounded, this pins the reader's front page for ever: the index sorts
    // dates as strings, so 9999-01-01 can never be displaced.
    expect(F.editionDate(['Fri, 01 Jan 9999 00:00:00 GMT'], NOW)).toBeNull();
    expect(F.editionDate(['Sat, 09 Aug 2099 12:00:00 GMT'], NOW)).toBeNull();
  });

  it('refuses a date far in the past', () => {
    expect(F.editionDate(['Thu, 01 Jan 1970 00:00:00 GMT'], NOW)).toBeNull();
  });

  it('refuses a year beyond four digits rather than emitting a non-date', () => {
    // toISOString() switches to expanded years there, so the first ten
    // characters would be '+275760-09' -- unmatched by the route pattern, and
    // an edition that could never be fetched.
    expect(F.editionDate(['+275760-09-13T00:00:00Z'], NOW)).toBeNull();
  });

  it('accepts a build a little ahead of the clock', () => {
    // Feeds and Workers do not share a clock; a few hours of skew is normal.
    expect(F.editionDate(['Mon, 10 Aug 2026 20:00:00 +0000'], NOW)).toBe('2026-08-10');
  });

  it.each([
    ['2026-08-10', 'Monday'],
    ['2026-08-09', 'Sunday'],
    ['2026-01-01', 'Thursday'],
    ['2024-02-29', 'Thursday'],
    ['2000-03-01', 'Wednesday'],
  ])('names the weekday for %s', (date, day) => {
    expect(F.weekday(date)).toBe(day);
  });

  it('titles an edition without a leading zero', () => {
    expect(F.editionTitle('2026-08-10')).toBe('Kagi News, 10 August 2026');
    expect(F.editionTitle('2026-12-01')).toBe('Kagi News, 1 December 2026');
  });

  it('formats timestamps as the stored editions do', () => {
    expect(F.isoUtc('Sun, 09 Aug 2026 17:13:45 +0000')).toBe('2026-08-09T17:13:45+00:00');
    expect(F.isoUtc('not a date')).toBeNull();
    expect(F.isoUtc(null)).toBeNull();
  });
});

group('channels', () => {
  it('parses items and the build date', () => {
    const parsed = F.parseChannel(fx.channel('World', fx.BUILT, fx.item('One') + fx.item('Two')));
    expect(parsed.builtAt).toBe(fx.BUILT);
    expect(parsed.items).toHaveLength(2);
  });

  it('treats a single item as a list, not an object', () => {
    // The Boston feed regularly carries few enough items to hit this.
    const parsed = F.parseChannel(fx.channel('Boston', fx.BUILT, fx.item('Only one')));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]!.title).toBe('Only one');
  });

  it('rejects a document with no channel', () => {
    expect(() => F.parseChannel("<rss version='2.0'></rss>")).toThrow(/channel/);
  });

  it('takes the middle category as the subcategory', () => {
    const parsed = F.parseChannel(
      fx.channel('World', fx.BUILT, fx.item('T', { sub: 'Ukraine War' }))
    );
    expect(parsed.items[0]!.subcategory).toBe('Ukraine War');
    expect(parsed.items[0]!.published).toBe('2026-08-09T17:13:45+00:00');
  });
});

group('building an article', () => {
  const SECTION: F.FeedSpec = { slug: 'world', title: 'World', url: 'https://feed/world' };

  const oneItem = (options?: Parameters<typeof fx.item>[1]) =>
    F.parseChannel(fx.channel('World', fx.BUILT, fx.item('A story', options))).items[0]!;

  it('produces the expected block sequence', async () => {
    const article = await F.buildArticle(oneItem({ extras: fx.FULL_EXTRAS }), SECTION, null);
    expect(article.id).toBe('world/a-story');
    expect(article.rubric).toBe('Wildfires');
    expect(article.dek).toBeNull();
    expect(article.blocks.map((b) => b.kind)).toEqual(['p', 'p', 'h', 'list', 'h', 'list']);
  });

  it('numbers blocks sequentially', async () => {
    const article = await F.buildArticle(oneItem({ extras: fx.HIGHLIGHTS }), SECTION, null);
    expect(article.blocks.map((b) => b.id)).toEqual(['b0000', 'b0001', 'b0002', 'b0003']);
  });

  it('keeps sources as furniture rather than blocks', async () => {
    const article = await F.buildArticle(oneItem({ extras: fx.SOURCES }), SECTION, null);
    expect(article.blocks.every((b) => b.kind !== 'h')).toBe(true);
    expect(article.sources.map((s) => s.domain)).toEqual(['one.example', 'two.example']);
  });

  it('keeps a perspective link', async () => {
    const article = await F.buildArticle(oneItem({ extras: fx.PERSPECTIVES }), SECTION, null);
    const list = article.blocks.find((b) => b.kind === 'list');
    expect(JSON.stringify(list)).toContain('href=\\"https://outlet.example/a\\"');
  });

  it('leads with the figure and carries its dimensions', async () => {
    const article = await F.buildArticle(oneItem(), SECTION, {
      asset: 'abc.png',
      width: 1600,
      height: 900,
      alt: 'A caption.',
    });
    const figure = article.blocks[0]!;
    expect(figure.kind).toBe('figure');
    expect(figure).toMatchObject({ width: 1600, height: 900, role: 'hero', caption: 'A caption.' });
  });

  it('keeps a portrait figure inside the measure', async () => {
    const article = await F.buildArticle(oneItem(), SECTION, {
      asset: 'abc.png',
      width: 900,
      height: 1200,
      alt: '',
    });
    expect(article.blocks[0]).toMatchObject({ role: 'half', caption: null });
  });

  it('falls back to the section name for the rubric', async () => {
    const fields = { ...oneItem(), subcategory: '' };
    expect((await F.buildArticle(fields, SECTION, null)).rubric).toBe('World');
  });

  it('neutralises a hostile body', async () => {
    const article = await F.buildArticle(
      oneItem({
        body:
          '<p>Real text.</p><p><img src=x onerror=alert(1)>after</p>' +
          "<p><a href='javascript:alert(1)'>click</a></p>",
      }),
      SECTION,
      null
    );
    const markup = JSON.stringify(article.blocks);
    expect(markup).not.toContain('onerror');
    expect(markup).not.toContain('javascript:');
    expect(markup).toContain('Real text.');
  });
});

group('cover selection', () => {
  it('takes the first figure in reading order', () => {
    const articles = {
      'world/a': { blocks: [{ kind: 'p', html: 'x' }] },
      'world/b': { blocks: [{ kind: 'figure', asset: 'second.jpg' }] },
      'science/c': { blocks: [{ kind: 'figure', asset: 'third.jpg' }] },
    } as unknown as Record<string, F.Article>;
    const sections: F.Section[] = [
      { title: 'World', slug: 'world', article_ids: ['world/a', 'world/b'] },
      { title: 'Science', slug: 'science', article_ids: ['science/c'] },
    ];
    expect(F.chooseCover(sections, articles)).toBe('second.jpg');
  });

  it('returns null when nothing has a picture', () => {
    const articles = { 'world/a': { blocks: [] } } as unknown as Record<string, F.Article>;
    expect(F.chooseCover([{ title: 'W', slug: 'world', article_ids: ['world/a'] }], articles)).toBeNull();
  });
});

group('feed configuration', () => {
  it('keeps the reading order and unique slugs', () => {
    expect(F.FEEDS.map((f) => f.slug)).toEqual(['world', 'science', 'usa', 'boston']);
  });

  it('percent-encodes the pipe in the Boston url', () => {
    const boston = F.FEEDS.find((f) => f.slug === 'boston')!;
    expect(boston.url).not.toContain('|');
    expect(boston.url).toContain('%7C');
  });
});


group('url validation at the data boundary', () => {
  const SECTION: F.FeedSpec = { slug: 'world', title: 'World', url: 'https://feed/world' };

  const withLink = (link: string): F.ItemFields => ({
    title: 'A story',
    link,
    description: '<p>Body.</p>',
    subcategory: 'Wildfires',
    published: null,
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox'],
    ['  javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
  ])('empties source_url for the unsafe scheme %s', async (link) => {
    // The reader assigns source_url straight to an href, so an unsafe scheme
    // here is one click from executing in this origin.
    const article = await F.buildArticle(withLink(link), SECTION, null);
    expect(article.source_url).toBe('');
  });

  it('keeps an ordinary link', async () => {
    const article = await F.buildArticle(withLink('https://kite.kagi.com/world/1/x'), SECTION, null);
    expect(article.source_url).toBe('https://kite.kagi.com/world/1/x');
  });

  it.each([
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['data:image/png;base64,AAAA'],
    ['//evil.example/x.png'],
  ])('ignores an img src with the unsafe scheme %s', async (src) => {
    // This URL is fetched by the Worker and its bytes republished publicly under
    // this domain, so an unchecked value is both an arbitrary-fetch primitive
    // and free hosting.
    const described = await F.describe(`<p>a</p><img src="${src}" alt="x"/>`);
    expect(described.images).toEqual([]);
    expect(F.leadImage(described)).toEqual({ url: null, alt: '' });
  });

  it('keeps an http(s) img src', async () => {
    const described = await F.describe('<p>a</p><img src="https://i.example/a.png" alt="x"/>');
    expect(described.images).toHaveLength(1);
  });

  it('exposes isSafeUrl for callers at the boundary', () => {
    expect(F.isSafeUrl('https://x.test')).toBe(true);
    expect(F.isSafeUrl('http://x.test')).toBe(true);
    expect(F.isSafeUrl('javascript:x')).toBe(false);
    expect(F.isSafeUrl('')).toBe(false);
  });
});

group('parsing the body once', () => {
  it('accepts a precomputed description rather than reparsing', async () => {
    const fields: F.ItemFields = {
      title: 'Reused',
      link: 'https://x.test/a',
      description: '<p>ignored if precomputed is supplied</p>',
      subcategory: '',
      published: null,
    };
    const precomputed = await F.describe('<p>from the precomputed pass</p>');
    const article = await F.buildArticle(fields, { slug: 'world', title: 'World', url: 'u' }, null, precomputed);
    expect(article.blocks[0]).toMatchObject({ kind: 'p', html: 'from the precomputed pass' });
  });
});

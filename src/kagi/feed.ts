/* Turning a Kagi News feed item into an article.
 *
 * The sanitising here is the security boundary of the whole project: the reader
 * sets `Paragraph.html` and list items with innerHTML and nothing else, so this
 * module is the only thing standing between a feed and the DOM.
 *
 * Parsing is done by HTMLRewriter rather than by hand. That matters -- a
 * hand-rolled tag stripper cannot reliably tell `<a href=x onclick=y>` from
 * `<a href=x>`, and malformed markup is exactly where such a stripper leaks.
 * HTMLRewriter is the runtime's own HTML parser; the allowlist below is the only
 * part that is ours, and nothing is emitted that this file did not write.
 *
 * Four behaviours of HTMLRewriter shape this code, each established by
 * experiment rather than assumption:
 *
 *   1. `text.text` arrives in *source* form -- `&amp;` stays `&amp;`. Escaping
 *      it blindly would double-escape, so text is decoded and then re-escaped.
 *   2. Attribute values are likewise undecoded, so an href must be decoded
 *      before its scheme is checked. `&#106;avascript:` would otherwise pass a
 *      naive startsWith test and become a live javascript: link.
 *   3. A `<script>` body still reaches a document-level text handler, so
 *      dropping the element is not enough; its contents must be muted.
 *   4. `onEndTag` does not fire for an auto-closed element (`<p>one<p>two`), so
 *      a block must also be closed when the next block opens.
 */

import { XMLParser } from 'fast-xml-parser';

export const SCHEMA_VERSION = 1;

/** The reading order. `slug` is a section's identity in URLs and stored keys, so
 *  it must not change once editions exist; `title` is only ever displayed.
 *
 *  Note the science entry: news.kagi.com/science/latest serves the HTML page,
 *  not a feed. The feed for that section is science.xml, which is what the
 *  page's own <link rel=alternate> points at. */
export const FEEDS: FeedSpec[] = [
  { slug: 'world', title: 'World', url: 'https://news.kagi.com/world.xml' },
  { slug: 'science', title: 'Science', url: 'https://news.kagi.com/science.xml' },
  { slug: 'usa', title: 'United States', url: 'https://news.kagi.com/usa.xml' },
  {
    slug: 'boston',
    title: 'Boston',
    // The '|' in the path has to travel percent-encoded; the server 404s on the
    // raw character.
    url: 'https://news.kagi.com/usa_%7C_boston.xml',
  },
];

/** Inline markup we are willing to hand to innerHTML. Anything else -- <br>,
 *  <div>, <span>, and every event-handler-bearing tag -- is dropped and only
 *  its text kept. */
const ALLOWED_INLINE = new Set(['a', 'em', 'strong', 'i', 'b', 'small', 'sub', 'sup']);

/** Tags whose *text* is code, not prose: dropping the tag is not enough, the
 *  contents have to go too or the page shows the script as words. */
const OPAQUE = new Set(['script', 'style', 'template', 'noscript']);

/** Below this, an item is a stub rather than a story and gets flagged. */
export const STUB_WORDS = 40;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

// --------------------------------------------------------------------- types

export interface FeedSpec {
  slug: string;
  title: string;
  url: string;
}

export interface Section {
  title: string;
  slug: string;
  article_ids: string[];
}

export interface Source {
  title: string;
  url: string;
  domain: string;
}

export type Block =
  | { id: string; kind: 'p'; html: string }
  | { id: string; kind: 'h'; level: number; text: string }
  | { id: string; kind: 'list'; ordered: boolean; items: string[] }
  | {
      id: string;
      kind: 'figure';
      asset: string;
      alt: string;
      caption: string | null;
      credit: string | null;
      width: number;
      height: number;
      role: string;
    };

export interface Article {
  id: string;
  slug: string;
  title: string;
  dek: string | null;
  rubric: string;
  section_slug: string;
  source_url: string;
  published: string | null;
  word_count: number;
  blocks: Block[];
  sources: Source[];
  audio_asset: null;
}

export interface Edition {
  schema_version: number;
  date: string;
  title: string;
  weekday: string;
  source_url: string;
  cover_asset: string | null;
  sections: Section[];
  built_from: string;
  fetched_at?: string;
}

export interface ItemFields {
  title: string;
  link: string;
  description: string;
  subcategory: string;
  published: string | null;
}

export interface StoredImage {
  asset: string;
  width: number;
  height: number;
  alt?: string;
}

/** What one description decomposes into. */
export interface Described {
  paragraphs: string[];
  groups: { title: string; items: string[] }[];
  images: { src: string; alt: string }[];
}

// ----------------------------------------------------------------- utilities

export function slugify(text: string, limit = 72): string {
  let out = text
    .normalize('NFKD')
    // Everything non-ASCII is *dropped*, not transliterated -- decomposed
    // accents fold away ("Häagen" -> "haagen") and, less obviously, a
    // typographic apostrophe disappears rather than becoming a separator, so
    // "Alzheimer’s" slugs to "alzheimers" and not "alzheimer-s". Article ids are
    // URLs, so this rule is part of the stored schema and cannot drift.
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (out.length > limit) {
    const cut = out.slice(0, limit);
    const lastDash = cut.lastIndexOf('-');
    out = lastDash > 0 ? cut.slice(0, lastDash) : cut;
  }
  return out || 'untitled';
}

export function wordCount(text: string): number {
  // Unicode-aware on purpose: JavaScript's `\w` is ASCII-only, so "Deux-Sèvres"
  // would count as three words instead of one and every accented story would
  // read as longer than it is.
  const found = text.match(/[\p{L}\p{N}_](?:[\p{L}\p{N}_'’-]*[\p{L}\p{N}_])?/gu);
  return found ? found.length : 0;
}

export function stripTags(markup: string): string {
  return decodeEntities(markup.replace(/<[^>]+>/g, ' '));
}

/** Only the entity forms these feeds actually use, plus the five that matter
 *  for correctness. Anything else is left alone: an unrecognised named entity
 *  passes through and renders correctly, which is a better failure than
 *  mangling it. */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', times: '×', deg: '°', laquo: '«', raquo: '»',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Escape text for insertion as HTML. */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function collapse(text: string): string {
  return text.replace(/[ \t\r\n]+/g, ' ').trim();
}

export function isSafeUrl(url: string): boolean {
  const lowered = url.trim().toLowerCase();
  return lowered.startsWith('http://') || lowered.startsWith('https://');
}

// ------------------------------------------------------------ describing one

/**
 * Split one item body into its parts, sanitising as it goes.
 *
 * Structure and sanitising happen in the same pass because HTMLRewriter reports
 * elements and text in document order but does not hand back a subtree's inner
 * markup -- so the markup is rebuilt here, from the allowlist, as the parser
 * walks.
 */
export async function describe(markup: string): Promise<Described> {
  const out: Described = { paragraphs: [], groups: [], images: [] };

  let mode: 'p' | 'h3' | 'li' | null = null;
  let buffer: string[] = [];
  let openTags: string[] = [];
  let mute = 0;

  const closeBlock = () => {
    if (!mode) return;
    while (openTags.length) buffer.push(`</${openTags.pop()}>`);
    const html = collapse(buffer.join(''));
    const finished = mode;
    mode = null;
    buffer = [];
    if (!html) return;
    if (finished === 'p') {
      out.paragraphs.push(html);
    } else if (finished === 'h3') {
      out.groups.push({ title: stripTags(html).trim().replace(/:$/, '').trim(), items: [] });
    } else {
      if (!out.groups.length) out.groups.push({ title: '', items: [] });
      out.groups[out.groups.length - 1]!.items.push(html);
    }
  };

  const openBlock = (kind: 'p' | 'h3' | 'li') => {
    // An auto-closed element never fires onEndTag, so the previous block is
    // closed here rather than waiting for one.
    closeBlock();
    mode = kind;
    buffer = [];
    openTags = [];
  };

  const blockHandler = (kind: 'p' | 'h3' | 'li') => ({
    element(element: Element) {
      openBlock(kind);
      element.onEndTag(() => closeBlock());
    },
  });

  const rewriter = new HTMLRewriter()
    .on([...OPAQUE].join(', '), {
      element(element) {
        mute += 1;
        element.onEndTag(() => {
          mute = Math.max(0, mute - 1);
        });
      },
    })
    .on('p', blockHandler('p'))
    .on('h3', blockHandler('h3'))
    .on('li', blockHandler('li'))
    .on('img', {
      element(element) {
        const src = decodeEntities(element.getAttribute('src') ?? '');
        // Scheme-checked for the same reason hrefs are, and it was missing here
        // at first. This URL is *fetched* by the Worker and its bytes are then
        // republished at kagizine.7robots.org/img/<hash> as a public, immutable
        // object -- so an unchecked value is an arbitrary-URL fetch primitive
        // and free hosting on this domain, attributable to its owner.
        if (!src || !isSafeUrl(src)) return;
        out.images.push({
          src,
          alt: collapse(decodeEntities(element.getAttribute('alt') ?? '')),
        });
      },
    })
    .on('a, em, strong, i, b, small, sub, sup', {
      element(element) {
        if (!mode || mute) return;
        const tag = element.tagName.toLowerCase();
        if (!ALLOWED_INLINE.has(tag)) return;

        if (tag === 'a') {
          // Decoded before the check: an encoded scheme must not be able to
          // survive it.
          const href = decodeEntities(element.getAttribute('href') ?? '');
          if (!isSafeUrl(href)) return; // javascript:, data:, mailto:, relative
          buffer.push(
            `<a href="${escapeAttribute(href.trim())}" target="_blank" rel="noreferrer noopener">`
          );
        } else {
          buffer.push(`<${tag}>`);
        }
        openTags.push(tag);
        element.onEndTag(() => {
          // Close down to and including this tag, so crossed markup still comes
          // out balanced -- innerHTML would otherwise reparent nodes.
          while (openTags.length) {
            const open = openTags.pop()!;
            buffer.push(`</${open}>`);
            if (open === tag) break;
          }
        });
      },
    })
    .onDocument({
      text(chunk) {
        if (!mode || mute) return;
        buffer.push(escapeText(decodeEntities(chunk.text)));
      },
    });

  await rewriter.transform(new Response(markup)).text();
  closeBlock(); // anything left unterminated at the end of the fragment
  return out;
}

const LINK_RE = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;

/** `<li><a href=...>Headline</a> - domain.com</li>` -> structured sources. */
export function parseSources(items: string[]): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const match = LINK_RE.exec(raw);
    if (!match) continue;
    const url = decodeEntities(match[1]!);
    if (!isSafeUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = collapse(stripTags(match[2]!));
    const tail = collapse(stripTags(raw.slice(match.index + match[0].length)))
      .replace(/^[-–—]\s*/, '')
      .trim();
    let domain = tail;
    if (!domain) {
      const host = url.split('/')[2] ?? '';
      domain = host.replace(/^www\./, '');
    }
    out.push({ title, url, domain });
  }
  return out;
}

// -------------------------------------------------------------------- feeds

/** `isArray` is the point of this configuration: with a single <item> or a
 *  single <category>, an XML-to-object parser hands back a bare object rather
 *  than a one-element array, and every downstream loop then walks the object's
 *  keys instead. The Boston feed regularly carries few enough items to hit it. */
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // Entities inside the description are decoded once here, turning escaped
  // markup back into markup for HTMLRewriter to parse.
  processEntities: true,
  isArray: (name, jpath) =>
    ['rss.channel.item', 'rss.channel.item.category'].includes(String(jpath)) ||
    name === 'item',
});

export interface Channel {
  builtAt: string | null;
  items: ItemFields[];
}

export function parseChannel(document: string): Channel {
  const parsed = xml.parse(document) as any;
  const channel = parsed?.rss?.channel;
  if (!channel) throw new Error('no <channel> in feed');

  const rawItems: any[] = Array.isArray(channel.item)
    ? channel.item
    : channel.item
      ? [channel.item]
      : [];

  return {
    builtAt: text(channel.lastBuildDate) || null,
    items: rawItems.map(itemFields),
  };
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    const inner = (value as any)['#text'];
    return inner === undefined ? '' : String(inner).trim();
  }
  return String(value).trim();
}

export function itemFields(item: any): ItemFields {
  const categories: string[] = (
    Array.isArray(item.category) ? item.category : item.category ? [item.category] : []
  ).map(text);

  return {
    title: text(item.title),
    link: text(item.link),
    description: typeof item.description === 'string' ? item.description : text(item.description),
    // Kagi tags each item three ways: "World", "World/Wildfires", "Wildfires".
    // The middle one is the only unambiguous source for the subcategory.
    subcategory: categories.find((c) => c.includes('/'))?.split('/').slice(1).join('/') ?? '',
    published: isoUtc(text(item.pubDate)),
  };
}

// --------------------------------------------------------------------- dates

/** `YYYY-MM-DDTHH:MM:SS+00:00`, matching what the stored editions already use.
 *  Deliberately not `toISOString()`, which yields milliseconds and a `Z`. */
export function isoUtc(value: string | Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+00:00`
  );
}

export function now(): string {
  return isoUtc(new Date())!;
}

/** How far from now a feed's claimed build date may be before we refuse it. */
const MAX_FUTURE_DAYS = 2;
const MAX_PAST_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * The edition's date, taken from the feeds' own lastBuildDate.
 *
 * Deliberately not from the Worker's clock, for the date *itself*: Kagi rebuilds
 * at 08:00 Eastern, which is either 12:00 or 13:00 UTC depending on the season,
 * so asking the Worker what day it is would need a timezone it has no business
 * knowing. The feed states when it was built, so the feed decides which day this
 * is -- and a manual refresh late at night then rebuilds the same edition rather
 * than opening an empty one for tomorrow.
 *
 * The clock is used only to bound the answer, which is not optional. This date
 * becomes an R2 key and the index sorts on it *as a string*, so one feed
 * reporting "Fri, 01 Jan 9999" would store editions/9999-01-01.json, sort first
 * for ever, and pin the reader's front page to it permanently -- with no way back
 * except editing the bucket by hand. Beyond year 9999 it is worse: toISOString()
 * switches to expanded years, so the first ten characters are "+275760-09",
 * which is not a date, never matches the route pattern, and yields an edition
 * that cannot be fetched at all.
 */
export function editionDate(
  builtDates: (string | null)[],
  reference: Date = new Date()
): string | null {
  let latest: Date | null = null;
  for (const raw of builtDates) {
    if (!raw) continue;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) continue;
    const offset = date.getTime() - reference.getTime();
    if (offset > MAX_FUTURE_DAYS * DAY_MS || offset < -MAX_PAST_DAYS * DAY_MS) continue;
    if (!latest || date > latest) latest = date;
  }
  if (!latest) return null;

  const date = latest.toISOString().slice(0, 10);
  // Belt and braces: nothing may become a key or a route parameter unless it is
  // exactly YYYY-MM-DD.
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

export function editionTitle(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return `Kagi News, ${day} ${MONTHS[month - 1]} ${year}`;
}

export function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
}

// ------------------------------------------------------------------ articles

export function leadImage(described: Described): { url: string | null; alt: string } {
  const first = described.images[0];
  return first ? { url: first.src, alt: first.alt } : { url: null, alt: '' };
}

export async function buildArticle(
  fields: ItemFields,
  section: FeedSpec,
  image: StoredImage | null,
  /** The result of `describe(fields.description)` if the caller already has it.
   *  The build does, from finding the lead image, and parsing the same body
   *  twice is the largest avoidable cost in the whole refresh. */
  precomputed?: Described
): Promise<Article> {
  const described = precomputed ?? (await describe(fields.description));
  const blocks: Block[] = [];
  const words: string[] = [];

  const add = (block: Omit<Block, 'id'>) => {
    blocks.push({ ...block, id: `b${String(blocks.length).padStart(4, '0')}` } as Block);
  };

  // The picture opens the article, as a magazine lead image does. `hero` lets
  // the scrolling view break the measure with it; magazine mode caps every
  // figure to its column regardless.
  if (image) {
    const alt = (image.alt ?? '').slice(0, 300);
    add({
      kind: 'figure',
      asset: image.asset,
      alt,
      caption: alt || null,
      credit: null,
      width: image.width,
      height: image.height,
      role: image.width >= image.height * 1.4 ? 'hero' : 'half',
    } as Omit<Block, 'id'>);
  }

  for (const paragraph of described.paragraphs) {
    if (!paragraph) continue;
    add({ kind: 'p', html: paragraph } as Omit<Block, 'id'>);
    words.push(stripTags(paragraph));
  }

  let sources: Source[] = [];
  for (const group of described.groups) {
    if (group.title.toLowerCase().startsWith('source')) {
      sources = parseSources(group.items);
      continue; // rendered as furniture, not as body text
    }
    const items = group.items.filter(Boolean);
    if (!items.length) continue;
    if (group.title) {
      add({ kind: 'h', level: 2, text: group.title } as Omit<Block, 'id'>);
    }
    add({ kind: 'list', ordered: false, items } as Omit<Block, 'id'>);
    for (const item of items) words.push(stripTags(item));
  }

  const slug = slugify(fields.title);
  return {
    id: `${section.slug}/${slug}`,
    slug,
    title: fields.title,
    dek: null, // Kagi items carry no standfirst; the kicker line does that job
    rubric: fields.subcategory || section.title,
    section_slug: section.slug,
    // Scheme-checked because the reader assigns this straight to an <a href>.
    // Every other URL in the pipeline went through isSafeUrl; this one did not,
    // which made a feed-supplied `javascript:` link one click from executing in
    // this origin. The CSP happened to block it, but that is a second line of
    // defence, not this field's licence to carry anything.
    source_url: isSafeUrl(fields.link) ? fields.link : '',
    published: fields.published,
    word_count: wordCount(words.join(' ')),
    blocks,
    sources,
    audio_asset: null,
  };
}

/** The lead story's picture: the first figure in reading order. */
export function chooseCover(sections: Section[], articles: Record<string, Article>): string | null {
  for (const section of sections) {
    for (const id of section.article_ids) {
      for (const block of articles[id]?.blocks ?? []) {
        if (block.kind === 'figure') return block.asset;
      }
    }
  }
  return null;
}

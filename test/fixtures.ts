/* Synthetic feeds and images.
 *
 * Written by hand rather than captured from Kagi, for two reasons: the repo
 * stays free of third-party article text, and a fixture can carry the cases real
 * feeds happen not to contain today -- a hostile href, a script tag, an item
 * with no picture, the same headline in two sections.
 *
 * The images are headers only. Nothing here decodes a picture, so a valid IHDR
 * and enough padding to clear the byte floor is a complete fixture.
 */

export const BUILT = 'Mon, 10 Aug 2026 12:01:32 +0000';

export function channel(title: string, built: string, items: string): string {
  return `<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:atom="http://www.w3.org/2005/Atom" version="2.0">
  <channel>
    <title>Kagi News - ${title}</title>
    <link>https://kite.kagi.com/x.xml</link>
    <lastBuildDate>${built}</lastBuildDate>
    ${items}
  </channel>
</rss>`;
}

interface ItemOptions {
  section?: string;
  sub?: string;
  pub?: string;
  body?: string;
  image?: string | null;
  extras?: string;
}

/** One <item>, with its description double-escaped the way a real feed carries
 *  it: the XML holds escaped HTML, which the parser decodes back to markup. */
export function item(title: string, options: ItemOptions = {}): string {
  const {
    section = 'World',
    sub = 'Wildfires',
    pub = 'Sun, 09 Aug 2026 17:13:45 +0000',
    body = '<p>First paragraph.</p><p>Second paragraph.</p>',
    image = 'https://img.example/one.png',
    extras = '',
  } = options;

  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const picture = image
    ? escape(`<img src='${image}' alt='A caption for the picture.' /><br />`)
    : '';

  return `
    <item>
      <title>${title}</title>
      <link>https://kite.kagi.com/${section.toLowerCase()}/1/x</link>
      <description>${escape(body)}${picture}${extras}</description>
      <guid isPermaLink="true">https://kite.kagi.com/${section.toLowerCase()}/1/x</guid>
      <category>${section}</category>
      <category>${section}/${sub}</category>
      <category>${sub}</category>
      <pubDate>${pub}</pubDate>
    </item>`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const HIGHLIGHTS = esc(
  '<h3>Highlights:</h3><ul><li>One thing that happened.</li><li>Another thing.</li></ul>'
);

export const PERSPECTIVES = esc(
  "<h3>Perspectives:</h3><ul><li>A named official: said something. " +
    "(<a href='https://outlet.example/a'>Outlet</a>)</li></ul>"
);

export const SOURCES = esc(
  '<h3>Sources:</h3><ul>' +
    "<li><a href='https://one.example/a'>Headline one</a> - one.example</li>" +
    "<li><a href='https://two.example/b'>Headline two</a> - two.example</li>" +
    "<li><a href='https://one.example/a'>Headline one again</a> - one.example</li>" +
    '</ul>'
);

export const FULL_EXTRAS = HIGHLIGHTS + PERSPECTIVES + SOURCES;

// --------------------------------------------------------------------- images

/** Pad a header out past `MIN_BYTES`, so the byte floor is never what a test is
 *  accidentally measuring. */
function pad(bytes: number[], to = 100): Uint8Array {
  const out = new Uint8Array(Math.max(bytes.length, to));
  out.set(bytes);
  return out;
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function png(width: number, height: number): Uint8Array {
  return pad([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(13), ...chars('IHDR'),
    ...be32(width), ...be32(height),
    8, 2, 0, 0, 0,
    ...be32(0), // CRC, unchecked by the reader
  ]);
}

/** `fill` inserts extra 0xFF bytes before the SOF marker -- the case a scanner
 *  that skips only one 0xFF gets wrong, as progressive JPEGs do in the wild. */
export function jpeg(width: number, height: number, fill = false): Uint8Array {
  return pad([
    0xff, 0xd8,
    ...(fill ? [0xff, 0xff] : []),
    0xff, 0xc0,
    ...be16(11), 8, ...be16(height), ...be16(width), 1, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

export function gif(width: number, height: number): Uint8Array {
  return pad([...chars('GIF89a'), ...le16(width), ...le16(height), 0x80, 0, 0]);
}

export function webpVP8X(width: number, height: number): Uint8Array {
  return pad([
    ...chars('RIFF'), ...be32(0), ...chars('WEBP'),
    ...chars('VP8X'), ...be32(10), 0, 0, 0, 0,
    ...le24(width - 1), ...le24(height - 1),
  ]);
}

export function webpVP8L(width: number, height: number): Uint8Array {
  const bits = (width - 1) | ((height - 1) << 14);
  return pad([
    ...chars('RIFF'), ...be32(0), ...chars('WEBP'),
    ...chars('VP8L'), ...be32(5), 0x2f,
    bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255,
  ]);
}

export function notAnImage(): Uint8Array {
  return pad(chars('<html><body>Forbidden</body></html>'));
}

/* Intrinsic image dimensions, read from the file header.
 *
 * Nothing here decodes a picture; it only reads the width and height so the
 * reader can reserve the right box. Those numbers are load-bearing rather than
 * decorative: the paginator measures a figure from its width/height attributes
 * and never waits for a decode, so a figure that arrives without them measures
 * as zero-height, the column count comes out wrong, and pages end up with text
 * painted over pictures. See the comment in public/js/paginator.js.
 */

export type Mime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const EXTENSIONS: Record<Mime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Sniff the format from magic bytes.
 *
 * Deliberately not trusting the response's Content-Type: the image proxy in
 * front of these feeds has been seen to serve a PNG as image/jpeg, and the
 * stored extension has to match the actual bytes or browsers sniff-block it.
 */
export function contentType(data: Uint8Array): Mime | null {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (matches(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function extension(mime: Mime | null): string {
  return mime ? EXTENSIONS[mime] : 'bin';
}

export function dimensions(data: Uint8Array): { width: number; height: number } | null {
  switch (contentType(data)) {
    case 'image/jpeg':
      return jpeg(data);
    case 'image/png':
      return png(data);
    case 'image/gif':
      return gif(data);
    case 'image/webp':
      return webp(data);
    default:
      return null;
  }
}

// ------------------------------------------------------------------- helpers

function matches(data: Uint8Array, prefix: number[]): boolean {
  if (data.length < prefix.length) return false;
  return prefix.every((byte, i) => data[i] === byte);
}

function ascii(data: Uint8Array, start: number, end: number): string {
  if (data.length < end) return '';
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(data[i]!);
  return out;
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function size(width: number, height: number) {
  return width > 0 && height > 0 ? { width, height } : null;
}

// ---------------------------------------------------------------------- jpeg

// Start-of-frame markers, the only ones carrying the frame size. C4 (Huffman
// table), C8 (reserved) and CC (arithmetic conditioning) fall inside this
// numeric range but are not SOF markers, hence the explicit set.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

// Markers that stand alone: no length field follows. TEM plus RST0-RST7.
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

function jpeg(data: Uint8Array) {
  const dv = view(data);
  let i = 2;
  while (i < data.length) {
    // Markers are 0xFF followed by a type byte, but any number of 0xFF fill
    // bytes may precede the type -- skipping only one is the classic bug that
    // makes a scan miss the frame on progressive JPEGs.
    if (data[i] !== 0xff) {
      i += 1;
      continue;
    }
    while (i < data.length && data[i] === 0xff) i += 1;
    if (i >= data.length) return null;
    const marker = data[i]!;
    i += 1;

    if (STANDALONE.has(marker) || marker === 0xd8) continue;
    if (marker === 0xd9 || marker === 0xda) return null; // end of image, or start of scan
    if (i + 2 > data.length) return null;
    const length = dv.getUint16(i);
    if (SOF.has(marker)) {
      // length, precision(1), height(2), width(2)
      if (i + 7 > data.length) return null;
      return size(dv.getUint16(i + 5), dv.getUint16(i + 3));
    }
    i += length;
  }
  return null;
}

// ----------------------------------------------------------------- png / gif

function png(data: Uint8Array) {
  // The first chunk of a PNG must be IHDR, whose payload opens with the size.
  if (data.length < 24 || ascii(data, 12, 16) !== 'IHDR') return null;
  const dv = view(data);
  return size(dv.getUint32(16), dv.getUint32(20));
}

function gif(data: Uint8Array) {
  if (data.length < 10) return null;
  const dv = view(data);
  return size(dv.getUint16(6, true), dv.getUint16(8, true));
}

// ---------------------------------------------------------------------- webp

function webp(data: Uint8Array) {
  if (data.length < 16) return null;
  const kind = ascii(data, 12, 16);
  const dv = view(data);

  if (kind === 'VP8X') {
    // Extended: carries an explicit canvas size, as 24-bit little-endian.
    if (data.length < 30) return null;
    const width = (data[24]! | (data[25]! << 8) | (data[26]! << 16)) + 1;
    const height = (data[27]! | (data[28]! << 8) | (data[29]! << 16)) + 1;
    return size(width, height);
  }

  if (kind === 'VP8 ') {
    // Lossy: 3-byte frame tag, the 3-byte keyframe sync code, then the size as
    // two 16-bit values whose top two bits are a scaling hint.
    if (data.length < 30) return null;
    if (!(data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a)) return null;
    return size(dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff);
  }

  if (kind === 'VP8L') {
    // Lossless: 14 bits of width-1 then 14 bits of height-1, packed together.
    if (data.length < 25 || data[20] !== 0x2f) return null;
    const bits = dv.getUint32(21, true);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }

  return null;
}

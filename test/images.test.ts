/* The header readers.
 *
 * These matter more than their size suggests: the paginator sizes every figure
 * from the width and height recorded here, so a wrong answer shows up as text
 * painted over a picture rather than as an obvious failure.
 */

import { describe, expect, it } from 'vitest';

import * as I from '../src/kagi/images';
import * as fx from './fixtures';

describe('format sniffing', () => {
  it('recognises each format', () => {
    expect(I.contentType(fx.png(4, 4))).toBe('image/png');
    expect(I.contentType(fx.jpeg(4, 4))).toBe('image/jpeg');
    expect(I.contentType(fx.gif(4, 4))).toBe('image/gif');
    expect(I.contentType(fx.webpVP8X(4, 4))).toBe('image/webp');
  });

  it('rejects things that are not images', () => {
    expect(I.contentType(fx.notAnImage())).toBeNull();
    expect(I.contentType(new Uint8Array(0))).toBeNull();
  });

  it('rejects a RIFF container that is not WebP', () => {
    const wav = new Uint8Array(20);
    wav.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    wav.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
    expect(I.contentType(wav)).toBeNull();
  });

  it('maps mime types to extensions', () => {
    expect(I.extension('image/jpeg')).toBe('jpg');
    expect(I.extension(null)).toBe('bin');
  });
});

describe('dimensions', () => {
  it('reads a png', () => {
    expect(I.dimensions(fx.png(37, 11))).toEqual({ width: 37, height: 11 });
  });

  it('reads a gif', () => {
    expect(I.dimensions(fx.gif(320, 240))).toEqual({ width: 320, height: 240 });
  });

  it('reads a baseline jpeg', () => {
    expect(I.dimensions(fx.jpeg(1200, 800))).toEqual({ width: 1200, height: 800 });
  });

  it('reads a jpeg whose marker is preceded by fill bytes', () => {
    // Skipping only one 0xFF is the classic bug; this is the case that catches it.
    expect(I.dimensions(fx.jpeg(640, 480, true))).toEqual({ width: 640, height: 480 });
  });

  it('reads both webp varieties', () => {
    expect(I.dimensions(fx.webpVP8X(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(I.dimensions(fx.webpVP8L(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it('returns null rather than guessing', () => {
    expect(I.dimensions(fx.notAnImage())).toBeNull();
    expect(I.dimensions(fx.png(10, 10).slice(0, 12))).toBeNull();
    expect(I.dimensions(fx.jpeg(10, 10).slice(0, 4))).toBeNull();
  });

  it('terminates on a jpeg with no frame header', () => {
    expect(I.dimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });

  it('reads dimensions from a view into a larger buffer', () => {
    // R2 and fetch both hand back views with a non-zero byteOffset, which a
    // DataView built from `.buffer` alone would silently misread.
    const source = fx.png(64, 48);
    const padded = new Uint8Array(source.length + 16);
    padded.set(source, 16);
    expect(I.dimensions(padded.subarray(16))).toEqual({ width: 64, height: 48 });
  });
});

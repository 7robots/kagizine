/* Page geometry.
 *
 * `paginator.js` is a browser script, not a module, so it is evaluated here and
 * the global it defines is taken back out. Worth the small awkwardness:
 * the arithmetic below decides whether text is clipped on screen, and it had a
 * bug that only appeared at particular window sizes.
 */

import { describe, expect, it } from 'vitest';

// Imported as a string rather than read from disk: these tests run inside
// workerd, which has no filesystem to read `public/` from.
import SOURCE from '../public/js/paginator.js?raw';

/** The clip window is CLIP_SLACK wider than the content box, so justification
 *  cannot slice a glyph at the edge. Those pixels must land in the column gap
 *  and never on the next column's text. */
const CLIP_SLACK = 6;

interface Geometry {
  spread: boolean;
  columns: number;
  contentW: number;
  colW: number;
  colGap: number;
  strideW: number;
  pageW: number;
  pageH: number;
}

function geometryAt(width: number, height: number): Geometry {
  const scope: Record<string, unknown> = {};
  const stubs = {
    window: { innerWidth: width, innerHeight: height },
    document: { documentElement: { dataset: {} }, fonts: { ready: Promise.resolve() } },
    matchMedia: () => ({ matches: false }),
  };
  // eslint-disable-next-line no-new-func
  new Function(
    'window',
    'document',
    'matchMedia',
    'out',
    `${SOURCE}; out.Paginator = window.Paginator;`
  )(stubs.window, stubs.document, stubs.matchMedia, scope);
  return (scope.Paginator as { geometry: () => Geometry }).geometry();
}

/** How far the clip window reaches past the last column it should show. */
function bleed(geo: Geometry): number {
  return Math.max(0, geo.contentW + CLIP_SLACK - geo.strideW);
}

describe('the clip never exposes the next column', () => {
  it.each([
    ['iPad mini, landscape', 1133, 744],
    ['iPad, landscape', 1180, 820],
    ['iPad Pro 11, landscape', 1194, 834],
    ['a desktop window at the spread threshold', 1100, 800],
    ['a narrow desktop spread', 1120, 800],
    ['a wide desktop spread', 1600, 1000],
    ['a very wide window', 2560, 1400],
    ['portrait tablet', 820, 1180],
    ['a phone', 390, 844],
    ['a short, wide window', 1400, 620],
  ])('%s', (_name, width, height) => {
    // The regression: a single-column page had a gap of zero, so strideW equalled
    // contentW and the slack put six pixels of the next column on screen -- a
    // strip of sliced characters down the outer edge of every page. It needs a
    // window wide enough for a spread but pages narrow enough for one column,
    // which is why it looked like a mobile-only bug.
    expect(bleed(geometryAt(width, height))).toBe(0);
  });

  it('leaves a real gap even when there is only one column', () => {
    const geo = geometryAt(1133, 744);
    expect(geo.columns).toBe(1);
    expect(geo.colGap).toBeGreaterThan(CLIP_SLACK);
    expect(geo.strideW).toBe(geo.colW + geo.colGap);
  });

  it('gives a single column the full measure despite the gap', () => {
    const geo = geometryAt(1133, 744);
    expect(geo.colW).toBe(geo.contentW);
  });

  it('splits the measure between two columns', () => {
    const geo = geometryAt(1600, 1000);
    expect(geo.columns).toBe(2);
    expect(geo.colW * 2 + geo.colGap).toBe(geo.contentW);
  });
});

describe('page proportions', () => {
  it('pairs pages only when there is room for two readable ones', () => {
    expect(geometryAt(1600, 1000).spread).toBe(true);
    expect(geometryAt(820, 1180).spread).toBe(false);
    expect(geometryAt(390, 844).spread).toBe(false);
  });

  it('keeps page dimensions whole, so columns cannot drift', () => {
    for (const [w, h] of [[1133, 744], [1600, 1000], [390, 844]] as [number, number][]) {
      const geo = geometryAt(w, h);
      for (const value of [geo.pageW, geo.pageH, geo.colW, geo.colGap, geo.strideW]) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });
});

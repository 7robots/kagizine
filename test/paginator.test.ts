/* Page geometry.
 *
 * `paginator.js` is a browser script, not a module, so it is evaluated here and
 * the global it defines is taken back out. Worth the small awkwardness: the
 * arithmetic below decides whether text is clipped on screen, and it had a bug
 * that appeared only at particular window sizes.
 */

import { describe, expect, it } from 'vitest';

// Imported as a string rather than read from disk: these tests run inside
// workerd, which has no filesystem to read from.
//
// The file is now the upstream viewer's, synced from the pinned submodule, so
// this is a contract test against a dependency rather than a test of our own
// code. That is the more useful thing to have: the property it asserts -- that a
// page's clip never reaches into the next column -- is one this app depends on
// and one an upstream bump could silently break. `pretest` runs the sync, so the
// file is always the pinned version.
import SOURCE from '../public/vendor/magazine-web-viewer/js/paginator.js?raw';

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
  /* Enough of a document for `geometry()` to run.
   *
   * The viewer measures its host element's content box when it can find one, and
   * falls back to the window when it cannot -- so `getElementById` returning null
   * is what makes these viewport numbers the ones under test. `getComputedStyle`
   * is present because the fallback path is chosen by the host lookup, not by its
   * absence. */
  const stubs = {
    window: { innerWidth: width, innerHeight: height },
    document: {
      documentElement: { dataset: {} },
      fonts: { ready: Promise.resolve() },
      getElementById: () => null,
      querySelector: () => null,
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0' }),
  };
  // eslint-disable-next-line no-new-func
  new Function(
    'window',
    'document',
    'matchMedia',
    'getComputedStyle',
    'out',
    `${SOURCE}; out.Paginator = window.Paginator;`
  )(stubs.window, stubs.document, stubs.matchMedia, stubs.getComputedStyle, scope);
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

  /* Found rather than assumed.
   *
   * Which viewports fall back to one column is the viewer's business and it
   * moves: the type scale means a narrow page now keeps two columns with smaller
   * type where it used to drop to one. Pinning a viewport here made these tests
   * assert the dependency's tuning instead of the property that matters. */
  function firstSingleColumn(): Geometry {
    for (const [w, h] of [
      [390, 844],
      [430, 932],
      [360, 780],
      [820, 1180],
      [1120, 800],
    ] as [number, number][]) {
      const geo = geometryAt(w, h);
      if (geo.columns === 1) return geo;
    }
    throw new Error('no viewport in the list produced a single-column page');
  }

  it('leaves a real gap even when there is only one column', () => {
    const geo = firstSingleColumn();
    expect(geo.colGap).toBeGreaterThan(CLIP_SLACK);
    expect(geo.strideW).toBe(geo.colW + geo.colGap);
  });

  it('gives a single column the full measure despite the gap', () => {
    const geo = firstSingleColumn();
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

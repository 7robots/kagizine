/* Turning reflowable articles into fixed pages.
 *
 * The technique is CSS multi-column with the column width set to exactly one
 * page: the browser does the line-breaking, and a page is then just a window
 * onto column N of a very wide strip. This is what every serious web reader
 * does, because it is the only approach where the browser's own text engine
 * stays in charge.
 *
 * Two rules matter more than the rest, and skipping either produces phantom
 * trailing pages and clipped final lines:
 *
 *   1. Measure only after `document.fonts.ready` AND after every image has
 *      decoded. Layout before then is measuring the wrong document.
 *   2. Keep page widths integral. Sub-pixel column widths accumulate across
 *      dozens of columns until the last page is half a line short.
 */
'use strict';

window.Paginator = (function () {
  /** Page geometry for the current viewport. */
  function geometry() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Two-page spread only when there is genuinely room for two readable
    // columns; below that a spread makes the measure too narrow to read.
    const spread = vw >= 1100 && vw > vh;

    // Magazine mode owns the whole window, so the only reservations are a
    // breathing margin and room for the control bar to sit over the surround.
    const availH = Math.floor(vh - 56);
    const availW = Math.floor(vw - 56);

    // Slightly taller than a 1:1.4 book page; the proportion reads as a
    // magazine rather than a paperback.
    let pageH = Math.min(availH, 1180);
    let pageW = Math.floor(Math.min(spread ? availW / 2 : availW, pageH * 0.72));

    // On a short, wide window the height is the binding constraint; on a tall
    // narrow one the width is. Re-derive height so the ratio never distorts.
    pageH = Math.min(pageH, Math.floor(pageW / 0.72));

    if (pageW < 300) {
      pageW = Math.max(280, Math.floor(availW / (spread ? 2 : 1)));
      pageH = Math.min(availH, Math.floor(pageW / 0.72));
    }

    pageW = Math.floor(pageW);
    pageH = Math.floor(pageH);

    // Print-style margins, scaled to the page: generous outside, room at the
    // foot for the folio, room at the head for the running head.
    const padX = Math.round(Math.max(26, Math.min(52, pageW * 0.075)));
    const padTop = Math.round(Math.max(34, Math.min(60, pageH * 0.055)));
    const padBottom = Math.round(Math.max(38, Math.min(64, pageH * 0.06)));

    // The column must be the *content* box, not the page. Sizing the flow to
    // the full page width while the window is padded pushes each column
    // partly out of view -- text clipped at the right edge, and the last line
    // cut off at the foot.
    const contentW = pageW - padX * 2;
    const contentH = pageH - padTop - padBottom;

    // Two columns per page. One column across a whole page runs to ~100
    // characters, which is why the first attempt read as a website in a
    // book-shaped box; two lands near 55, the measure magazines actually use.
    // Narrow pages fall back to one, where two would be unreadably tight.
    const columns = contentW >= 460 ? 2 : 1;
    const colGap = columns === 2 ? Math.round(Math.max(20, Math.min(34, contentW * 0.05))) : 0;
    const colW = Math.floor((contentW - colGap * (columns - 1)) / columns);

    // Distance from one page's first column to the next page's first column.
    const strideW = columns * (colW + colGap);

    return {
      spread,
      pageW,
      pageH,
      padX,
      padTop,
      padBottom,
      contentW,
      contentH,
      columns,
      colGap,
      colW,
      strideW,
      // A fingerprint: repagination is only needed when one of these changes.
      key: [spread, pageW, pageH, document.documentElement.dataset.fontScale || '1'].join(':'),
    };
  }

  //: Right-hand breathing room for the column clip, in px.
  const CLIP_SLACK = 6;

  /* Fonts are the one thing we genuinely have to wait for, and only once per
     document. Images we do NOT wait for: every figure carries its intrinsic
     width and height from the fetch, so the browser can reserve exactly the
     right box from the HTML attributes alone. Awaiting `decode()` on ~180
     full-size JPEGs took roughly three seconds per article; skipping it costs
     nothing in accuracy because the layout never depended on the pixels. */
  let fontsReady = null;

  function whenFontsReady() {
    if (!fontsReady) {
      fontsReady =
        document.fonts && document.fonts.ready
          ? document.fonts.ready.catch(() => {})
          : Promise.resolve();
    }
    return fontsReady;
  }

  function styleFlow(flow, geo) {
    flow.classList.add('flow');
    flow.style.width = geo.contentW + 'px';
    flow.style.height = geo.contentH + 'px';
    flow.style.columnWidth = geo.colW + 'px';
    flow.style.columnGap = geo.colGap + 'px';

    // Cap figures against the *column*, not the viewport. A figure taller than
    // its column is not clipped by multi-column layout -- it spills out of the
    // column box and the next column's text paints straight over it. Leaving
    // room for a caption keeps the whole figure inside one column.
    flow.style.setProperty('--fig-max-h', Math.round(geo.contentH * 0.44) + 'px');
    flow.style.setProperty('--col-w', geo.colW + 'px');
    return flow;
  }

  /**
   * Measure one article into page slices.
   * Returns { pages, flow } -- `flow` is retained so each page can clone it
   * rather than rebuilding the article's DOM once per page.
   */
  async function measure(buildFlow, geo, host) {
    await whenFontsReady();

    const probe = document.createElement('div');
    probe.className = 'measure-probe';
    probe.style.width = geo.contentW + 'px';
    probe.style.height = geo.contentH + 'px';

    const flow = styleFlow(buildFlow(), geo);
    probe.append(flow);
    host.append(probe);

    // scrollWidth is the whole strip. The trailing column has no gap after it,
    // so add one back before dividing by the per-page stride -- otherwise a
    // full final page rounds down and its text is silently dropped.
    const pages = Math.max(1, Math.round((flow.scrollWidth + geo.colGap) / geo.strideW));

    probe.remove();
    return { pages, flow };
  }

  /** A single page: a clipped window onto column `index` of the article flow.
   *
   * `sourceFlow` is the already-measured subtree; each page takes a clone,
   * which is far cheaper than rebuilding the article per page. */
  function buildPage(sourceFlow, geo, index, meta) {
    const page = document.createElement('div');
    page.className = 'page';
    page.style.width = geo.pageW + 'px';
    page.style.height = geo.pageH + 'px';

    const win = document.createElement('div');
    win.className = 'page-window';
    win.style.padding = geo.padTop + 'px ' + geo.padX + 'px ' + geo.padBottom + 'px';

    // The clip must be the content box exactly. `overflow: hidden` on the
    // padded window clips at the *padding* box, which let a slice of the
    // neighbouring column show through in each margin.
    const clip = document.createElement('div');
    clip.className = 'page-clip';
    // A few pixels of slack on the right. Justified text, hyphenation and
    // fractional layout can all put a glyph a hair past the column edge, and
    // with the clip sized to the exact column that hair becomes a sliced
    // character on every line. The gap to the next column is ~30px, so this
    // cannot expose neighbouring text.
    clip.style.width = geo.contentW + CLIP_SLACK + 'px';
    clip.style.height = geo.contentH + 'px';

    const flow = styleFlow(sourceFlow.cloneNode(true), geo);
    flow.style.transform = 'translateX(' + -index * geo.strideW + 'px)';

    clip.append(flow);
    win.append(clip);
    page.append(win);

    // Furniture is an overlay driven by page metadata, deliberately outside
    // the text flow -- so it stays put when the text repaginates.
    if (meta) {
      const head = document.createElement('div');
      head.className = 'page-running-head';
      head.textContent = meta.runningHead || '';
      page.append(head);

      const folio = document.createElement('div');
      folio.className = 'page-folio';
      folio.textContent = meta.folio == null ? '' : String(meta.folio);
      page.append(folio);
    }

    return page;
  }

  return { geometry, measure, buildPage, whenFontsReady };
})();

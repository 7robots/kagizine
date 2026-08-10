/* Magazine mode: the edition as pages you turn.
 *
 * Pagination and turning are kept strictly apart. Every page is measured and
 * built before the flipbook is handed the elements, so a drag never triggers
 * layout, image decoding or DOM construction -- that separation is the whole
 * reason the gesture stays smooth.
 *
 * Repagination happens only when the geometry fingerprint changes, and the
 * reading position is restored by article, never by page number: page 143 is
 * meaningless after a resize.
 */
'use strict';

window.Magazine = (function () {
  let flip = null;
  let pages = [];
  let current = { articleId: null };
  let geoKey = null;
  let spread = false;
  let resizeTimer = null;

  function destroy() {
    if (flip) {
      try { flip.destroy(); } catch (e) { /* already gone */ }
      flip = null;
    }
    pages = [];
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey);
  }

  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const geo = window.Paginator.geometry();
      if (geo.key === geoKey) return; // a scrollbar appearing is not a resize
      const anchor = currentArticleId();
      render(lastCtx, anchor);
    }, 220);
  }

  function onKey(e) {
    if (!flip || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      turn(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      turn(-1);
    }
  }

  function currentArticleId() {
    if (!flip) return current.articleId;
    const i = flip.getCurrentPageIndex();
    return pages[i] ? pages[i].articleId : current.articleId;
  }

  /** Which story a spread is *about*.
   *
   * StPageFlip reports the left-hand leaf, but when a story opens on the
   * right-hand page the left one is only the tail of the previous piece --
   * naming that is naming what the reader has just finished rather than what
   * they are looking at. */
  function labelArticleId(index) {
    const left = pages[index];
    const right = pages[index + 1];
    if (
      spread &&
      right &&
      right.kind === 'article' &&
      right.index === 0 &&
      (!left || right.articleId !== left.articleId)
    ) {
      return right.articleId;
    }
    return left ? left.articleId : null;
  }

  let lastCtx = null;

  /**
   * ctx = { edition, articles, assetUrl, renderBlocks, onExit, onPage }
   */
  async function render(ctx, anchorArticleId) {
    lastCtx = ctx;
    destroy();

    const host = document.getElementById('magazine');
    host.replaceChildren();

    const geo = window.Paginator.geometry();
    geoKey = geo.key;
    spread = geo.spread;

    const stage = document.createElement('div');
    stage.className = 'mag-stage' + (geo.spread ? '' : ' --portrait');
    host.append(stage);

    const probeHost = document.createElement('div');
    probeHost.className = 'measure-host';
    host.append(probeHost);

    const status = document.createElement('div');
    status.className = 'mag-status';
    status.textContent = 'Setting the pages…';
    host.append(status);

    // --- build the page list -------------------------------------------
    const descriptors = [];

    descriptors.push({ kind: 'cover', articleId: null });

    const ordered = ctx.edition.sections.flatMap((s) =>
      s.article_ids.map((id) => ({ id, section: s }))
    );

    for (let n = 0; n < ordered.length; n++) {
      const { id, section } = ordered[n];
      const article = ctx.articles[id];
      if (!article) continue;

      const build = () => ctx.renderArticleFlow(article, section);
      const { pages: count, flow } = await window.Paginator.measure(build, geo, probeHost);

      for (let i = 0; i < count; i++) {
        descriptors.push({
          kind: 'article',
          articleId: id,
          section,
          flow,
          index: i,
          of: count,
        });
      }

      if ((n & 3) === 0) {
        status.textContent = `Setting the pages… ${n + 1} of ${ordered.length}`;
        await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
      }
    }

    // A spread needs an even number of leaves after the cover.
    if (geo.spread && descriptors.length % 2 !== 0) {
      descriptors.push({ kind: 'blank', articleId: null });
    }

    // --- materialise -----------------------------------------------------
    let folio = 0;
    pages = descriptors;

    descriptors.forEach((d, i) => {
      let el;
      if (d.kind === 'cover') {
        el = buildCover(ctx, geo);
      } else if (d.kind === 'blank') {
        el = buildBlank(geo);
      } else {
        folio += 1;
        el = window.Paginator.buildPage(d.flow, geo, d.index, {
          runningHead: d.index === 0 ? d.section.title : ctx.articles[d.articleId].title,
          folio,
        });
      }
      el.dataset.density = d.kind === 'cover' ? 'hard' : 'soft';
      el.dataset.pageIndex = String(i);
      d.el = el;
      stage.append(el);
    });

    status.remove();

    // --- hand the finished pages to the flipbook -------------------------
    flip = new St.PageFlip(stage, {
      width: geo.pageW,
      height: geo.pageH,
      size: 'fixed',
      showCover: true,
      usePortrait: !geo.spread,
      // A lifted sheet occludes the page under it far more than the default
      // suggests; the weak version is a large part of why a turn reads as two
      // flat images swapping rather than paper moving over paper.
      maxShadowOpacity: 0.82,
      drawShadow: true,
      flippingTime: prefersReducedMotion() ? 0 : 620,
      swipeDistance: 20,
      useMouseEvents: true,
      mobileScrollSupport: false,
    });

    flip.loadFromHTML(stage.querySelectorAll('.page, .mag-cover, .mag-blank'));

    flip.on('flip', (e) => {
      current.articleId = labelArticleId(e.data);
      if (ctx.onPage) ctx.onPage(current.articleId, e.data, pages.length);
    });

    if (anchorArticleId) {
      const target = pages.findIndex((p) => p.articleId === anchorArticleId);
      if (target > 0) flip.turnToPage(target);
    }

    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey);

    const at = flip.getCurrentPageIndex();
    current.articleId = labelArticleId(at);
    if (ctx.onPage) ctx.onPage(current.articleId, at, pages.length);
    return { pageCount: pages.length };
  }

  function prefersReducedMotion() {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* The cover.
   *
   * A daily has no commissioned cover art, so it is built the way a newspaper
   * front is: the masthead, the date, and the lead story's picture and
   * headline. The lead headline is what makes it read as *this* day's issue
   * rather than a title card. */
  function buildCover(ctx, geo) {
    const el = document.createElement('div');
    el.className = 'mag-cover';
    el.style.width = geo.pageW + 'px';
    el.style.height = geo.pageH + 'px';

    if (ctx.edition.cover_asset) {
      const img = document.createElement('img');
      img.src = ctx.assetUrl(ctx.edition.cover_asset);
      img.alt = '';
      el.append(img);
    }

    const masthead = document.createElement('div');
    masthead.className = 'mag-cover-masthead';
    const brand = document.createElement('p');
    brand.className = 'mag-cover-brand';
    brand.textContent = 'Kagi News';
    masthead.append(brand);
    const date = document.createElement('p');
    date.className = 'mag-cover-date';
    date.textContent = coverDate(ctx.edition);
    masthead.append(date);
    el.append(masthead);

    const band = document.createElement('div');
    band.className = 'mag-cover-band';
    if (ctx.coverLine) {
      const h = document.createElement('h1');
      h.textContent = ctx.coverLine;
      band.append(h);
    }
    const sub = document.createElement('p');
    const n = Object.keys(ctx.articles).length;
    sub.textContent =
      n + ' stories · ' + ctx.edition.sections.map((s) => s.title).join(' · ');
    band.append(sub);
    el.append(band);
    return el;
  }

  function coverDate(edition) {
    const d = new Date(edition.date + 'T12:00:00');
    if (isNaN(d)) return edition.date;
    return d.toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  function buildBlank(geo) {
    const el = document.createElement('div');
    el.className = 'mag-blank';
    el.style.width = geo.pageW + 'px';
    el.style.height = geo.pageH + 'px';
    return el;
  }

  /* ------------------------------------------------------------------
   * The curl.
   *
   * StPageFlip keeps doing what it is good at -- page bookkeeping, drag
   * gestures, spread state. But for a commanded turn we run our own
   * cylindrical curl over the top, because a hinged fold cannot be shaded
   * into looking like a rolled sheet.
   *
   * Live DOM at rest; the WebGL quad only exists for the duration of the
   * motion. If anything in the chain fails -- no WebGL2, capture rejected --
   * we fall through to StPageFlip's own animation rather than breaking the
   * reader.
   * ------------------------------------------------------------------ */

  let cssText = null;
  let curling = false;

  async function readerCss() {
    if (cssText !== null) return cssText;
    const hrefs = [...document.styleSheets].map((s) => s.href).filter(Boolean);
    const parts = await Promise.all(
      hrefs.map((h) => fetch(h).then((r) => r.text()).catch(() => ''))
    );
    cssText = parts.join('\n');
    return cssText;
  }

  function visibleLeaf(side) {
    const items = [...document.querySelectorAll('.stf__item')].filter(
      (n) => n.style.display !== 'none'
    );
    return items.find((n) => n.classList.contains(side)) || items[items.length - 1];
  }

  async function curlTurn(direction) {
    if (curling || !flip) return false;
    if (!window.Curl || !window.Curl.supported() || prefersReducedMotion()) return false;

    const front = visibleLeaf(direction > 0 ? '--right' : '--left');
    if (!front) return false;

    const w = front.offsetWidth;
    const h = front.offsetHeight;
    if (!w || !h || !window.Curl.init(w, h)) return false;

    curling = true;
    try {
      const css = await readerCss();

      // What the turn reveals: the page two positions on, which is what the
      // reader will be looking at once the leaf has landed.
      const idx = flip.getCurrentPageIndex();
      const revealed = pages[idx + direction * 2] || pages[idx + direction];
      const backEl = revealed && revealed.el ? revealed.el : front;

      const [frontImg, backImg] = await Promise.all([
        window.Curl.capture(front, w, h, css),
        window.Curl.capture(backEl, w, h, css),
      ]);

      const tex = window.Curl.textures;
      window.Curl.upload(tex.front, frontImg);
      window.Curl.upload(tex.back, backImg);

      const rect = front.getBoundingClientRect();
      const cv = window.Curl.canvas;
      cv.style.position = 'fixed';
      cv.style.left = rect.left + 'px';
      cv.style.top = rect.top + 'px';
      cv.style.zIndex = '15';
      cv.style.pointerEvents = 'none';
      document.getElementById('magazine').append(cv);

      await animateCurl(direction);

      // Land on the real page, instantly -- the motion has already happened.
      flip.getSettings().flippingTime = 0;
      if (direction > 0) flip.flipNext('top');
      else flip.flipPrev('top');

      await new Promise((r) => requestAnimationFrame(r));
      cv.remove();
      return true;
    } catch (e) {
      return false;
    } finally {
      curling = false;
    }
  }

  function animateCurl(direction) {
    return new Promise((resolve) => {
      const duration = 620;
      const corner = direction > 0 ? -0.18 : 0.18;
      const start = performance.now();

      function frame(now) {
        const t = Math.min(1, (now - start) / duration);
        // Ease-out: the sheet leaves quickly and settles gently, which is
        // what a real page does once gravity takes it.
        const eased = 1 - Math.pow(1 - t, 2.4);
        window.Curl.draw(eased, corner);
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  /** Set true to route commanded turns through the WebGL curl.
   *
   * OFF deliberately. `curlTurn` below is complete and its pieces are
   * verified in isolation -- WebGL2 initialises, and `Curl.capture` returns a
   * correctly sized raster of a real page -- but end to end it still bails
   * before showing the canvas, and the cause is not yet found. Until it is
   * demonstrably working it stays off rather than silently falling back and
   * looking like a feature that exists. See docs/curl.md.
   */
  const USE_CURL = false;

  async function turn(direction) {
    if (USE_CURL && (await curlTurn(direction))) return;
    // StPageFlip's fold: what actually ships today.
    if (!flip) return;
    flip.getSettings().flippingTime = prefersReducedMotion() ? 0 : 620;
    if (direction > 0) flip.flipNext();
    else flip.flipPrev();
  }

  return {
    render,
    destroy,
    next: () => turn(1),
    prev: () => turn(-1),
    goToArticle: (id) => {
      const i = pages.findIndex((p) => p.articleId === id);
      if (i >= 0 && flip) flip.turnToPage(i);
    },
  };
})();

/* The reader.
 *
 * Deliberately a single classic script with no build step and no framework: it
 * is served as-is from the Assets layer, so it never waits on Pyodide and there
 * is no bundle to invalidate. State lives in the URL hash, so back/forward and
 * reload land where you were.
 *
 * Every string that came from the feed is inserted as textContent. Only
 * `Paragraph.html` and list items are set as HTML, and those are sanitised in
 * src/kagi/feed.py at the data boundary; everything else is plain text and must
 * be escaped, which is what textContent does for us.
 */
'use strict';

const app = document.getElementById('app');
const backBtn = document.getElementById('back');
const archiveBtn = document.getElementById('archive');
const editionName = document.getElementById('edition-name');

const state = { date: null, edition: null, articles: null };

/* Everything fetched so far.
 *
 * An edition is a single JSON document of a few hundred kilobytes, so it is
 * cached whole for the session: paging between contents, a story and magazine
 * mode then costs nothing, and the archive can be browsed without refetching
 * the day you came from.
 */
const cache = { editions: null, byDate: Object.create(null) };

// ---------------------------------------------------------------- helpers

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function readingTime(words) {
  return Math.max(1, Math.round(words / 250)) + ' min';
}

function assetUrl(name) {
  return '/img/' + name;
}

/** "Sat 9 Aug" -- enough to place a story in the week without being noise. */
function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function longDate(date) {
  // Midday, so a timezone west of UTC cannot roll the date back a day.
  const d = new Date(date + 'T12:00:00');
  if (isNaN(d)) return date;
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** The line under a headline: when it happened, how long it takes, how well
 *  sourced it is. Kagi items have no standfirst, so this does that work. */
function articleMeta(a) {
  const bits = [];
  if (a.published) bits.push(shortDate(a.published));
  bits.push(readingTime(a.word_count));
  if (a.sources && a.sources.length) {
    bits.push(a.sources.length + (a.sources.length === 1 ? ' source' : ' sources'));
  }
  return bits.join(' · ');
}

function uniqueDomains(sources) {
  const seen = [];
  for (const s of sources || []) {
    if (s.domain && seen.indexOf(s.domain) === -1) seen.push(s.domain);
  }
  return seen;
}

// -------------------------------------------------------------------- api

async function getJSON(path) {
  const r = await fetch(path, { headers: { accept: 'application/json' } });
  if (!r.ok) {
    const err = new Error('HTTP ' + r.status);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function loadIndex(force) {
  if (cache.editions && !force) return cache.editions;
  const data = await getJSON('/api/editions');
  cache.editions = data.editions || [];
  return cache.editions;
}

async function loadEdition(date) {
  if (state.date === date && state.edition) return true;
  if (!cache.byDate[date]) {
    try {
      cache.byDate[date] = await getJSON('/api/editions/' + encodeURIComponent(date));
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  }
  const day = cache.byDate[date];
  state.date = date;
  state.edition = day.edition;
  state.articles = day.articles;
  return true;
}

function latestDate() {
  return cache.editions && cache.editions.length ? cache.editions[0].date : null;
}

// ------------------------------------------------------------------ notices

function notice(heading, detail, retry) {
  const wrap = el('div', 'notice');
  wrap.append(el('h1', null, heading));
  if (detail) wrap.append(el('p', null, detail));
  if (retry) {
    const btn = el('button', 'notice-retry', 'Try again');
    btn.addEventListener('click', () => route(true));
    wrap.append(btn);
  }
  app.replaceChildren(wrap);
  editionName.textContent = 'Kagi News';
  backBtn.hidden = true;
  archiveBtn.hidden = true;
}

function noEditions() {
  notice(
    'Nothing published yet',
    'The first edition is built by the daily refresh, shortly after 08:15 Eastern. ' +
      'If this is a new deployment, nothing has run yet.',
    true
  );
}

function offline(e) {
  notice(
    'Could not reach the edition',
    'The reader is here but the day’s stories did not load' + (e && e.status ? ' (HTTP ' + e.status + ')' : '') + '.',
    true
  );
}

// ------------------------------------------------------------------ archive

function renderArchive() {
  const list = cache.editions || [];
  document.title = 'Kagi News';
  editionName.textContent = 'Kagi News';
  backBtn.hidden = true;
  archiveBtn.hidden = true;
  app.replaceChildren();

  if (!list.length) return noEditions();

  const wrap = el('div', 'shelf');
  wrap.append(el('h1', null, 'Archive'));

  const ul = el('ul', 'editions');
  for (const ed of list) {
    const card = el('a', 'edition-card');
    card.href = '#/' + ed.date;
    if (ed.cover_asset) {
      const img = el('img');
      img.src = assetUrl(ed.cover_asset);
      img.alt = '';
      img.loading = 'lazy';
      card.append(img);
    }
    const meta = el('div', 'meta');
    meta.append(el('strong', null, longDate(ed.date)));
    meta.append(
      el('span', null, ed.article_count + ' stories in ' + ed.section_count + ' sections')
    );
    card.append(meta);
    const li = document.createElement('li');
    li.append(card);
    ul.append(li);
  }
  wrap.append(ul);
  app.append(wrap);
  window.scrollTo(0, 0);
}

// --------------------------------------------------------------- contents

function renderContents(date) {
  document.title = state.edition.title;
  editionName.textContent = 'Kagi News';
  backBtn.hidden = true;
  archiveBtn.hidden = false;
  app.replaceChildren();

  const wrap = el('div', 'contents');
  const head = el('header', 'contents-head');
  head.append(
    el('p', 'contents-eyebrow', date === latestDate() ? 'Today’s edition' : 'From the archive')
  );
  head.append(el('h1', null, longDate(state.edition.date)));

  const ids = orderedIds();
  const words = ids.reduce(
    (n, id) => n + ((state.articles[id] && state.articles[id].word_count) || 0),
    0
  );
  head.append(
    el('p', 'contents-sub', ids.length + ' stories · about ' + readingTime(words) + ' end to end')
  );

  const readBtn = el('a', 'read-cta', 'Read as a magazine');
  readBtn.href = '#/' + date + '/read';
  head.append(readBtn);
  wrap.append(head);

  for (const section of state.edition.sections) {
    const block = el('section', 'section-block');
    block.append(el('h2', 'section-heading', section.title));

    const ul = el('ul', 'toc');
    for (const id of section.article_ids) {
      const a = state.articles[id];
      if (!a) continue;

      const link = el('a');
      link.href = '#/' + date + '/' + id;

      const title = el('div', 'toc-title');
      title.append(el('span', null, a.title));
      const sub = el('span', 'toc-sub');
      sub.textContent = (a.rubric ? a.rubric + ' · ' : '') + articleMeta(a);
      title.append(sub);
      link.append(title);

      const thumb = a.blocks.find((b) => b.kind === 'figure');
      if (thumb) {
        const img = el('img', 'toc-thumb');
        img.src = assetUrl(thumb.asset);
        img.alt = '';
        img.loading = 'lazy';
        link.append(img);
      }

      const li = document.createElement('li');
      li.append(link);
      ul.append(li);
    }
    block.append(ul);
    wrap.append(block);
  }
  app.append(wrap);
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- article

function renderBlock(b) {
  switch (b.kind) {
    case 'p': {
      const p = document.createElement('p');
      p.innerHTML = b.html; // sanitised at the data boundary
      return p;
    }
    case 'h':
      return el('h' + Math.min(Math.max(b.level, 2), 4), null, b.text);

    case 'quote': {
      const q = document.createElement('blockquote');
      q.append(el('span', null, b.text));
      if (b.attribution) q.append(el('cite', null, b.attribution));
      return q;
    }

    case 'list': {
      const list = document.createElement(b.ordered ? 'ol' : 'ul');
      for (const item of b.items) {
        const li = document.createElement('li');
        li.innerHTML = item; // sanitised at the data boundary
        list.append(li);
      }
      return list;
    }

    case 'figure': {
      const fig = document.createElement('figure');
      fig.dataset.role = b.role;
      const img = el('img');
      img.src = assetUrl(b.asset);
      img.alt = b.alt || '';
      img.width = b.width;
      img.height = b.height;
      img.loading = 'lazy';
      fig.append(img);
      if (b.caption || b.credit) {
        const cap = el('figcaption');
        if (b.caption) cap.append(el('span', null, b.caption));
        if (b.credit) cap.append(el('span', 'credit', b.credit));
        fig.append(cap);
      }
      return fig;
    }
  }
  return null;
}

/** The source list, as furniture rather than body text.
 *
 * A Kagi story can cite sixty outlets. Set open, that list is longer than the
 * article and the eye reaches the foot of the page still scrolling through
 * URLs, so it is folded away behind its own count: available, not in the way.
 */
function sourceList(a) {
  if (!a.sources || !a.sources.length) return null;
  const wrap = document.createElement('details');
  wrap.className = 'sources';
  const summary = document.createElement('summary');
  summary.textContent = a.sources.length + (a.sources.length === 1 ? ' source' : ' sources');
  wrap.append(summary);
  const ul = el('ul');
  for (const s of a.sources) {
    const li = document.createElement('li');
    const link = el('a', null, s.title || s.url);
    link.href = s.url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    li.append(link);
    if (s.domain) li.append(el('span', 'domain', s.domain));
    ul.append(li);
  }
  wrap.append(ul);
  return wrap;
}

function renderArticle(date, id) {
  const a = state.articles[id];
  if (!a) return renderContents(date);

  document.title = a.title;
  editionName.textContent = sectionTitle(a.section_slug);
  backBtn.hidden = false;
  archiveBtn.hidden = true;
  app.replaceChildren();

  const article = document.createElement('article');

  article.append(el('p', 'rubric', a.rubric || sectionTitle(a.section_slug)));
  article.append(el('h1', null, a.title));
  article.append(el('div', 'byline', articleMeta(a)));

  const prose = el('div', 'prose');
  for (const b of a.blocks) {
    const node = renderBlock(b);
    if (node) prose.append(node);
  }
  article.append(prose);

  if (a.source_url) {
    const link = el('a', 'source-link', 'Open on Kagi News');
    link.href = a.source_url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    article.append(link);
  }

  const sources = sourceList(a);
  if (sources) article.append(sources);

  app.append(article);
  app.append(articleNav(date, id));
  window.scrollTo(0, 0);
}

function sectionTitle(slug) {
  const s = state.edition.sections.find((x) => x.slug === slug);
  return s ? s.title : slug;
}

function orderedIds() {
  return state.edition.sections.flatMap((s) => s.article_ids);
}

function articleNav(date, id) {
  const ids = orderedIds();
  const i = ids.indexOf(id);
  const nav = el('nav', 'article-nav');

  const add = (targetId, label) => {
    if (!targetId) return nav.append(el('span'));
    const a = state.articles[targetId];
    const link = el('a');
    link.href = '#/' + date + '/' + targetId;
    link.append(el('span', 'dir', label));
    link.append(el('span', null, a ? a.title : 'Contents'));
    nav.append(link);
  };

  add(i > 0 ? ids[i - 1] : null, 'Previous');
  add(i >= 0 && i < ids.length - 1 ? ids[i + 1] : null, 'Next');
  return nav;
}

// --------------------------------------------------------- magazine mode

/** One article as a single flowed subtree, for the paginator to column-break. */
function renderArticleFlow(a, section) {
  const flow = el('div');

  flow.append(el('p', 'rubric', a.rubric || section.title));
  flow.append(el('h1', null, a.title));
  flow.append(el('p', 'kicker', articleMeta(a)));

  for (const b of a.blocks) {
    const node = renderBlock(b);
    if (node) flow.append(node);
  }

  // The story closes on its sources, compressed to outlets. Naming who
  // reported it belongs on the page; sixty headlines and URLs do not.
  const domains = uniqueDomains(a.sources);
  if (domains.length) {
    const shown = domains.slice(0, 10);
    const rest = domains.length - shown.length;
    flow.append(
      el(
        'p',
        'flow-sources',
        'Reported by ' + shown.join(' · ') + (rest > 0 ? ' and ' + rest + ' more' : '')
      )
    );
  } else {
    flow.append(el('p', 'flow-sources', ''));
  }
  return flow;
}

async function renderMagazine(date, anchor) {
  document.title = state.edition.title;
  editionName.textContent = state.edition.title;
  backBtn.hidden = false;
  app.replaceChildren();

  const root = el('div', 'mag-root');
  root.id = 'magazine';
  document.body.append(root);
  document.body.classList.add('in-magazine');

  // The bar is built here but attached after render(), which clears its host.
  const bar = el('div', 'mag-bar');
  const prev = el('button', null, '‹');
  const label = el('span', 'mag-label');
  const pos = el('span', 'pos');
  const next = el('button', null, '›');
  const exit = el('button', null, 'Contents');
  bar.append(exit, prev, label, pos, next);

  prev.addEventListener('click', () => window.Magazine.prev());
  next.addEventListener('click', () => window.Magazine.next());
  exit.addEventListener('click', exitMagazine);

  await window.Magazine.render(
    {
      edition: state.edition,
      articles: state.articles,
      assetUrl,
      renderArticleFlow,
      coverLine: leadHeadline(),
      onPage: (articleId, index, total) => {
        pos.textContent = index + 1 + ' / ' + total;
        const a = articleId && state.articles[articleId];
        label.textContent = a ? a.title : state.edition.title;
      },
    },
    anchor
  );

  root.append(bar);
}

function leadHeadline() {
  const first = orderedIds()[0];
  const a = first && state.articles[first];
  return a ? a.title : '';
}

function exitMagazine() {
  window.Magazine.destroy();
  document.body.classList.remove('in-magazine');
  const root = document.getElementById('magazine');
  if (root) root.remove();
  location.hash = '#/' + state.date;
}

function leaveMagazineIfOpen() {
  const root = document.getElementById('magazine');
  if (!root) return;
  window.Magazine.destroy();
  document.body.classList.remove('in-magazine');
  root.remove();
}

// ----------------------------------------------------------------- routing

/* Hash shapes:
 *   #/                        today's contents
 *   #/archive                 every stored edition
 *   #/<date>                  that edition's contents
 *   #/<date>/read             magazine mode from the cover
 *   #/<date>/read/<id>        magazine mode at one story
 *   #/<date>/<section>/<slug> one story, scrolling
 * An article id is itself "section/slug", so it arrives split in two.
 */
async function route(force) {
  leaveMagazineIfOpen();

  const parts = decodeURIComponent(location.hash.replace(/^#\/?/, ''))
    .split('/')
    .filter((p) => p !== '');

  try {
    await loadIndex(force);
  } catch (e) {
    return offline(e);
  }

  if (!cache.editions.length) return noEditions();

  const wantsArchive = parts[0] === 'archive';
  const date = wantsArchive ? null : parts[0] || latestDate();

  if (wantsArchive || !date) return renderArchive();

  try {
    if (!(await loadEdition(date))) return renderArchive();
  } catch (e) {
    return offline(e);
  }

  if (parts[1] === 'read') {
    return renderMagazine(date, parts[3] ? parts[2] + '/' + parts[3] : null);
  }
  if (parts.length >= 3) return renderArticle(date, parts[1] + '/' + parts[2]);
  return renderContents(date);
}

window.addEventListener('hashchange', () => route());

backBtn.addEventListener('click', () => {
  location.hash = state.date ? '#/' + state.date : '#/';
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const nav = document.querySelector('.article-nav');
  if (!nav) return;
  const links = nav.querySelectorAll('a');
  if (e.key === 'ArrowRight' && links.length) links[links.length - 1].click();
  if (e.key === 'ArrowLeft' && links.length > 1) links[0].click();
  if (e.key === 'Escape') backBtn.click();
});

/* Theme: an explicit choice wins over the system setting, and persists.
 *
 * Storage is wrapped because it is not always there to be used -- Safari in
 * private browsing and any embedded webview can make `localStorage` throw on
 * access rather than return null, and an uncaught throw at this point would
 * take the whole reader down with it over a colour preference.
 */
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* preference simply will not persist */
    }
  },
};

const themeBtn = document.getElementById('theme');
const saved = store.get('theme');
if (saved) document.documentElement.dataset.theme = saved;
themeBtn.addEventListener('click', () => {
  const now = document.documentElement.dataset.theme;
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const next = (now || (prefersDark ? 'dark' : 'light')) === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
});

route();

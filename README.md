# kagizine

A page-turning magazine reader for the [Kagi News](https://news.kagi.com/) daily
feeds, running as a Python Cloudflare Worker at
**[kagizine.7robots.org](https://kagizine.7robots.org)**.

Kagi rebuilds its feeds each morning around 08:00 Eastern. A cron trigger picks
them up, turns each cluster into an article, and stores the day's edition in R2.
Opening the site lands on today's contents; **Read as a magazine** turns it into
pages you turn.

The reading order is fixed, and matches the order of the feeds:

| Section       | Feed                                      |
| ------------- | ----------------------------------------- |
| World         | `https://news.kagi.com/world.xml`         |
| Science       | `https://news.kagi.com/science.xml`       |
| United States | `https://news.kagi.com/usa.xml`           |
| Boston        | `https://news.kagi.com/usa_\|_boston.xml` |

`news.kagi.com/science/latest` is the HTML page rather than a feed; `science.xml`
is the feed it points at, and is what gets fetched.

## Reading it

Open the site. Arrow keys, `PageUp`/`PageDown`, space, or dragging a page corner
turn the page; **Contents** in the bottom bar or `Esc` backs out; **Archive** in
the top bar reaches earlier editions (fourteen are kept).

Two-page spreads appear on windows wide enough for two readable columns (≥1100px
and landscape). Narrower or portrait windows get a single page, which on a phone
or an iPad in portrait fits most stories whole.

## Why Python

The Worker is Python on Pyodide, which is unusual enough to justify.

The payoff is that `src/kagi/` — the feed parser, the HTML sanitiser, the article
builder — is pure Python with no I/O, and it is the *same code* the test suite
runs under CPython and the Worker runs under Pyodide. There is one
implementation of the Kagi feed format rather than a local one and a deployed one
drifting apart. `xml.etree.ElementTree` and `html.parser` are both available
under Pyodide, which is what makes that possible.

The costs are real and worth knowing before copying this pattern:

- **No `urllib`, no `requests`** — a Worker has no sockets. All I/O is injected
  by the caller, so `build_edition` takes a `fetch_bytes` and a `put_image` and
  the tests pass in dictionaries.
- **No Pillow** — no PyEmscripten wheel. Image dimensions come from
  `src/kagi/images.py`, which reads them out of JPEG/PNG/GIF/WebP headers. Those
  numbers are load-bearing: the paginator sizes every figure from them without
  waiting for a decode, and a missing dimension shows up as text painted over a
  picture.
- **No threads** — `asyncio` with a concurrency cap instead.
- **The compatibility date is pinned inside a narrow window.** Recent Pyodide
  builds fail Cloudflare's deploy-time memory snapshot, and older ones want
  module-level `on_fetch` handlers instead of a `WorkerEntrypoint` class. Both
  walls, and how each one fails, are documented at length in `wrangler.jsonc`.
  Read that before touching the date.

## Working on it

```sh
npm install && uv sync
npm test                 # 87 unit tests, on the same Python version Pyodide runs
npm run dev              # local Worker, with a simulated R2 bucket
npm run deploy           # uv run pywrangler deploy
npm run tail             # production logs
```

The dev server starts with an empty bucket. To build an edition into it:

```sh
curl "http://127.0.0.1:8788/cdn-cgi/handler/scheduled?cron=15+12+*+*+*"
```

That runs the real cron path against the real feeds and writes to local R2.
Note `127.0.0.1` rather than `localhost` if you are driving a headless browser
against it.

A successful `deploy` does **not** mean a working Worker — the two failure modes
above are invisible at upload. Always follow a deploy with:

```sh
curl https://kagizine.7robots.org/api/health
```

## How it works

```
src/worker.py        the entrypoint: fetch (HTTP) and scheduled (cron)
src/kagi/feed.py     parse and sanitise one item -> one article    (pure)
src/kagi/build.py    sequence an edition, with I/O injected        (pure)
src/kagi/images.py   dimensions from image headers                 (pure)
src/kagi/store.py    R2, and the only Python/JavaScript boundary
public/              the reader: HTML, CSS, classic scripts
tests/               the pure modules, under CPython
```

In R2:

```
index.json            every stored edition, newest first
editions/<date>.json  one day: {"edition": {...}, "articles": {...}}
reports/<date>.json   what the refresh did, for reading after the fact
img/<sha256>.<ext>    pictures, content-addressed and shared between days
```

The bucket is the source of truth and `index.json` is derived from it. Pictures
are keyed by content hash, so identical photographs collapse to one object and
every image response can honestly say `immutable`.

### The API

| Route                     | |
| ------------------------- | --- |
| `GET /api/editions`       | the index |
| `GET /api/editions/:date` | one edition, whole |
| `GET /img/:asset`         | one picture, streamed from R2 |
| `GET /api/health`         | edition count and latest date |
| `POST /admin/refresh`     | rebuild now; bearer token required |

Static files are served by the Assets layer and never invoke the Worker, so the
reader's CSS and JS are on the edge cache rather than behind Pyodide.

### Two cron triggers, one event

Cron triggers are UTC only. Kagi rebuilds at 08:00 Eastern, which is 12:00 UTC
under EDT and 13:00 UTC under EST, so a single entry would drift by an hour at
every DST change. Both `15 12` and `15 13` fire year-round, and the refresh is
idempotent: the feeds state when they were last built, and if the stored edition
came from that same build the refresh exits before fetching a single picture.
That takes the redundant firing from ninety seconds to a third of a second.

`POST /admin/refresh` exists for seeding a new deployment and for recovering
from a failed run without waiting a day. It is gated on a bearer token because
it is a write path that makes ~35 outbound requests; if the secret is unset the
route 404s.

## How a feed becomes a page

A Kagi item is a cluster summary: body paragraphs, one picture, then Highlights,
Perspectives, and every outlet that carried the story — sometimes sixty. Each
part is treated according to what it is:

- **Body, Highlights, Perspectives** become the article.
- **The picture** opens the story, and the lead story's picture becomes the
  cover, with the masthead and date over it.
- **Sources** are apparatus, not reading. Magazine mode closes a story on one
  line of outlet names; the scrolling view folds the full list behind its count.

Feed items carry no standfirst, so the line under each headline is built from
what a cluster does have: when it happened, how long it takes to read, how many
outlets it draws on.

## Security

The reader sets exactly two things as HTML: `Paragraph.html` and list items.
Both are sanitised in `src/kagi/feed.py` by a parser that emits only tags it
wrote itself, with `href`s restricted to `http`/`https`. Everything else that
came from a feed reaches the DOM through `textContent`. Adding a field to the
reader means deciding which of those two categories it is in.

Security headers are set in two places on purpose: `src/worker.py` for responses
the Worker generates, and `public/_headers` for static responses that bypass the
Worker entirely. The CSP forbids `unsafe-eval`, which is strict enough that
Playwright's `wait_for_function` cannot run against the site — poll locators
instead.

## Provenance

The paginator, the flipbook integration, and the printed-page CSS are adapted
from a reader originally built for The Economist's weekly edition. The data
layer, the Worker, and the furniture a daily needs and a weekly does not — a
generated cover, a kicker in place of a standfirst, source apparatus — are new.

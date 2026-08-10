# kagizine

A page-turning magazine reader for the [Kagi News](https://news.kagi.com/) daily
feeds, running as a TypeScript Cloudflare Worker at
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

Each section gets an opening page, placed on a left-hand page so it faces the
section's first story. Stories are marked read as you go — on the contents page
they dim and take a tick, and the header keeps an unread count with a mark-all
toggle. That state is local to the browser and is pruned as editions age out.

If the morning's fetch had trouble — a feed that did not answer, pictures that
would not load, a story that could not be parsed — the contents page says so in
a short note. A clean build says nothing.

Two-page spreads appear on windows wide enough for two readable columns (≥1100px
and landscape). Narrower or portrait windows get a single page, which on a phone
or an iPad in portrait fits most stories whole.

## It was Python first

The Worker was originally written in Python on Pyodide, and the git history has
it. The appeal was that `src/kagi/` could be pure standard-library Python shared
between the Worker and a CPython test suite -- one implementation of the feed
format rather than two drifting apart.

It was ported to TypeScript for one measured reason and two structural ones.

The measured one: **a full refresh cost 17.1s of CPU in Python and costs 307ms
in TypeScript**, a factor of fifty-six. Almost all of the Python time was
copying image bytes across the Python/JavaScript boundary twice -- into the
interpreter to be hashed, back out to R2 -- while the parsing itself was 0.03s.
In TypeScript the bytes never leave the runtime: `arrayBuffer()` ->
`crypto.subtle.digest` -> `bucket.put`. A build that sat at 17s against a 30s
ceiling now has a hundredfold margin.

The structural ones: the Python runtime was pinned eleven months back, wedged
between a Pyodide build that failed Cloudflare's deploy-time memory snapshot and
an older one that predated `WorkerEntrypoint`, so it could not be moved forward;
and the toolchain needed `pywrangler`, a vendored `python_modules/`, and three
lockfiles for one small app.

What did *not* turn out to be a reason, despite being the argument that prompted
the port: request latency. Measured with a fresh connection per request, the
Python Worker looked like it was taking 2-4 seconds. Measured properly -- over
one reused connection, so the TLS handshake is not counted -- the Worker adds
essentially nothing over a static file (41ms median against 42ms for
`/css/reader.css`), and an R2 read adds 40-100ms. The seconds were handshake and
network variance in the machine doing the measuring. The port stands on CPU and
maintainability; the latency argument was measurement error.

## Working on it

```sh
npm install
npm test                 # 113 tests, inside workerd
npm run typecheck        # tsc --noEmit
npm run dev              # local Worker, with a simulated R2 bucket
npm run deploy           # wrangler deploy
npm run tail             # production logs
```

The tests run in workerd rather than Node, which is a requirement rather than a
preference: the sanitiser is built on `HTMLRewriter` and the content-addressing
on `crypto.subtle`, so a Node harness could only exercise a reimplementation of
the part that matters. Coverage is weighted towards attempts to defeat the
sanitiser.

Two configuration traps, both of which fail at load with unhelpful errors:
`defineWorkersConfig` from `@cloudflare/vitest-pool-workers/config` does not
exist in the vitest-4 line -- the entry point is the `cloudflareTest` plugin --
and the package is ESM-only, so the config must be `vitest.config.mts` unless the
whole package becomes `type: module`.

The port from Python was additionally verified by building an edition with both
implementations from the same feeds and diffing the results: identical article
ids, blocks, sanitised markup, word counts and image content hashes.

The dev server starts with an empty bucket. To build an edition into it:

```sh
curl "http://127.0.0.1:8788/cdn-cgi/handler/scheduled?cron=15+12+*+*+*"
```

That runs the real cron path against the real feeds and writes to local R2.
Note `127.0.0.1` rather than `localhost` if you are driving a headless browser
against it.

Always follow a deploy with a live check:

```sh
curl https://kagizine.7robots.org/api/health
```

## How it works

```
src/index.ts         the entrypoint: fetch (HTTP) and scheduled (cron)
src/kagi/feed.ts     parse and sanitise one item -> one article
src/kagi/build.ts    sequence an edition, with I/O injected
src/kagi/images.ts   dimensions from image headers
src/kagi/store.ts    R2
public/              the reader: HTML, CSS, classic scripts
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
| `GET /api/reports/:date`  | what that morning's refresh did |
| `GET /api/health`         | edition count, latest date, and the last build's outcome |
| `POST /admin/refresh`     | rebuild now; bearer token required |

Static files are served by the Assets layer and never invoke the Worker at all,
so the reader's CSS and JS come off the edge cache.

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

**The threat model is that feed content is entirely untrusted** — item titles,
description HTML, `<img src>` URLs, source links, even the `lastBuildDate`.
A compromised upstream, one malicious outlet inside a cluster, or interception of
`news.kagi.com` all land in the same place. Everything below follows from that.

There are no accounts, no user-submitted data and no payments, so the realistic
damage from a slip is the origin's reputation and whatever a same-origin script
could reach. Reading is deliberately public.

### The one boundary that matters

The reader sets exactly two things as HTML: `Paragraph.html` and list items. Both
are sanitised in `src/kagi/feed.ts`, where `HTMLRewriter` does the parsing and an
allowlist decides what is emitted — nothing reaches the output that that file did
not write. Everything else from a feed reaches the DOM through `textContent`.
**Adding a field to the reader means deciding which of those two categories it is
in.**

Three properties of `HTMLRewriter` are load-bearing, and each was established by
experiment rather than assumption: text arrives with entities *undecoded* (so
blind escaping would double-escape), attribute values likewise (so an href must
be decoded before its scheme is checked, or `&#106;avascript:` survives), and a
`<script>` body still reaches a document text handler (so its contents must be
muted, not merely dropped).

### The hazard to know about

**`stripTags` output contains live markup.** It removes tags and *then* decodes
entities, so `&lt;script&gt;` comes out as `<script>` — its result is strictly
more dangerous than its input. Every consumer routes it to `textContent` today:
`h`-block text, `Source.title`, `Source.domain`, and the word count. Promoting
any of those to `innerHTML` later would be instantly exploitable. The same goes
for `figure.alt`, `figure.caption` and `article.title`, which are stored raw
because they are only ever set as text.

### URLs are checked twice

Every URL from a feed goes through `isSafeUrl` (`http`/`https` only, decoded
first) before it is stored, and the reader checks again with `safeHref` before
assigning any `href`. Two independent checks because there was once none on
`source_url`: a feed-supplied `javascript:` link reached an `<a href>` and was one
click from executing in this origin, with only the CSP standing in the way.

Image URLs are scheme-checked for a different reason: the Worker *fetches* them
and republishes the bytes at `/img/<sha256>` as a public, immutable object, so an
unchecked value is both an arbitrary-fetch primitive and free hosting on this
domain.

### What a feed does not get to choose

| | |
| --- | --- |
| Items per feed | 60 (`MAX_ITEMS_PER_FEED`) |
| Bytes per response | 12MB (`MAX_BODY_BYTES`) |
| Characters per item body | 256K (`MAX_DESCRIPTION_CHARS`) |
| Image dimensions | 200×100 to 20000×20000 |
| Outbound request time | 45s (`FETCH_TIMEOUT_MS`) |
| Edition date | within 30 days past, 2 days future, and `YYYY-MM-DD` exactly |

The date bound is not cosmetic. It becomes an R2 key and the index sorts on it
*as a string*, so one feed claiming `Fri, 01 Jan 9999` would have pinned the
reader's front page to that edition permanently.

Parsing is also fallible: `HTMLRewriter` throws on deeply nested inline markup,
and unwrapped that throw escaped the whole build, so **one hostile item cost the
entire day's edition**. Both parse and build are wrapped per item now — a story
that will not parse is one skipped story with a warning.

### Destructive operations

`prune()` is the only code that deletes anything. It refuses to collect pictures
unless every retained edition read back successfully, refuses when no editions are
retained, and spares objects written in the last hour — which also closes the race
between a concurrent refresh's `putImage` and its `putJson`. Each of those
refusals corresponds to a way it previously deleted pictures that were still in
use.

### Headers

Set in two places on purpose: `src/index.ts` for responses the Worker generates,
and `public/_headers` for static responses that bypass the Worker entirely. The
CSP forbids `unsafe-eval`, which is strict enough that Playwright's
`wait_for_function` cannot run against the site — poll locators instead. The one
deliberate widening is `static.cloudflareinsights.com` in `script-src` and
`cloudflareinsights.com` in `connect-src`, for the analytics beacon Cloudflare
injects at the edge; it adds no trust Cloudflare does not already have, since it
terminates TLS and runs the Worker.

### Reviewed

Two independent reviews were run against the threat model above, between them
throwing 66 adversarial inputs at the sanitiser — mutation XSS, every
`javascript:` encoding they could construct, `<svg>`/`<math>` wrappers, CDATA,
comment splicing, crossed tags. It held; every confirmed finding was on a value
that never went through it, which is where to look first next time. Findings
accepted rather than fixed, with reasons, are in `docs/ROADMAP.md`.

## Provenance

The paginator, the flipbook integration, and the printed-page CSS are adapted
from a reader originally built for The Economist's weekly edition. The data
layer, the Worker, and the furniture a daily needs and a weekly does not — a
generated cover, a kicker in place of a standfirst, source apparatus — are new.

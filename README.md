# Kagi News, as a magazine

A page-turning reader for the [Kagi News](https://news.kagi.com/) daily feeds.
`fetch_kagi.py` pulls the four sections below each morning and writes a static
edition; `index.html` reads it and lays it out as printed pages you turn.

The reading order is fixed, and matches the order of the feeds:

| Section       | Feed                                    |
| ------------- | --------------------------------------- |
| World         | `https://news.kagi.com/world.xml`       |
| Science       | `https://news.kagi.com/science.xml`     |
| United States | `https://news.kagi.com/usa.xml`         |
| Boston        | `https://news.kagi.com/usa_\|_boston.xml` |

`news.kagi.com/science/latest` is the HTML page rather than a feed; `science.xml`
is the feed it points at, and is what gets fetched.

## Reading it

```sh
uv run fetch_kagi.py     # ~10 seconds; Kagi rebuilds the feeds around 08:00 ET
open index.html
```

There is no server and no build step. The reader is three classic scripts and
two stylesheets, and `data.js` is a plain global assignment, so the folder opens
straight from `file://` — which is also why it keeps working offline and will
keep working unchanged years from now.

Opening `index.html` lands on today's contents. From there:

- **Read as a magazine** — the whole edition as turnable pages
- arrow keys / `PageUp`-`PageDown` / space / click-drag a corner — turn
- **Contents** in the bottom bar, or `Esc` — back out
- **Archive** in the top bar — earlier editions

Two-page spreads appear on windows wide enough for two readable columns
(≥1100px and landscape); narrower or portrait windows get one page, which on a
phone or an iPad in portrait fits most stories whole.

## Scheduling the fetch

```sh
scripts/install-schedule.sh
```

Installs a user LaunchAgent that fetches at 08:15 local, just after Kagi
rebuilds. Logs to `logs/fetch.log`. Uninstall instructions are in the script's
header comment.

## How a feed becomes a page

A Kagi item is a cluster summary: body paragraphs, one picture, then
Highlights, Perspectives, and every outlet that carried the story — sometimes
sixty of them. Each part is treated according to what it is:

- **Body, Highlights, Perspectives** become the article: paragraphs, a
  subheading, bullets.
- **The picture** opens the story, and the lead story's picture becomes the
  cover.
- **Sources** are apparatus, not reading. In magazine mode the story closes on
  a single line of outlet names; in the scrolling view the full list is folded
  behind its count.

Feed items carry no standfirst, so the line under each headline is built from
what a cluster does have: when it happened, how long it takes to read, how many
outlets it draws on.

## Layout on disk

```
fetch_kagi.py            fetch, parse, sanitise, write
store/<date>/            the source of truth for one day
  edition.json             running order
  articles/*.json          one file per story
  report.json              what happened during that fetch
assets/<sha256>.<ext>    pictures, content-addressed, shared between days
data.js                  every stored edition — generated, never edited
index.html css/ js/      the reader
```

`data.js` is derived, so a bad fetch costs nothing: delete the dated directory
and run `uv run fetch_kagi.py --rebuild-only`.

Useful flags: `--keep N` (editions to retain, default 14; pruning also collects
unreferenced pictures), `--date YYYY-MM-DD`, `--no-images`, `--rebuild-only`.

## Security

The reader sets exactly two things as HTML: `Paragraph.html` and list items.
Both are sanitised in `fetch_kagi.py`, at the data boundary, by a parser that
emits only tags it wrote itself — `ALLOWED_INLINE`, plus `href`s restricted to
`http`/`https`. Everything else that came from a feed reaches the DOM through
`textContent`. Adding a new field to the reader means deciding which of those
two categories it is in.

## Provenance

The page-turning reader, its paginator, and the printed-page CSS are adapted
from a reader originally built for The Economist's weekly edition. What changed
here is the data layer, which is new, and the furniture that a daily needs and a
weekly does not: a generated cover, a kicker in place of a standfirst, and
source apparatus.

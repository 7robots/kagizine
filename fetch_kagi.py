#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
"""Build a daily magazine edition from the Kagi News feeds.

Kagi News (Kite) rebuilds its feeds once a day, around 08:00 US/Eastern. This
pulls the four sections we read, turns each item into the reader's article
schema, downloads the pictures, and regenerates `data.js` -- after which
`index.html` opens straight from the filesystem with no server involved.

Layout on disk:

    store/<date>/edition.json      the running order for one day
    store/<date>/articles/*.json   one file per article
    store/<date>/report.json       what happened during that fetch
    assets/<sha256>.<ext>          pictures, content-addressed and shared
    data.js                        every stored edition, for the reader

The store is the source of truth and `data.js` is derived from it, so a bad
fetch can be dropped by deleting one dated directory and re-running with
`--rebuild-only`.

Everything that reaches the reader as markup is sanitised here, at the data
boundary: `Paragraph.html` and list items are the only fields the reader sets
as HTML, so this script is the only thing standing between a feed and
innerHTML. Tags outside ALLOWED_INLINE are dropped and all text is escaped.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import html
import json
import re
import shutil
import sys
import unicodedata
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
STORE = ROOT / "store"
ASSETS = ROOT / "assets"

SCHEMA_VERSION = 1

USER_AGENT = "kagi-news-magazine/1.0 (personal RSS reader; +local)"
TIMEOUT = 45

# The reading order. `slug` is the section's identity in URLs and filenames, so
# it must not change once editions exist; `title` is only ever displayed.
#
# Note the science entry: news.kagi.com/science/latest serves the HTML page, not
# a feed. The feed for that section is science.xml, which is what the page's own
# <link rel=alternate> points at.
FEEDS = [
    {"slug": "world", "title": "World", "url": "https://news.kagi.com/world.xml"},
    {"slug": "science", "title": "Science", "url": "https://news.kagi.com/science.xml"},
    {"slug": "usa", "title": "United States", "url": "https://news.kagi.com/usa.xml"},
    {
        "slug": "boston",
        "title": "Boston",
        # The '|' in the path has to travel percent-encoded; urllib will not
        # quote it for us and the server 404s on the raw character.
        "url": "https://news.kagi.com/usa_%7C_boston.xml",
    },
]

# Inline markup we are willing to hand to innerHTML. Anything else -- including
# <br>, <div>, <span>, and every event-handler-bearing tag -- is dropped and
# only its text kept.
ALLOWED_INLINE = {"a", "em", "strong", "i", "b", "small", "sub", "sup"}


# ------------------------------------------------------------------ utilities


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def slugify(text: str, limit: int = 72) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    if len(text) > limit:
        text = text[:limit].rsplit("-", 1)[0] or text[:limit]
    return text or "untitled"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def word_count(text: str) -> int:
    return len(re.findall(r"\b[\w'’-]+\b", text))


def strip_tags(markup: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", " ", markup))


# ------------------------------------------------------------ html sanitising


class Sanitiser(HTMLParser):
    """Reduce a fragment of feed HTML to escaped text plus ALLOWED_INLINE tags.

    Built as a parser rather than a regex pass on purpose: a regex that strips
    tags cannot tell `<a href="x" onclick="...">` from `<a href="x">`, and a
    malformed tag is exactly where a stripper leaks. Here nothing is emitted
    that this class did not write itself.
    """

    # Tags whose *text* is code, not prose: dropping the tag is not enough,
    # the contents have to go too or the page shows the script as words.
    OPAQUE = {"script", "style", "template", "noscript"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.open: list[str] = []
        self.mute = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.OPAQUE:
            self.mute += 1
            return
        if tag not in ALLOWED_INLINE:
            return
        if tag == "a":
            href = dict(attrs).get("href") or ""
            if not href.lower().startswith(("http://", "https://")):
                return  # javascript:, data:, mailto:, or relative -- drop the link
            self.out.append(
                '<a href="%s" target="_blank" rel="noreferrer noopener">'
                % html.escape(href, quote=True)
            )
        else:
            self.out.append("<%s>" % tag)
        self.open.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in self.OPAQUE:
            self.mute = max(0, self.mute - 1)
            return
        if tag not in ALLOWED_INLINE or tag not in self.open:
            return
        # Close anything left dangling inside, so the fragment stays balanced.
        while self.open:
            t = self.open.pop()
            self.out.append("</%s>" % t)
            if t == tag:
                break

    def handle_startendtag(self, tag, attrs) -> None:
        if tag == "br":
            self.out.append(" ")

    def handle_data(self, data: str) -> None:
        if self.mute:
            return
        self.out.append(html.escape(data, quote=False))

    def result(self) -> str:
        out = list(self.out)
        while self.open:
            out.append("</%s>" % self.open.pop())
        text = "".join(out)
        text = re.sub(r"[ \t\r\n]+", " ", text).strip()
        return text


def sanitise(fragment: str) -> str:
    s = Sanitiser()
    s.feed(fragment)
    s.close()
    return s.result()


# ---------------------------------------------------------- description parse


class Description(HTMLParser):
    """Split one Kagi item body into its parts.

    Every item follows the same shape: summary paragraphs, one picture, then
    `<h3>`-headed lists -- Highlights, Perspectives, Sources. We keep the raw
    inner markup of each block and sanitise it afterwards, so this class only
    has to get the structure right.
    """

    BLOCK = {"p", "h3", "li"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.paragraphs: list[str] = []
        self.images: list[dict] = []
        self.groups: list[dict] = []
        self._mode: str | None = None
        self._buf: list[str] = []
        self._depth = 0

    # -- collecting ------------------------------------------------------

    def _open(self, mode: str) -> None:
        self._mode = mode
        self._buf = []
        self._depth = 0

    def _close(self) -> None:
        raw = "".join(self._buf).strip()
        mode, self._mode, self._buf = self._mode, None, []
        if not raw:
            return
        if mode == "p":
            self.paragraphs.append(raw)
        elif mode == "h3":
            title = strip_tags(raw).strip().rstrip(":").strip()
            self.groups.append({"title": title, "items": []})
        elif mode == "li":
            if not self.groups:
                self.groups.append({"title": "", "items": []})
            self.groups[-1]["items"].append(raw)

    def handle_starttag(self, tag, attrs) -> None:
        if tag == "img":
            a = dict(attrs)
            if a.get("src"):
                self.images.append({"src": a["src"], "alt": (a.get("alt") or "").strip()})
            return
        if self._mode:
            # Nested markup inside a block: keep it verbatim for the sanitiser.
            if tag == self._mode:
                self._depth += 1
            self._buf.append(self.get_starttag_text() or "")
            return
        if tag in self.BLOCK:
            self._open(tag)

    def handle_startendtag(self, tag, attrs) -> None:
        if tag == "img":
            self.handle_starttag(tag, attrs)
        elif self._mode:
            self._buf.append(self.get_starttag_text() or "")

    def handle_endtag(self, tag) -> None:
        if not self._mode:
            return
        if tag == self._mode:
            if self._depth:
                self._depth -= 1
                self._buf.append("</%s>" % tag)
            else:
                self._close()
        else:
            self._buf.append("</%s>" % tag)

    def handle_data(self, data) -> None:
        if self._mode:
            self._buf.append(data)

    def handle_entityref(self, name) -> None:
        if self._mode:
            self._buf.append("&%s;" % name)

    def handle_charref(self, name) -> None:
        if self._mode:
            self._buf.append("&#%s;" % name)

    def close(self) -> None:  # type: ignore[override]
        super().close()
        if self._mode:
            self._close()


LINK_RE = re.compile(r"<a[^>]+href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>", re.S | re.I)


def parse_sources(items: list[str]) -> list[dict]:
    """`<li><a href=...>Headline</a> - domain.com</li>` -> structured sources."""
    out, seen = [], set()
    for raw in items:
        m = LINK_RE.search(raw)
        if not m:
            continue
        url = html.unescape(m.group(1))
        if not url.lower().startswith(("http://", "https://")):
            continue
        title = strip_tags(m.group(2)).strip()
        tail = strip_tags(raw[m.end() :]).strip().lstrip("-–—").strip()
        domain = tail or re.sub(r"^www\.", "", url.split("/")[2] if "//" in url else "")
        if url in seen:
            continue
        seen.add(url)
        out.append({"title": title, "url": url, "domain": domain})
    return out


# --------------------------------------------------------------------- images


def download_image(url: str) -> dict | None:
    """Fetch a picture into the content-addressed asset store.

    Returns the asset name plus intrinsic dimensions. The dimensions matter:
    the paginator reserves each figure's box from the width/height attributes
    alone and never waits for a decode, so a figure without them measures as
    zero-height and the page count comes out wrong.
    """
    try:
        data = get(url)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
        log(f"    ! image failed: {e}")
        return None
    if len(data) < 512:
        return None

    digest = hashlib.sha256(data).hexdigest()
    try:
        import io

        with Image.open(io.BytesIO(data)) as im:
            width, height = im.size
            ext = (im.format or "JPEG").lower()
            ext = {"jpeg": "jpg", "mpo": "jpg"}.get(ext, ext)
    except Exception as e:  # not an image, or one PIL cannot read
        log(f"    ! image unreadable: {e}")
        return None

    ASSETS.mkdir(exist_ok=True)
    path = ASSETS / f"{digest}.{ext}"
    if not path.exists():
        path.write_bytes(data)
    return {"asset": path.name, "width": width, "height": height}


# -------------------------------------------------------------------- article


def build_article(item: ET.Element, section: dict, image: dict | None) -> dict:
    title = (item.findtext("title") or "Untitled").strip()
    link = (item.findtext("link") or "").strip()

    cats = [(c.text or "").strip() for c in item.findall("category")]
    # Kagi tags each item three ways: "World", "World/Wildfires", "Wildfires".
    # The middle one is the only unambiguous source for the subcategory.
    sub = next((c.split("/", 1)[1] for c in cats if "/" in c), "")

    published = None
    raw_date = item.findtext("pubDate")
    if raw_date:
        try:
            published = parsedate_to_datetime(raw_date).astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError):
            published = None

    desc = Description()
    desc.feed(item.findtext("description") or "")
    desc.close()

    blocks: list[dict] = []
    text_for_count: list[str] = []

    def add(block: dict) -> dict:
        block["id"] = "b%04d" % len(blocks)
        blocks.append(block)
        return block

    # The picture opens the article, as a magazine lead image does. `hero` lets
    # the scrolling view break the measure with it; magazine mode caps every
    # figure to its column regardless.
    if image:
        add(
            {
                "kind": "figure",
                "asset": image["asset"],
                "alt": image["alt"][:300],
                "caption": image["alt"] or None,
                "credit": None,
                "width": image["width"],
                "height": image["height"],
                "role": "hero" if image["width"] >= image["height"] * 1.4 else "half",
            }
        )

    for para in desc.paragraphs:
        clean = sanitise(para)
        if not clean:
            continue
        add({"kind": "p", "html": clean})
        text_for_count.append(strip_tags(clean))

    sources: list[dict] = []
    for group in desc.groups:
        name = group["title"]
        if name.lower().startswith("source"):
            sources = parse_sources(group["items"])
            continue  # rendered as furniture, not as body text
        items = [sanitise(i) for i in group["items"]]
        items = [i for i in items if i]
        if not items:
            continue
        if name:
            add({"kind": "h", "level": 2, "text": name})
        add({"kind": "list", "ordered": False, "items": items})
        text_for_count.extend(strip_tags(i) for i in items)

    slug = slugify(title)
    return {
        "id": f"{section['slug']}/{slug}",
        "slug": slug,
        "title": title,
        "dek": None,  # Kagi items carry no standfirst; the kicker line does that job
        "rubric": sub or section["title"],
        "section_slug": section["slug"],
        "source_url": link,
        "published": published,
        "word_count": word_count(" ".join(text_for_count)),
        "blocks": blocks,
        "sources": sources,
        "audio_asset": None,
    }


# ----------------------------------------------------------------- the fetch


def fetch_edition(date: str, feeds: list[dict], want_images: bool) -> tuple[dict, dict, dict]:
    started = datetime.now(timezone.utc)
    sections: list[dict] = []
    articles: dict[str, dict] = {}
    report: dict = {"feeds": [], "failures": [], "warnings": []}
    seen_titles: set[str] = set()

    for feed in feeds:
        log(f"  {feed['title']}: {feed['url']}")
        try:
            raw = get(feed["url"])
            channel = ET.fromstring(raw).find("channel")
            if channel is None:
                raise ValueError("no <channel> in feed")
            items = channel.findall("item")
        except Exception as e:
            log(f"    ! {e}")
            report["failures"].append({"feed": feed["slug"], "error": str(e)})
            continue

        # Every picture for this section at once: the fetch is entirely
        # network-bound and the feeds carry one image per item.
        picked: list[tuple[ET.Element, str | None, str]] = []
        for item in items:
            title = (item.findtext("title") or "").strip()
            key = slugify(title)
            if not title or key in seen_titles:
                # The same cluster can appear in two feeds (a US story in
                # World). First section in reading order keeps it.
                if title:
                    report["warnings"].append(
                        f"{feed['slug']}: skipped duplicate of '{title}'"
                    )
                continue
            seen_titles.add(key)
            d = Description()
            d.feed(item.findtext("description") or "")
            d.close()
            src = d.images[0]["src"] if d.images else None
            alt = d.images[0]["alt"] if d.images else ""
            picked.append((item, src if want_images else None, alt))

        images: dict[int, dict | None] = {}
        if any(src for _, src, _ in picked):
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                futures = {
                    pool.submit(download_image, src): i
                    for i, (_, src, _) in enumerate(picked)
                    if src
                }
                for fut in concurrent.futures.as_completed(futures):
                    images[futures[fut]] = fut.result()

        ids: list[str] = []
        for i, (item, _src, alt) in enumerate(picked):
            img = images.get(i)
            if img:
                img = dict(img, alt=alt)
            article = build_article(item, feed, img)
            if article["id"] in articles:
                article["slug"] += f"-{i}"
                article["id"] = f"{feed['slug']}/{article['slug']}"
            if article["word_count"] < 40:
                report["warnings"].append(
                    f"{article['id']}: only {article['word_count']} words; possible stub"
                )
            articles[article["id"]] = article
            ids.append(article["id"])

        if ids:
            sections.append(
                {"title": feed["title"], "slug": feed["slug"], "article_ids": ids}
            )
        report["feeds"].append(
            {
                "slug": feed["slug"],
                "url": feed["url"],
                "items": len(items),
                "kept": len(ids),
                "images": sum(1 for v in images.values() if v),
            }
        )
        log(f"    {len(ids)} articles, {sum(1 for v in images.values() if v)} pictures")

    # The cover is the lead story's picture: the first figure in reading order.
    cover = None
    for section in sections:
        for aid in section["article_ids"]:
            for block in articles[aid]["blocks"]:
                if block["kind"] == "figure":
                    cover = block["asset"]
                    break
            if cover:
                break
        if cover:
            break

    day = datetime.fromisoformat(date)
    edition = {
        "schema_version": SCHEMA_VERSION,
        "date": date,
        "title": "Kagi News, " + day.strftime("%-d %B %Y"),
        "weekday": day.strftime("%A"),
        "source_url": "https://news.kagi.com/",
        "cover_asset": cover,
        "sections": sections,
        "fetched_at": started.isoformat(timespec="seconds"),
    }
    report.update(
        {
            "edition_date": date,
            "started_at": started.isoformat(timespec="seconds"),
            "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "articles": len(articles),
            "sections": len(sections),
        }
    )
    return edition, articles, report


# ------------------------------------------------------------------- writing


def write_edition(edition: dict, articles: dict, report: dict) -> None:
    day = STORE / edition["date"]
    art_dir = day / "articles"
    if art_dir.exists():
        shutil.rmtree(art_dir)
    art_dir.mkdir(parents=True, exist_ok=True)

    for aid, article in articles.items():
        name = aid.replace("/", "__") + ".json"
        (art_dir / name).write_text(
            json.dumps(article, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    (day / "edition.json").write_text(
        json.dumps(edition, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (day / "report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (ROOT / "fetch-report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def load_stored() -> list[tuple[dict, dict]]:
    out = []
    for day in sorted(STORE.glob("*/edition.json")):
        edition = json.loads(day.read_text(encoding="utf-8"))
        articles = {}
        for f in sorted((day.parent / "articles").glob("*.json")):
            a = json.loads(f.read_text(encoding="utf-8"))
            articles[a["id"]] = a
        out.append((edition, articles))
    out.sort(key=lambda p: p[0]["date"], reverse=True)  # newest first
    return out


def rebuild_data_js() -> int:
    """Regenerate `data.js` from the store.

    A single classic script assigning one global, because the reader has to
    keep working from file:// -- where fetch() and ES modules both fail on the
    opaque origin.
    """
    stored = load_stored()
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "editions": [
            {
                "date": e["date"],
                "title": e["title"],
                "weekday": e.get("weekday"),
                "cover_asset": e.get("cover_asset"),
                "article_count": len(a),
                "section_count": len(e["sections"]),
            }
            for e, a in stored
        ],
        "byDate": {e["date"]: {"edition": e, "articles": a} for e, a in stored},
    }
    (ROOT / "data.js").write_text(
        "window.KN_DATA = " + json.dumps(payload, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    return len(stored)


def prune(keep: int) -> None:
    days = sorted((p for p in STORE.glob("*") if (p / "edition.json").exists()), reverse=True)
    for old in days[keep:]:
        log(f"  pruning {old.name}")
        shutil.rmtree(old)
    collect_assets()


def collect_assets() -> None:
    """Delete assets no stored edition refers to."""
    if not ASSETS.exists():
        return
    live = set()
    for edition, articles in load_stored():
        if edition.get("cover_asset"):
            live.add(edition["cover_asset"])
        for a in articles.values():
            for b in a["blocks"]:
                if b["kind"] == "figure":
                    live.add(b["asset"])
    removed = 0
    for f in ASSETS.iterdir():
        if f.is_file() and f.name not in live:
            f.unlink()
            removed += 1
    if removed:
        log(f"  removed {removed} unreferenced assets")


# ----------------------------------------------------------------------- cli


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--date", help="edition date (YYYY-MM-DD); default is today, local")
    ap.add_argument("--keep", type=int, default=14, help="editions to retain (default 14)")
    ap.add_argument("--no-images", action="store_true", help="skip pictures")
    ap.add_argument(
        "--rebuild-only",
        action="store_true",
        help="regenerate data.js from the store without fetching",
    )
    args = ap.parse_args()

    STORE.mkdir(exist_ok=True)

    if args.rebuild_only:
        n = rebuild_data_js()
        log(f"data.js rebuilt from {n} stored edition(s)")
        return 0

    date = args.date or datetime.now().astimezone().strftime("%Y-%m-%d")
    log(f"Kagi News, {date}")

    edition, articles, report = fetch_edition(date, FEEDS, not args.no_images)
    if not articles:
        log("no articles fetched; leaving the store untouched")
        return 1

    write_edition(edition, articles, report)
    if args.keep > 0:
        prune(args.keep)
    n = rebuild_data_js()

    log(
        f"done: {len(articles)} articles in {len(edition['sections'])} sections; "
        f"data.js holds {n} edition(s)"
    )
    if report["failures"]:
        log(f"warning: {len(report['failures'])} feed(s) failed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

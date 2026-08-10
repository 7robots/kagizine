"""Turning a Kagi News feed item into an article.

Pure functions only: no network, no filesystem, no bindings. Everything here
runs identically under CPython in the test suite and under Pyodide in the
Worker, which is the whole reason this project is written in Python on both
sides -- there is one parser, not a local one and a deployed one drifting apart.

That constraint is also why the imports are what they are. `xml.etree` and
`html.parser` are standard library and available under Pyodide; `urllib` is
not usable in a Worker (no sockets) and `PIL` has no wheel, so all I/O is
injected by the caller in build.py.

Everything that reaches the reader as markup is sanitised here, at the data
boundary. `Paragraph.html` and list items are the only fields the reader sets
as HTML, so this module is the only thing standing between a feed and
innerHTML.
"""

from __future__ import annotations

import html
import re
import unicodedata
import xml.etree.ElementTree as ET
from datetime import timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser

SCHEMA_VERSION = 1

# The reading order. `slug` is a section's identity in URLs and stored keys, so
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
        # The '|' in the path has to travel percent-encoded; the server 404s on
        # the raw character.
        "url": "https://news.kagi.com/usa_%7C_boston.xml",
    },
]

# Inline markup we are willing to hand to innerHTML. Anything else -- including
# <br>, <div>, <span>, and every event-handler-bearing tag -- is dropped and
# only its text kept.
ALLOWED_INLINE = {"a", "em", "strong", "i", "b", "small", "sub", "sup"}

#: Below this, an item is a stub rather than a story and gets flagged.
STUB_WORDS = 40


# ------------------------------------------------------------------ utilities


def slugify(text: str, limit: int = 72) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    if len(text) > limit:
        text = text[:limit].rsplit("-", 1)[0] or text[:limit]
    return text or "untitled"


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

    # Tags whose *text* is code, not prose: dropping the tag is not enough, the
    # contents have to go too or the page shows the script as words.
    OPAQUE = {"script", "style", "template", "noscript"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.open: list[str] = []
        self.mute = 0

    def handle_starttag(self, tag, attrs) -> None:
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

    def handle_endtag(self, tag) -> None:
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

    def handle_data(self, data) -> None:
        if self.mute:
            return
        self.out.append(html.escape(data, quote=False))

    def result(self) -> str:
        out = list(self.out)
        while self.open:
            out.append("</%s>" % self.open.pop())
        return re.sub(r"[ \t\r\n]+", " ", "".join(out)).strip()


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
            self.groups.append({"title": strip_tags(raw).strip().rstrip(":").strip(), "items": []})
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


def describe(markup: str) -> Description:
    d = Description()
    d.feed(markup or "")
    d.close()
    return d


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


# ------------------------------------------------------------------ the feed


def parse_channel(xml: bytes | str) -> dict:
    """One feed document -> {'built_at': str|None, 'items': [Element, ...]}."""
    root = ET.fromstring(xml)
    channel = root.find("channel")
    if channel is None:
        raise ValueError("no <channel> in feed")
    return {
        "built_at": (channel.findtext("lastBuildDate") or "").strip() or None,
        "items": channel.findall("item"),
    }


def edition_date(built_dates: list[str]) -> str | None:
    """The edition's date, taken from the feeds' own lastBuildDate.

    Deliberately not from the Worker's clock. A Worker has no tzdata, so it
    cannot ask what day it is in New York, and the answer matters: Kagi
    rebuilds at 08:00 Eastern, which is either 12:00 or 13:00 UTC depending on
    the season. The feed states when it was built, so the feed decides which
    day this is -- and a manual refresh late at night then rebuilds the same
    edition instead of opening an empty one for tomorrow.
    """
    stamps = []
    for raw in built_dates:
        if not raw:
            continue
        try:
            stamps.append(parsedate_to_datetime(raw).astimezone(timezone.utc))
        except (TypeError, ValueError):
            continue
    if not stamps:
        return None
    return max(stamps).date().isoformat()


def item_fields(item: ET.Element) -> dict:
    """The parts of an <item> we care about, as plain data."""
    cats = [(c.text or "").strip() for c in item.findall("category")]
    published = None
    raw = item.findtext("pubDate")
    if raw:
        try:
            published = parsedate_to_datetime(raw).astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError):
            published = None
    return {
        "title": (item.findtext("title") or "").strip(),
        "link": (item.findtext("link") or "").strip(),
        "description": item.findtext("description") or "",
        # Kagi tags each item three ways: "World", "World/Wildfires",
        # "Wildfires". The middle one is the only unambiguous source for the
        # subcategory.
        "subcategory": next((c.split("/", 1)[1] for c in cats if "/" in c), ""),
        "published": published,
    }


def build_article(fields: dict, section: dict, image: dict | None) -> dict:
    """One item, as the article schema the reader consumes."""
    desc = describe(fields["description"])

    blocks: list[dict] = []
    text: list[str] = []

    def add(block: dict) -> None:
        block["id"] = "b%04d" % len(blocks)
        blocks.append(block)

    # The picture opens the article, as a magazine lead image does. `hero` lets
    # the scrolling view break the measure with it; magazine mode caps every
    # figure to its column regardless.
    if image:
        alt = (image.get("alt") or "")[:300]
        add(
            {
                "kind": "figure",
                "asset": image["asset"],
                "alt": alt,
                "caption": alt or None,
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
        text.append(strip_tags(clean))

    sources: list[dict] = []
    for group in desc.groups:
        name = group["title"]
        if name.lower().startswith("source"):
            sources = parse_sources(group["items"])
            continue  # rendered as furniture, not as body text
        items = [i for i in (sanitise(x) for x in group["items"]) if i]
        if not items:
            continue
        if name:
            add({"kind": "h", "level": 2, "text": name})
        add({"kind": "list", "ordered": False, "items": items})
        text.extend(strip_tags(i) for i in items)

    slug = slugify(fields["title"])
    return {
        "id": "%s/%s" % (section["slug"], slug),
        "slug": slug,
        "title": fields["title"],
        "dek": None,  # Kagi items carry no standfirst; the kicker line does that job
        "rubric": fields["subcategory"] or section["title"],
        "section_slug": section["slug"],
        "source_url": fields["link"],
        "published": fields["published"],
        "word_count": word_count(" ".join(text)),
        "blocks": blocks,
        "sources": sources,
        "audio_asset": None,
    }


def lead_image_url(description: str) -> tuple[str | None, str]:
    """The item's picture, as (url, alt). Feeds carry at most one."""
    d = describe(description)
    if not d.images:
        return None, ""
    return d.images[0]["src"], d.images[0]["alt"]


def choose_cover(sections: list[dict], articles: dict) -> str | None:
    """The lead story's picture: the first figure in reading order."""
    for section in sections:
        for aid in section["article_ids"]:
            for block in articles[aid]["blocks"]:
                if block["kind"] == "figure":
                    return block["asset"]
    return None


def edition_title(date: str) -> str:
    """'Kagi News, 10 August 2026' without needing a locale or strftime %-d."""
    year, month, day = (int(p) for p in date.split("-"))
    months = (
        "January February March April May June July "
        "August September October November December"
    ).split()
    return "Kagi News, %d %s %d" % (day, months[month - 1], year)


def weekday(date: str) -> str:
    """Weekday name for a date, by Zeller's congruence.

    `datetime.strftime('%A')` would be locale-dependent and, under Pyodide,
    depends on locale data that may not be present. The arithmetic is three
    lines and cannot be surprised.
    """
    y, m, d = (int(p) for p in date.split("-"))
    if m < 3:
        m += 12
        y -= 1

    k, j = y % 100, y // 100
    h = (d + (13 * (m + 1)) // 5 + k + k // 4 + j // 4 + 5 * j) % 7
    return ("Saturday Sunday Monday Tuesday Wednesday Thursday Friday").split()[h]

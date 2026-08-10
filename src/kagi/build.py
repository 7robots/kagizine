"""Assembling one day's edition.

The only module that sequences work, and still does no I/O of its own: the
caller injects `fetch_bytes` and `put_image`. In the Worker those wrap the
runtime's fetch and an R2 binding; in the tests they are dictionaries. That
split is what lets the whole pipeline be exercised without a network or a
Cloudflare account.
"""

from __future__ import annotations

import asyncio
import hashlib
import time

from kagi import feed as F
from kagi import images as I

#: Concurrent subrequests. A Worker caps simultaneous outbound connections, and
#: an edition wants ~35 of them; six at a time finishes in about the same
#: wall-clock as firing them all and cannot trip the limit.
CONCURRENCY = 6

#: The smallest thing we are willing to call a lead picture.
#:
#: A size floor in *bytes* was the obvious guard and the wrong one: it rejects a
#: small but legitimate graphic while happily accepting a 1x1 spacer that
#: happens to be padded. Dimensions say what we actually mean -- this has to
#: work as the picture at the top of a story, and as the cover.
MIN_WIDTH = 200
MIN_HEIGHT = 100

#: Below this there is not even a header to read, so it is certainly not an image.
MIN_BYTES = 64


class Unchanged(Exception):
    """The feeds have not been rebuilt since the stored edition was made.

    Raised before any picture is fetched, which is the point of it: the cron
    fires twice a day to cover the Eastern-time DST shift, and the firing that
    finds nothing new should cost four requests, not thirty-five.
    """

    def __init__(self, date: str, built_from: str):
        super().__init__("edition %s already built from %s" % (date, built_from))
        self.date = date
        self.built_from = built_from


async def gather_limited(factories, limit: int = CONCURRENCY) -> list:
    """Run coroutine factories `limit` at a time, preserving input order.

    Takes factories rather than coroutines so nothing is started until a slot
    is free -- a coroutine created and left waiting is a warning at best and a
    dropped request at worst.
    """
    results: list = [None] * len(factories)
    if not factories:
        return results

    pending = list(enumerate(factories))
    pending.reverse()  # pop() from the end, so work starts at index 0

    async def worker():
        while pending:
            index, make = pending.pop()
            try:
                results[index] = await make()
            except Exception as e:  # one failure must not sink the edition
                results[index] = e

    await asyncio.gather(*[worker() for _ in range(min(limit, len(factories)))])
    return results


async def build_edition(fetch_bytes, put_image, feeds=None, is_current=None):
    """Fetch the feeds and return (edition, articles, report).

    `fetch_bytes(url)`  -> awaitable of (bytes, content_type|None)
    `put_image(key, data, content_type)` -> awaitable
    `is_current(date, built_from)` -> awaitable of bool; consulted as soon as
        the feeds have been parsed and before any picture is fetched, so an
        already-current edition costs four requests. Raises `Unchanged`.
    """
    feeds = feeds or F.FEEDS
    report: dict = {"feeds": [], "failures": [], "warnings": []}
    clock = time.monotonic()

    # --- the feeds themselves, all at once -------------------------------
    raw = await gather_limited([_fetcher(fetch_bytes, f["url"]) for f in feeds])

    channels: list[dict | None] = []
    for spec, result in zip(feeds, raw):
        if isinstance(result, Exception):
            report["failures"].append({"feed": spec["slug"], "error": str(result)})
            channels.append(None)
            continue
        try:
            channels.append(F.parse_channel(result[0]))
        except Exception as e:
            report["failures"].append({"feed": spec["slug"], "error": str(e)})
            channels.append(None)

    date = F.edition_date([c["built_at"] for c in channels if c])
    if not date:
        raise ValueError("no feed reported a lastBuildDate; refusing to guess the date")

    built_from = max((c["built_at"] or "" for c in channels if c), default="")
    report["feeds_seconds"] = round(time.monotonic() - clock, 2)

    # Nothing new upstream: stop here, before the expensive half.
    if is_current is not None and await is_current(date, built_from):
        raise Unchanged(date, built_from)

    # --- pick the items, in reading order --------------------------------
    picked: list[dict] = []
    seen: set[str] = set()

    for spec, channel in zip(feeds, channels):
        if not channel:
            continue
        kept = 0
        for item in channel["items"]:
            fields = F.item_fields(item)
            key = F.slugify(fields["title"])
            if not fields["title"]:
                continue
            if key in seen:
                # The same cluster can appear in two feeds (a US story in
                # World). First section in reading order keeps it.
                report["warnings"].append(
                    "%s: skipped duplicate of '%s'" % (spec["slug"], fields["title"])
                )
                continue
            seen.add(key)
            url, alt = F.lead_image_url(fields["description"])
            picked.append({"fields": fields, "section": spec, "image_url": url, "alt": alt})
            kept += 1
        report["feeds"].append(
            {
                "slug": spec["slug"],
                "url": spec["url"],
                "built_at": channel["built_at"],
                "items": len(channel["items"]),
                "kept": kept,
            }
        )

    if not picked:
        raise ValueError("every feed failed or was empty")

    # --- the pictures ----------------------------------------------------
    clock = time.monotonic()
    wanted = [p for p in picked if p["image_url"]]
    stored = await gather_limited(
        [_image_fetcher(fetch_bytes, put_image, p["image_url"]) for p in wanted]
    )
    for p, result in zip(wanted, stored):
        if isinstance(result, Exception) or result is None:
            report["warnings"].append(
                "%s: picture unavailable (%s)"
                % (p["fields"]["title"], result if result else "unreadable")
            )
            p["image"] = None
        else:
            p["image"] = dict(result, alt=p["alt"])

    report["images_seconds"] = round(time.monotonic() - clock, 2)

    # --- articles and sections ------------------------------------------
    clock = time.monotonic()
    articles: dict[str, dict] = {}
    sections: list[dict] = []
    order = {f["slug"]: n for n, f in enumerate(feeds)}

    for p in picked:
        article = F.build_article(p["fields"], p["section"], p.get("image"))
        if article["id"] in articles:  # same headline twice inside one section
            article["slug"] += "-%d" % len(articles)
            article["id"] = "%s/%s" % (p["section"]["slug"], article["slug"])
        if article["word_count"] < F.STUB_WORDS:
            report["warnings"].append(
                "%s: only %d words; possible stub" % (article["id"], article["word_count"])
            )
        articles[article["id"]] = article

        block = next((s for s in sections if s["slug"] == p["section"]["slug"]), None)
        if not block:
            block = {
                "title": p["section"]["title"],
                "slug": p["section"]["slug"],
                "article_ids": [],
            }
            sections.append(block)
        block["article_ids"].append(article["id"])

    sections.sort(key=lambda s: order.get(s["slug"], 99))

    edition = {
        "schema_version": F.SCHEMA_VERSION,
        "date": date,
        "title": F.edition_title(date),
        "weekday": F.weekday(date),
        "source_url": "https://news.kagi.com/",
        "cover_asset": F.choose_cover(sections, articles),
        "sections": sections,
        # What the feeds said when this was built. The refresh compares against
        # it to know whether there is anything new, which is what makes the two
        # daily cron firings idempotent.
        "built_from": built_from,
    }
    report.update(
        {
            "edition_date": date,
            "articles": len(articles),
            "sections": len(sections),
            "pictures": sum(1 for p in picked if p.get("image")),
            # Recorded because this runs unattended: a refresh that starts
            # creeping towards the CPU limit should be visible in the stored
            # report rather than discovered when it first fails.
            "articles_seconds": round(time.monotonic() - clock, 2),
        }
    )
    return edition, articles, report


# ------------------------------------------------------------------ fetchers


def _fetcher(fetch_bytes, url):
    async def run():
        return await fetch_bytes(url)

    return run


def _image_fetcher(fetch_bytes, put_image, url):
    """Fetch one picture, store it under its content hash, return its metadata.

    Content-addressed so the same photograph appearing in two sections -- or on
    two days -- is stored once, and so a stored object never has to be
    invalidated: the key changes when the bytes do, which is what lets the
    Worker serve pictures as immutable.
    """

    async def run():
        data, _ = await fetch_bytes(url)
        if not data or len(data) < MIN_BYTES:
            return None
        mime = I.content_type(data)
        size = I.dimensions(data)
        if not mime or not size:
            return None  # not an image, or a format we cannot measure
        if size[0] < MIN_WIDTH or size[1] < MIN_HEIGHT:
            return None  # a spacer or an icon, not a photograph
        key = "%s.%s" % (hashlib.sha256(data).hexdigest(), I.extension(mime))
        await put_image(key, data, mime)
        return {"asset": key, "width": size[0], "height": size[1]}

    return run

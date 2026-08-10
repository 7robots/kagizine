"""The R2 layer.

The only module that touches a binding, and the only one that has to think
about the Python/JavaScript boundary. Keeping that boundary in one file is
deliberate: `to_js` conversions and JS array iteration are the two things most
likely to behave differently from plain Python, so they do not get to leak into
the parser or the build.

Layout in the bucket:

    index.json            every stored edition, newest first
    editions/<date>.json  one day: {"edition": {...}, "articles": {...}}
    reports/<date>.json   what the refresh did, for reading after the fact
    img/<sha256>.<ext>    pictures, content-addressed

The bucket is the source of truth. `index.json` is derived from it and can be
rebuilt by listing `editions/`.
"""

from __future__ import annotations

import json

from js import Object
from pyodide.ffi import to_js

INDEX_KEY = "index.json"

#: Editions retained before pruning. Two weeks is enough to catch up after a
#: holiday without the bucket growing without bound.
KEEP_EDITIONS = 14


def _opts(value: dict):
    """A Python dict as the JS options object an R2 method expects."""
    return to_js(value, dict_converter=Object.fromEntries)


def edition_key(date: str) -> str:
    return "editions/%s.json" % date


def report_key(date: str) -> str:
    return "reports/%s.json" % date


def image_key(asset: str) -> str:
    return "img/%s" % asset


# ------------------------------------------------------------------- writing


async def put_json(bucket, key: str, value) -> None:
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    await bucket.put(
        key,
        body,
        _opts({"httpMetadata": {"contentType": "application/json; charset=utf-8"}}),
    )


async def put_image(bucket, asset: str, data: bytes, mime: str) -> None:
    """Store a picture, skipping the write if those exact bytes are already there.

    Keys are content hashes, so an object that exists is by definition the same
    picture -- and most days repeat at least a few. `head` is far cheaper than
    re-uploading half a megabyte.
    """
    key = image_key(asset)
    if await bucket.head(key) is not None:
        return
    await bucket.put(
        key,
        to_js(data),
        _opts(
            {
                "httpMetadata": {
                    "contentType": mime,
                    # Content-addressed, so a stored object never changes and the
                    # header can say so. This is what the served response echoes.
                    "cacheControl": "public, max-age=31536000, immutable",
                }
            }
        ),
    )


# ------------------------------------------------------------------- reading


async def get_text(bucket, key: str) -> str | None:
    obj = await bucket.get(key)
    if obj is None:
        return None
    return await obj.text()


async def get_json(bucket, key: str):
    text = await get_text(bucket, key)
    return json.loads(text) if text else None


async def get_object(bucket, key: str):
    """The R2 object itself, for serving its body without reading it.

    Deliberately not `await obj.arrayBuffer()`: Pyodide converts an ArrayBuffer
    into a Python memoryview on the way across, which both copies the whole
    picture into the interpreter and is a type `Response` refuses. Handing the
    object's `body` stream to a JS Response instead means the bytes go from R2
    to the client without Python touching them.
    """
    return await bucket.get(key)


def content_type_of(obj) -> str:
    meta = getattr(obj, "httpMetadata", None)
    if meta is not None and getattr(meta, "contentType", None):
        return meta.contentType
    return "application/octet-stream"


# --------------------------------------------------------------------- index


async def read_index(bucket) -> dict:
    return (await get_json(bucket, INDEX_KEY)) or {"editions": []}


def index_entry(edition: dict, article_count: int) -> dict:
    return {
        "date": edition["date"],
        "title": edition["title"],
        "weekday": edition.get("weekday"),
        "cover_asset": edition.get("cover_asset"),
        "article_count": article_count,
        "section_count": len(edition["sections"]),
    }


async def write_index(bucket, entries: list[dict], generated_at: str) -> None:
    entries = sorted(entries, key=lambda e: e["date"], reverse=True)
    await put_json(bucket, INDEX_KEY, {"generated_at": generated_at, "editions": entries})


async def upsert_index(bucket, edition: dict, article_count: int, generated_at: str) -> list[dict]:
    """Add or replace one edition in the index, newest first."""
    index = await read_index(bucket)
    entries = [e for e in index.get("editions", []) if e["date"] != edition["date"]]
    entries.append(index_entry(edition, article_count))
    entries.sort(key=lambda e: e["date"], reverse=True)
    await write_index(bucket, entries, generated_at)
    return entries


# ------------------------------------------------------------------- pruning


async def list_keys(bucket, prefix: str) -> list[str]:
    """Every key under a prefix, following R2's pagination.

    R2 truncates a listing at 1000 objects and hands back a cursor. Ignoring
    that is the bug that makes a collector delete pictures it merely failed to
    see, so the loop is not optional.
    """
    keys: list[str] = []
    cursor = None
    while True:
        options = {"prefix": prefix, "limit": 1000}
        if cursor:
            options["cursor"] = cursor
        listing = await bucket.list(_opts(options))
        for obj in listing.objects:
            keys.append(obj.key)
        if not listing.truncated:
            return keys
        cursor = listing.cursor


async def delete_keys(bucket, keys: list[str]) -> None:
    # R2's delete takes up to 1000 keys at a time.
    for i in range(0, len(keys), 1000):
        await bucket.delete(to_js(keys[i : i + 1000]))


async def prune(bucket, keep: int = KEEP_EDITIONS, generated_at: str = "") -> dict:
    """Drop editions past the retention window, then collect orphaned pictures.

    Order matters: the surviving editions are what define which pictures are
    still referenced, so the index has to be trimmed before anything is
    collected.
    """
    index = await read_index(bucket)
    entries = sorted(index.get("editions", []), key=lambda e: e["date"], reverse=True)
    keeping, dropping = entries[:keep], entries[keep:]

    for entry in dropping:
        await delete_keys(bucket, [edition_key(entry["date"]), report_key(entry["date"])])

    if dropping and generated_at:
        await write_index(bucket, keeping, generated_at)

    # Which pictures are still spoken for.
    live: set[str] = set()
    for entry in keeping:
        day = await get_json(bucket, edition_key(entry["date"]))
        if not day:
            continue
        if day["edition"].get("cover_asset"):
            live.add(image_key(day["edition"]["cover_asset"]))
        for article in day["articles"].values():
            for block in article["blocks"]:
                if block["kind"] == "figure":
                    live.add(image_key(block["asset"]))

    orphans = [k for k in await list_keys(bucket, "img/") if k not in live]
    await delete_keys(bucket, orphans)
    return {
        "editions_removed": [e["date"] for e in dropping],
        "images_removed": len(orphans),
    }

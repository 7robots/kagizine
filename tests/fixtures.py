"""Synthetic feed documents.

Written by hand rather than captured from Kagi, for two reasons: the repo stays
free of third-party article text, and a fixture can carry the cases real feeds
happen not to contain today -- a hostile href, a script tag, an item with no
picture, the same headline in two sections.
"""

from __future__ import annotations

import struct
import zlib


def channel(title: str, built: str, items: str) -> bytes:
    return (
        """<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:atom="http://www.w3.org/2005/Atom" version="2.0">
  <channel>
    <title>Kagi News - %s</title>
    <link>https://kite.kagi.com/x.xml</link>
    <lastBuildDate>%s</lastBuildDate>
    %s
  </channel>
</rss>"""
        % (title, built, items)
    ).encode()


def item(
    title: str,
    *,
    section: str = "World",
    sub: str = "Wildfires",
    pub: str = "Sun, 09 Aug 2026 17:13:45 +0000",
    body: str = "<p>First paragraph.</p><p>Second paragraph.</p>",
    image: str | None = "https://img.example/one.png",
    extras: str = "",
) -> str:
    img = (
        "&lt;img src='%s' alt='A caption for the picture.' /&gt;&lt;br /&gt;" % image
        if image
        else ""
    )
    escaped = body.replace("<", "&lt;").replace(">", "&gt;")
    return """
    <item>
      <title>%s</title>
      <link>https://kite.kagi.com/%s/1/x</link>
      <description>%s%s%s</description>
      <guid isPermaLink="true">https://kite.kagi.com/%s/1/x</guid>
      <category>%s</category>
      <category>%s/%s</category>
      <category>%s</category>
      <pubDate>%s</pubDate>
    </item>""" % (
        title,
        section.lower(),
        escaped,
        img,
        extras,
        section.lower(),
        section,
        section,
        sub,
        sub,
        pub,
    )


HIGHLIGHTS = (
    "&lt;h3&gt;Highlights:&lt;/h3&gt;&lt;ul&gt;"
    "&lt;li&gt;One thing that happened.&lt;/li&gt;"
    "&lt;li&gt;Another thing that happened.&lt;/li&gt;&lt;/ul&gt;"
)

PERSPECTIVES = (
    "&lt;h3&gt;Perspectives:&lt;/h3&gt;&lt;ul&gt;"
    "&lt;li&gt;A named official: said something. "
    "(&lt;a href='https://outlet.example/a'&gt;Outlet&lt;/a&gt;)&lt;/li&gt;&lt;/ul&gt;"
)

SOURCES = (
    "&lt;h3&gt;Sources:&lt;/h3&gt;&lt;ul&gt;"
    "&lt;li&gt;&lt;a href='https://one.example/a'&gt;Headline one&lt;/a&gt; - one.example&lt;/li&gt;"
    "&lt;li&gt;&lt;a href='https://two.example/b'&gt;Headline two&lt;/a&gt; - two.example&lt;/li&gt;"
    "&lt;li&gt;&lt;a href='https://one.example/a'&gt;Headline one again&lt;/a&gt; - one.example&lt;/li&gt;"
    "&lt;/ul&gt;"
)

FULL_BODY_EXTRAS = HIGHLIGHTS + PERSPECTIVES + SOURCES


# ------------------------------------------------------------------- images


def png(width: int, height: int) -> bytes:
    """A real, decodable single-colour PNG of the given size."""

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    rows = b"".join(b"\x00" + b"\x7f\x7f\x7f" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def jpeg(width: int, height: int, *, progressive: bool = False) -> bytes:
    """Enough of a JPEG for a header reader: APP0, then an SOF carrying the size.

    The progressive variant also inserts 0xFF fill bytes before the marker,
    which is the case a scanner that skips only one 0xFF gets wrong.
    """
    sof = b"\xff\xc2" if progressive else b"\xff\xc0"
    fill = b"\xff\xff" if progressive else b""
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x01\x01\x00" + b"\x00\x01" * 2 + b"\x00\x00"
    frame = sof + struct.pack(">HBHHB", 11, 8, height, width, 1) + b"\x01\x11\x00"
    return b"\xff\xd8" + app0 + fill + frame + b"\xff\xda\x00\x08\x01\x01\x00\x00?\x00" + b"\xff\xd9"


def gif(width: int, height: int) -> bytes:
    return b"GIF89a" + struct.pack("<HH", width, height) + b"\x80\x00\x00"


def webp_vp8x(width: int, height: int) -> bytes:
    body = (
        b"VP8X"
        + struct.pack("<I", 10)
        + b"\x00\x00\x00\x00"
        + (width - 1).to_bytes(3, "little")
        + (height - 1).to_bytes(3, "little")
    )
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


def webp_vp8l(width: int, height: int) -> bytes:
    bits = (width - 1) | ((height - 1) << 14)
    body = b"VP8L" + struct.pack("<I", 5) + b"\x2f" + struct.pack("<I", bits)
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body

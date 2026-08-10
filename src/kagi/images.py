"""Intrinsic image dimensions, read from the file header.

Pillow is not available to a Python Worker -- there is no PyEmscripten wheel
for it and the Worker has no filesystem to decode into. That is not a real loss
here, because nothing in this project needs to *decode* a picture: it needs the
width and height so the reader can reserve the right box.

Those dimensions are load-bearing rather than decorative. The paginator
measures a figure from its width/height attributes and never waits for a
decode, so a figure that arrives without them measures as zero-height, the
column count comes out wrong, and pages end up with text painted over
pictures. See the comment in js/paginator.js.

Every reader below is a few dozen bytes of header parsing and no allocation of
the pixel data.
"""

from __future__ import annotations

import struct

#: Longest header prefix any sniffer needs. JPEG is the exception -- its SOF
#: marker can sit arbitrarily deep -- so `dimensions` gets the whole buffer.
MAGIC_BYTES = 32


def content_type(data: bytes) -> str | None:
    """Sniff the format from magic bytes.

    Deliberately not trusting the response's Content-Type: the image proxy in
    front of these feeds has been seen to serve a PNG as image/jpeg, and the
    stored extension has to match the actual bytes or browsers sniff-block it.
    """
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
}


def extension(mime: str | None) -> str:
    return EXTENSIONS.get(mime or "", "bin")


def dimensions(data: bytes) -> tuple[int, int] | None:
    """(width, height), or None if the header cannot be read."""
    mime = content_type(data)
    if mime == "image/jpeg":
        return _jpeg(data)
    if mime == "image/png":
        return _png(data)
    if mime == "image/gif":
        return _gif(data)
    if mime == "image/webp":
        return _webp(data)
    return None


# ---------------------------------------------------------------------- jpeg

# Start-of-frame markers, which are the only ones carrying the frame size.
# C4 (huffman table), C8 (reserved) and CC (arithmetic conditioning) sit inside
# this numeric range but are not SOF markers, hence the explicit set.
_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}

# Markers that stand alone: no length field follows, so the scan must not try
# to skip a segment for them. TEM plus RST0-RST7.
_STANDALONE = {0x01} | set(range(0xD0, 0xD8))


def _jpeg(data: bytes) -> tuple[int, int] | None:
    i, n = 2, len(data)
    while i < n:
        # Markers are 0xFF followed by a type byte, but any number of 0xFF fill
        # bytes may precede the type -- skipping only one is the classic bug
        # that makes a scan miss the frame on progressive JPEGs.
        if data[i] != 0xFF:
            i += 1
            continue
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            return None
        marker = data[i]
        i += 1

        if marker in _STANDALONE or marker == 0xD8:
            continue
        if marker == 0xD9 or marker == 0xDA:
            return None  # end of image, or start of scan: no frame header found
        if i + 2 > n:
            return None
        (length,) = struct.unpack(">H", data[i : i + 2])
        if marker in _SOF:
            # length, precision(1), height(2), width(2)
            if i + 7 > n:
                return None
            height, width = struct.unpack(">HH", data[i + 3 : i + 7])
            return (width, height) if width and height else None
        i += length
    return None


# ----------------------------------------------------------------- png / gif


def _png(data: bytes) -> tuple[int, int] | None:
    # The first chunk of a PNG must be IHDR, whose payload opens with the size.
    if len(data) < 24 or data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return (width, height) if width and height else None


def _gif(data: bytes) -> tuple[int, int] | None:
    if len(data) < 10:
        return None
    width, height = struct.unpack("<HH", data[6:10])
    return (width, height) if width and height else None


# ---------------------------------------------------------------------- webp


def _webp(data: bytes) -> tuple[int, int] | None:
    if len(data) < 16:
        return None
    kind = data[12:16]

    if kind == b"VP8X":  # extended: carries an explicit canvas size
        if len(data) < 30:
            return None
        w = int.from_bytes(data[24:27], "little") + 1
        h = int.from_bytes(data[27:30], "little") + 1
        return (w, h)

    if kind == b"VP8 ":  # lossy
        if len(data) < 30:
            return None
        # 3-byte frame tag, then the 3-byte keyframe sync code, then the size
        # as two 16-bit values whose top two bits are the scaling hint.
        if data[23:26] != b"\x9d\x01\x2a":
            return None
        w, h = struct.unpack("<HH", data[26:30])
        return (w & 0x3FFF, h & 0x3FFF)

    if kind == b"VP8L":  # lossless
        if len(data) < 25 or data[20] != 0x2F:
            return None
        (bits,) = struct.unpack("<I", data[21:25])
        return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)

    return None
